import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

/**
 * Carrying the picture to another window pauses it — the spec queues a pause
 * when a media element leaves a document, and a move is a removal followed by
 * an insertion. Playback has to be put back on the other side.
 */
describe("popping out while playing", () => {
  let play: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "abc", proxy_url: "/a", stream_url: "/b", transcoded: true,
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
    (window as unknown as Record<string, unknown>).documentPictureInPicture = {
      requestWindow: vi.fn(),
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
  });

  /** Pretend the element is playing, the way a real one would be. */
  function stubPaused(paused: boolean) {
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true, get: () => paused,
    });
  }

  function fakePipWindow() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const pipDoc = frame.contentDocument!;
    const w = {
      document: pipDoc,
      close: vi.fn(),
      addEventListener: vi.fn(),
    } as unknown as Window;
    const requestWindow = vi.fn().mockResolvedValue(w);
    (window as unknown as Record<string, unknown>).documentPictureInPicture = { requestWindow };
    return { pipDoc, requestWindow, close: w.close };
  }

  it("carries on playing into the pop-out", async () => {
    stubPaused(false);
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc } = fakePipWindow();
    const video = container.querySelector("video")!;
    play.mockClear();

    fireEvent.click(screen.getByTitle("Picture in picture"));
    await waitFor(() => expect(pipDoc.body.contains(video)).toBe(true));

    // Queued, because the pause the move causes is queued too.
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it("leaves a paused picture paused", async () => {
    // Popping out is not a play button.
    stubPaused(true);
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc } = fakePipWindow();
    const video = container.querySelector("video")!;
    play.mockClear();

    fireEvent.click(screen.getByTitle("Picture in picture"));
    await waitFor(() => expect(pipDoc.body.contains(video)).toBe(true));
    await new Promise((r) => setTimeout(r, 20));

    expect(play).not.toHaveBeenCalled();
  });

  it("lets Escape dismiss the pop-out rather than the player", async () => {
    // While the picture is out in its own window, that window is the nearest
    // thing Escape can mean. Closing the player would take away a pop-out the
    // viewer was watching and the programme with it.
    stubPaused(false);
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <VideoPlayer
          source={{ kind: "live", channel: CHANNEL, program: NEWS_HOUR }}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc, close } = fakePipWindow();
    const video = container.querySelector("video")!;

    fireEvent.click(screen.getByTitle("Picture in picture"));
    await waitFor(() => expect(pipDoc.body.contains(video)).toBe(true));

    fireEvent.keyDown(window, { key: "Escape" });
    // The window is asked to close; the player is left alone.
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
