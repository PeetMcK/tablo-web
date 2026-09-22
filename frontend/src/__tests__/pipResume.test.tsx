import {
  describe, it, expect, vi, beforeEach, afterEach, onTestFinished,
} from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import type { Channel, Program } from "../api/tablo";
import type { FrameSource, PlaybackSurface } from "../lib/playbackSurface";

/** The one surface method these tests watch, typed so `satisfies` can see it. */
type SetFrameSourceMock = ReturnType<typeof vi.fn<(next: FrameSource) => void>>;

/**
 * Both modules the WASM path is chosen and built by, under test control.
 *
 * Hoisted because `vi.mock` is: the factories below run before any `const` in
 * this file would have been evaluated, so the switch they read has to exist
 * earlier than the file's own top level.
 */
const wasm = vi.hoisted(() => ({
  /** Off by default, so the transcode-path tests here are untouched. */
  eligible: false,
  surface: null as (PlaybackSurface & {
    setFrameSource: SetFrameSourceMock;
    repaint: ReturnType<typeof vi.fn<() => void>>;
  }) | null,
  open: vi.fn(),
}));

vi.mock("../lib/wasmlive/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wasmlive/capability")>();
  return {
    ...actual,
    // jsdom has neither WebGL2 nor OffscreenCanvas nor a Chrome user agent, so
    // the real check can only ever say no here. Which path is taken is the
    // premise of these tests, not their subject.
    wasmLiveEligible: () => (wasm.eligible
      ? { eligible: true, reason: "" }
      : { eligible: false, reason: "test" }),
  };
});

vi.mock("../lib/wasmlive/open", () => ({ openWasmSurface: wasm.open }));

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
    return { pipDoc, close: w.close as ReturnType<typeof vi.fn>, requestWindow };
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

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
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

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
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

  it("asks for a window the shape of the picture", async () => {
    // Asked with no size, the browser reopens the box it remembers — which is
    // the shape of whatever played last, and letterboxes everything else.
    //
    // `videoWidth` lives on HTMLVideoElement rather than HTMLMediaElement, and
    // jsdom's own pair answers zero; put back by hand because a defined
    // property is not a spy and `restoreAllMocks` leaves it where it is.
    const original = {
      width: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoWidth")!,
      height: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoHeight")!,
    };
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth",
      { configurable: true, get: () => 1440 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight",
      { configurable: true, get: () => 1080 });
    onTestFinished(() => {
      Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", original.width);
      Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", original.height);
    });
    renderPlayer();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { requestWindow } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() => expect(requestWindow).toHaveBeenCalled());

    const box = requestWindow.mock.calls[0][0] as { width: number; height: number };
    expect(box.width / box.height).toBeCloseTo(4 / 3, 2);
  });

  it("lets Escape dismiss the pop-out rather than the player", async () => {
    // While the picture is out in its own window, that window is the nearest
    // thing Escape can mean. Closing the player would take the programme too.
    const onClose = vi.fn();
    const { container } = renderPlayer(onClose);
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc, close } = fakePipWindow();
    void container;

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * The same pop-out, on the path that draws into a canvas.
 *
 * Nothing here is about MPEG-2. It is about the two facts that make the canvas
 * different from the element: it is not what `videoRef` points at, and it is
 * painted by an animation frame loop that a hidden document does not run.
 */
describe("popping out the picture the WASM path is drawing", () => {
  let canvasCapture: ReturnType<typeof vi.fn>;
  let videoCapture: ReturnType<typeof vi.fn>;

  /** A stream, shaped only as far as `closeMirror` reads it. */
  const stubStream = () =>
    ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;

  /** A surface the player can hold, with the one method under test spied. */
  function stubSurface() {
    return {
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      seek: vi.fn(),
      currentTime: 0,
      seekable: [0, 60] as const,
      duration: null,
      paused: false,
      muted: false,
      setMuted: vi.fn(),
      volume: 1,
      setVolume: vi.fn(),
      error: null,
      diagnostics: () => ({ kind: "wasm" }),
      on: () => () => {},
      destroy: vi.fn(),
      repaint: vi.fn(),
      setFrameSource: vi.fn<(next: FrameSource) => void>(),
    } satisfies PlaybackSurface & {
      setFrameSource: SetFrameSourceMock;
      repaint: ReturnType<typeof vi.fn<() => void>>;
    };
  }

  beforeEach(() => {
    wasm.eligible = true;
    wasm.surface = stubSurface();
    wasm.open.mockReset();
    wasm.open.mockResolvedValue(wasm.surface);

    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "ring-1", proxy_url: "/a", stream_url: "/ring.m3u8", transcoded: false,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS_HOUR] });

    videoCapture = vi.fn(stubStream);
    canvasCapture = vi.fn(stubStream);
    (HTMLMediaElement.prototype as unknown as Record<string, unknown>)
      .captureStream = videoCapture;
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)
      .captureStream = canvasCapture;
    (window as unknown as Record<string, unknown>).documentPictureInPicture = {
      requestWindow: vi.fn(),
    };
  });

  afterEach(() => {
    wasm.eligible = false;
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
    delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).captureStream;
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).captureStream;
  });

  /**
   * A pop-out window with its own frame clock.
   *
   * The clock is the point: a document that is hidden runs no animation
   * frames, so what the canvas is driven by while popped out has to be this
   * window's, not the tab's.
   */
  function fakePipWindow() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const pipDoc = frame.contentDocument!;
    const w = {
      document: pipDoc,
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: vi.fn(() => 7),
      cancelAnimationFrame: vi.fn(),
    } as unknown as Window;
    (window as unknown as Record<string, unknown>).documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue(w),
    };
    return { w, pipDoc };
  }

  async function renderWasmLivePlayer() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}>
        <VideoPlayer
          source={{ kind: "live", channel: CHANNEL, program: NEWS_HOUR }}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    // Not just that the stream started: the canvas has to be the visible
    // element before any of this means anything.
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
    await waitFor(() => {
      expect(view.container.querySelector("canvas")?.hidden).toBe(false);
    });
    return view;
  }

  it("mirrors the canvas rather than the empty video element", async () => {
    // The pop-out shows a mirror of whatever is producing pixels. On this path
    // that is the canvas; a mirror of the hidden `<video>` would pop out a
    // black rectangle, which is what the gap looked like.
    await renderWasmLivePlayer();
    const { pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    expect(canvasCapture).toHaveBeenCalled();
    expect(videoCapture).not.toHaveBeenCalled();
  });

  it("offers the pop-out on this path too", async () => {
    // The button is gated on the browser API, not on which decoder is running.
    // Worth pinning: the two paths differ in what they draw with, and a gate
    // added to one would be invisible from the other.
    await renderWasmLivePlayer();
    expect(screen.getByTitle("Picture in picture (P)")).toBeInTheDocument();
  });

  it("leaves the canvas in the tab", async () => {
    // Same rule as the video element: nothing crosses documents. The pop-out
    // window is destroyed when it closes, and a canvas inside it would go with
    // it, taking the WebGL context the renderer holds.
    const { container } = await renderWasmLivePlayer();
    const canvas = container.querySelector("canvas")!;
    const { pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    expect(canvas.ownerDocument).toBe(document);
    expect(pipDoc.body.querySelector("canvas")).toBeNull();
  });

  it("draws a frame for the mirror, which a paused canvas would never send", async () => {
    // `captureStream` on a canvas emits frames only when something draws, so
    // popping out while paused gave the mirror a track that was live, the
    // right size, and stuck at readyState 0 until playback resumed. Measured
    // in Chrome on 2026-09-17; `requestFrame()` does not help, because an
    // automatic-mode track ignores it.
    //
    // Animation frames are stopped dead here on purpose. The tab runs a
    // repaint loop of its own while popped out, which would satisfy any
    // assertion about repainting and prove nothing — and a hidden tab runs no
    // frames, which is exactly the case that needs the one-shot to exist.
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    await renderWasmLivePlayer();
    const { pipDoc } = fakePipWindow();
    wasm.surface!.repaint.mockClear();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    expect(wasm.surface!.repaint).toHaveBeenCalled();
  });

  it("drives the presentation loop from the window that is on screen", async () => {
    // A hidden document runs no animation frames, so the canvas would freeze
    // the moment the tab went behind something — which is the whole occasion
    // for popping out.
    await renderWasmLivePlayer();
    const { w, pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    await waitFor(() => expect(wasm.surface!.setFrameSource).toHaveBeenCalled());
    const installed = wasm.surface!.setFrameSource.mock.calls.at(-1)![0] as FrameSource;
    installed.request(() => {});
    expect(w.requestAnimationFrame).toHaveBeenCalled();
    installed.cancel(7);
    expect(w.cancelAnimationFrame).toHaveBeenCalledWith(7);
  });

  it("hands the loop back to the tab when the pop-out closes", async () => {
    // The tab's stage is on screen again, and the window whose clock was
    // driving the canvas no longer exists.
    await renderWasmLivePlayer();
    const { w, pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());
    await waitFor(() => expect(wasm.surface!.setFrameSource).toHaveBeenCalled());

    // However it closes, the same handler runs; the window's own close button
    // is the case our button cannot cover.
    const pagehide = (w.addEventListener as ReturnType<typeof vi.fn>).mock.calls
      .find(([type]) => type === "pagehide")![1] as () => void;
    pagehide();

    expect(wasm.surface!.setFrameSource).toHaveBeenCalledTimes(2);
    const restored = wasm.surface!.setFrameSource.mock.calls.at(-1)![0] as FrameSource;
    const before = (w.requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length;
    const handle = restored.request(() => {});
    restored.cancel(handle);
    expect((w.requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe(before);
  });
});
