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

/**
 * Popping out used to stop playback, and the reason was never ours: a media
 * element taken out of a document is paused, its MediaSource blob stops
 * resolving, and the new window has no user activation to play with. Nothing
 * moves now, so none of that applies — and these hold it that way.
 */
describe("popping out leaves the playing element alone", () => {
  let play: ReturnType<typeof vi.spyOn>;
  let pause: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
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
    // Both absent from jsdom: the button is gated on the API existing, and
    // the mirror is built from the element's own tracks.
    (window as unknown as Record<string, unknown>).documentPictureInPicture = {
      requestWindow: vi.fn(),
    };
    (HTMLMediaElement.prototype as unknown as Record<string, unknown>).captureStream =
      () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
  });

  function fakePipWindow() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const pipDoc = frame.contentDocument!;
    const w = {
      document: pipDoc,
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const requestWindow = vi.fn().mockResolvedValue(w);
    (window as unknown as Record<string, unknown>).documentPictureInPicture = { requestWindow };
    return { pipDoc, close: w.close as ReturnType<typeof vi.fn> };
  }

  function renderPlayer(onClose = () => {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <VideoPlayer
          source={{ kind: "live", channel: CHANNEL, program: NEWS_HOUR }}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
  }

  it("never re-parents or pauses the element it is playing", async () => {
    const { container } = renderPlayer();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc } = fakePipWindow();
    const video = container.querySelector("video")!;
    const home = video.parentElement;
    play.mockClear();
    pause.mockClear();

    fireEvent.click(screen.getByTitle("Picture in picture"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    // Same parent, and nobody asked it to stop or to start again.
    expect(video.parentElement).toBe(home);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("keeps the real element in this document once the pop-out is up", async () => {
    // The stage that hosts the picture is rendered by two roots, and the
    // element itself must never leave the tab: the pop-out's document is
    // destroyed when that window closes, and anything still inside it is
    // reset — currentTime 0, readyState 0 — which leaves hls.js appending
    // into a dead element and killing the stream with a bufferAppendError.
    //
    // The catch is that it does not happen when the pop-out opens. It happens
    // on the next render, so the assertion has to come after one.
    const { container } = renderPlayer();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc } = fakePipWindow();
    const video = container.querySelector("video")!;

    fireEvent.click(screen.getByTitle("Picture in picture"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    // Anything that re-renders the tab's stage will do; playback does this
    // several times a second on its own.
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(video.ownerDocument).toBe(document));

    expect(video.isConnected).toBe(true);
    expect(pipDoc.body.contains(video)).toBe(false);
    // Which leaves the pop-out showing a mirror rather than the original.
    expect(pipDoc.body.querySelector("video")).not.toBe(video);
  });

  it("lets Escape dismiss the pop-out rather than the player", async () => {
    // While the picture is out in its own window, that window is the nearest
    // thing Escape can mean. Closing the player would take the programme too.
    const onClose = vi.fn();
    const { container } = renderPlayer(onClose);
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc, close } = fakePipWindow();
    void container;

    fireEvent.click(screen.getByTitle("Picture in picture"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
