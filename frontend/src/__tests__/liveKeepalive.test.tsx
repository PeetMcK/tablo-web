import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom ships no Media Source Extensions, so the real hls.js reports itself
// unsupported and the player never leaves its startup sheet — where it polls
// on a one-second timer anyway, which would let every assertion below pass
// without the heartbeat existing at all.
vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported() { return true; }
    static Events = {
      MANIFEST_PARSED: "hlsManifestParsed", LEVEL_LOADED: "hlsLevelLoaded",
      FRAG_LOADING: "hlsFragLoading", FRAG_LOADED: "hlsFragLoaded",
      BUFFER_APPENDED: "hlsBufferAppended", ERROR: "hlsError",
    };
    media: HTMLMediaElement | null = null;
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
  }
  return { default: FakeHls };
});

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import type { Channel, Program } from "../api/tablo";

const CHANNEL: Channel = {
  identifier: "S84522_007_02", call_sign: "K08PRD2", major: 7, minor: 2,
  network: "WORLD", kind: "ota", display_name: "7.2 K08PRD2",
};
const NEWS_HOUR: Program = {
  title: "PBS News Hour", description: null,
  start: new Date(Date.now() - 15 * 60 * 1000).toISOString(), duration: 3600,
};

function renderLive() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer
        source={{ kind: "live", channel: CHANNEL, program: NEWS_HOUR }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

async function playing() {
  const { container } = renderLive();
  const video = container.querySelector("video")!;
  await waitFor(() => expect(api.startStream).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("Starting stream…")).toBeNull());
  fireEvent(video, new Event("timeupdate"));
  fireEvent(video, new Event("playing"));
  return video;
}

/**
 * The backend kills a live transcode nobody has asked about, because the tuner
 * it holds is a real resource and a closed laptop sends no goodbye. What it
 * measures is these calls: segment fetches alone would have it kill a session
 * that is merely paused, which goes on fetching nothing at all.
 */
describe("a live session tells the backend it is still wanted", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "abc", proxy_url: "/api/hls/abc/playlist.m3u8",
      stream_url: "/api/transcoded/abc/playlist.m3u8", transcoded: true,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "transcodeStatus").mockResolvedValue({
      status: "active", encoded_seconds: 900,
    });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS_HOUR] });
    Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 900 }),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("goes on saying so while the picture plays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await playing();
      vi.mocked(api.transcodeStatus).mockClear();

      await act(async () => { vi.advanceTimersByTime(31_000); });

      expect(api.transcodeStatus).toHaveBeenCalledWith("abc");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes on saying so while it is paused", async () => {
    // The case that makes fetches the wrong signal: a player paused on live
    // fills its buffer, stops asking for segments, and is still being watched.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const video = await playing();
      fireEvent(video, new Event("pause"));
      vi.mocked(api.transcodeStatus).mockClear();

      await act(async () => { vi.advanceTimersByTime(31_000); });

      expect(api.transcodeStatus).toHaveBeenCalledWith("abc");
    } finally {
      vi.useRealTimers();
    }
  });
});
