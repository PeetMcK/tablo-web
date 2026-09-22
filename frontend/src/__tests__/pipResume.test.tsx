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

  /**
   * @param inner The box the browser opens the window at — by default the one
   *   it remembers from the last pop-out, which is what the shape correction
   *   has to work from.
   */
  function fakePipWindow(inner = { width: 1200, height: 675 }) {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const pipDoc = frame.contentDocument!;
    const listeners = new Map<string, EventListener[]>();
    const resizeTo = vi.fn(function (this: Record<string, number>, w: number, h: number) {
      // A real window answers its new size afterwards, and the correction
      // checks — a browser that clamps has not done what was asked.
      this.outerWidth = w;
      this.outerHeight = h;
      this.innerWidth = w;
      this.innerHeight = h - 38;
    });
    const w = {
      document: pipDoc,
      close: vi.fn(),
      addEventListener: vi.fn((type: string, fn: EventListener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      }),
      removeEventListener: vi.fn(),
      innerWidth: inner.width,
      innerHeight: inner.height,
      // A title bar of the browser's own, which `resizeTo` counts and the
      // content box does not.
      outerWidth: inner.width,
      outerHeight: inner.height + 38,
      resizeTo,
    } as unknown as Window;
    const requestWindow = vi.fn().mockResolvedValue(w);
    (window as unknown as Record<string, unknown>).documentPictureInPicture = { requestWindow };
    return {
      pipDoc, close: w.close as ReturnType<typeof vi.fn>, requestWindow, resizeTo,
      /** A gesture inside the pop-out — the only kind `resizeTo` accepts. */
      touch: () => (listeners.get("pointerdown") ?? [])
        .forEach((fn) => fn(new Event("pointerdown"))),
    };
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

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
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

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
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

  /**
   * A decoding picture of this shape.
   *
   * `videoWidth` lives on HTMLVideoElement rather than HTMLMediaElement, and
   * jsdom's own pair answers zero. Put back by hand: a defined property is
   * not a spy, and `restoreAllMocks` leaves it where it is.
   */
  function stubPicture(width: number, height: number) {
    const original = {
      width: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoWidth")!,
      height: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoHeight")!,
    };
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth",
      { configurable: true, get: () => width });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight",
      { configurable: true, get: () => height });
    onTestFinished(() => {
      Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", original.width);
      Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", original.height);
    });
  }

  it("never asks for a placement, so the window opens where it was left", async () => {
    // `preferInitialWindowPlacement` is the only way to have a requested size
    // honoured, and it costs the remembered position — the pop-out goes back
    // to the browser's default corner every time. The shape is fixed by
    // resizing instead, which keeps the corner.
    stubPicture(640, 480);
    renderPlayer();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { requestWindow } = fakePipWindow();

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
    await waitFor(() => expect(requestWindow).toHaveBeenCalled());

    const asked = requestWindow.mock.calls[0][0] as Record<string, unknown>;
    expect(asked.preferInitialWindowPlacement).toBeUndefined();
  });

  it("never resizes a window on its own", async () => {
    // Two reasons, and either alone would settle it. `resizeTo` throws
    // NotAllowedError unless the pop-out's own document holds a transient
    // activation, which a window one statement old has never had — and a
    // picture that resizes itself under the hand of someone reaching for
    // pause is worse than the letterboxing it would be correcting.
    stubPicture(640, 480);
    renderPlayer();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { requestWindow, resizeTo, touch } = fakePipWindow({ width: 1200, height: 675 });

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
    await waitFor(() => expect(requestWindow).toHaveBeenCalled());
    touch();

    expect(resizeTo).not.toHaveBeenCalled();
  });

  it("resets the window that is already out, without closing it", async () => {
    // The moment a viewer wants the small one back is while looking at the
    // big one. Closing and reopening would be the one thing that loses the
    // position the browser is holding, so the open window is resized instead.
    stubPicture(1920, 1080);
    renderPlayer();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc, close, resizeTo } = fakePipWindow({ width: 1800, height: 1012 });

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
    await waitFor(() =>
      expect(pipDoc.body.querySelector('[aria-label="Back 10 seconds"]')).not.toBeNull());
    resizeTo.mockClear();

    // The button in the pop-out's own control row — the one under the pointer
    // there, which is where the right-click lands.
    const button = pipDoc.body.querySelector<HTMLElement>(
      '[title^="Close picture-in-picture (P)"]')!;
    fireEvent.contextMenu(button);

    expect(resizeTo).toHaveBeenCalledWith(480, 270 + 38);
    expect(close).not.toHaveBeenCalled();
  });

  it("offers no reset before there is a window to reset", async () => {
    // A right-click in the tab could only ever be refused: `resizeTo` wants
    // an activation belonging to the pop-out's document, and this one belongs
    // to the tab's. An affordance that cannot work is worse than none.
    stubPicture(1920, 1080);
    renderPlayer();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { requestWindow } = fakePipWindow();

    fireEvent.contextMenu(screen.getByTitle("Picture in picture (P)"));

    expect(requestWindow).not.toHaveBeenCalled();
  });

  it("lets Escape dismiss the pop-out rather than the player", async () => {
    // While the picture is out in its own window, that window is the nearest
    // thing Escape can mean. Closing the player would take the programme too.
    const onClose = vi.fn();
    const { container } = renderPlayer(onClose);
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc, close } = fakePipWindow();
    void container;

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
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

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    expect(canvasCapture).toHaveBeenCalled();
    expect(videoCapture).not.toHaveBeenCalled();
  });

  it("offers the pop-out on this path too", async () => {
    // The button is gated on the browser API, not on which decoder is running.
    // Worth pinning: the two paths differ in what they draw with, and a gate
    // added to one would be invisible from the other.
    await renderWasmLivePlayer();
    expect(screen.getByTitle(/^Picture in picture \(P\)/)).toBeInTheDocument();
  });

  it("leaves the canvas in the tab", async () => {
    // Same rule as the video element: nothing crosses documents. The pop-out
    // window is destroyed when it closes, and a canvas inside it would go with
    // it, taking the WebGL context the renderer holds.
    const { container } = await renderWasmLivePlayer();
    const canvas = container.querySelector("canvas")!;
    const { pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
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

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
    await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());

    expect(wasm.surface!.repaint).toHaveBeenCalled();
  });

  it("drives the presentation loop from the window that is on screen", async () => {
    // A hidden document runs no animation frames, so the canvas would freeze
    // the moment the tab went behind something — which is the whole occasion
    // for popping out.
    await renderWasmLivePlayer();
    const { w, pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
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

    fireEvent.click(screen.getByTitle(/^Picture in picture \(P\)/));
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
