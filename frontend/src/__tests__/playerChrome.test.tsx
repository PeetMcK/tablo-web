import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

/** The fading chrome layer, and the surface the cursor rule lands on. */
const chrome = (c: HTMLElement) => c.querySelector<HTMLElement>(".transition-opacity")!;
const surface = (c: HTMLElement) => c.firstElementChild as HTMLElement;
/** The transport cluster — the region a resting cursor should hold open. */
const transport = (c: HTMLElement) =>
  c.querySelector<HTMLElement>(".flex.flex-col.gap-3.pointer-events-auto")!;

describe("the player's chrome", () => {
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

  it("holds the controls up while the cursor rests on the transport", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());

      fireEvent.mouseOver(transport(container));
      // Long past the point they would otherwise have faded.
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(chrome(container).className).toContain("opacity-100");

      // Leaving starts the clock again.
      fireEvent.mouseOut(transport(container));
      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(chrome(container).className).toContain("opacity-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fades when the cursor is out over the picture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());

      fireEvent.mouseMove(surface(container));
      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(chrome(container).className).toContain("opacity-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the cursor away with the bar, and gives it back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());
      expect(surface(container).className).not.toContain("cursor-none");

      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(surface(container).className).toContain("cursor-none");

      fireEvent.mouseMove(surface(container));
      await act(async () => {});
      expect(surface(container).className).not.toContain("cursor-none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fullscreens the player, not the bare video element", async () => {
    // Fullscreening the <video> hands the browser's own controls to the
    // viewer and leaves our timeline — cache bands, thumbnail scrubbing,
    // skip buttons — outside the fullscreen element entirely.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    const onVideo = vi.fn();
    const onRoot = vi.fn();
    const video = container.querySelector("video")!;
    video.requestFullscreen = onVideo;
    surface(container).requestFullscreen = onRoot;

    fireEvent.click(screen.getByTitle(/fullscreen/i));

    expect(onRoot).toHaveBeenCalledTimes(1);
    expect(onVideo).not.toHaveBeenCalled();
  });
});
