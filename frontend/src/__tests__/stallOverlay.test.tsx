import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom ships no Media Source Extensions, so the real hls.js reports itself
// unsupported and the player raises a fatal error — which hides the overlay
// outright and would let every assertion below pass without proving anything.
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

const startedAt = new Date(Date.now() - 15 * 60 * 1000);
const NEWS_HOUR: Program = {
  title: "PBS News Hour", description: null,
  start: startedAt.toISOString(), duration: 3600,
};

/** jsdom has no media stack, so the DVR window has to be described by hand. */
function stubSeekable(end: number) {
  Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
    configurable: true,
    get: () => ({ length: 1, start: () => 0, end: () => end }),
  });
}

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

async function mounted() {
  const { container } = renderLive();
  const video = container.querySelector("video")!;
  await waitFor(() => expect(api.startStream).toHaveBeenCalled());
  // The startup sheet suppresses the stall overlay outright, so a test that
  // asserts the overlay is absent proves nothing until this has cleared.
  await waitFor(() => expect(screen.queryByText("Starting stream…")).toBeNull());
  fireEvent(video, new Event("timeupdate"));
  return video;
}

/** The overlay's own words, either of the two it can say. */
const overlay = () => screen.queryByText(/Transcoding|Buffering/);

describe("the transcoding overlay", () => {
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
    stubSeekable(900);
  });

  afterEach(() => vi.restoreAllMocks());

  it("stays down for a skip that lands warm", async () => {
    // What a 10-second skip into buffered media actually looks like: the
    // element announces the seek, reports a moment of not-enough-data, and is
    // playing again a millisecond later. Nothing here is a transcode, and
    // strobing the overlay on every press of the button is what it looked like.
    const video = await mounted();

    fireEvent(video, new Event("seeking"));
    fireEvent(video, new Event("waiting"));
    expect(overlay()).toBeNull();

    fireEvent(video, new Event("seeked"));
    fireEvent(video, new Event("playing"));
    expect(overlay()).toBeNull();
  });

  it("stays down through a hitch too short to be worth announcing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const video = await mounted();
      fireEvent(video, new Event("waiting"));
      await act(async () => { vi.advanceTimersByTime(800); });
      expect(overlay()).toBeNull();

      fireEvent(video, new Event("playing"));
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(overlay()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("comes up for a wait that genuinely is one", async () => {
    // Scrubbing into a window nobody has encoded blocks for seconds. That is
    // the case the overlay exists for, and it still has to appear.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const video = await mounted();
      fireEvent(video, new Event("waiting"));
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(overlay()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls the wait buffering, whatever is doing the waiting", async () => {
    // A live channel is transcoding by definition, which is exactly the case
    // that used to read "Transcoding". The distinction is ours, not the
    // viewer's.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const video = await mounted();
      fireEvent(video, new Event("waiting"));
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(screen.getByText("Buffering")).toBeInTheDocument();
      expect(screen.queryByText("Transcoding")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
