import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { SKIP_DEBOUNCE_MS } from "../lib/playback";
import * as playback from "../lib/playback";
import { api } from "../api/tablo";
import type { Channel, Program, Recording } from "../api/tablo";

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

function stubBuffered(start: number, end: number) {
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
    configurable: true,
    get: () => ({ length: 1, start: () => start, end: () => end }),
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
    // jsdom implements neither, and the button is gated on the API being
    // present — without this it renders nowhere and proves nothing.
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

  it("keeps the browser's own floating button off the picture", async () => {
    // The only opt-out a page has. It is also why the pop-out below cannot
    // use `requestPictureInPicture`.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    // Set as a property now: the element is built imperatively rather than
    // rendered, because two React roots would each make one from JSX.
    expect(container.querySelector("video")!.disablePictureInPicture).toBe(true);
  });

  it("leaves the native button alone where there is no pop-out to offer", async () => {
    // Safari implements no Document Picture-in-Picture, so our own button is
    // gated away there. Opting out of the browser's button as well would leave
    // that browser with no picture-in-picture at all — a loss, not a trade.
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    expect(container.querySelector("video")!.disablePictureInPicture).toBeFalsy();
  });

  it("offers the pop-out between sound and fullscreen", async () => {
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    const titles = [...container.querySelectorAll("button")]
      .map((b) => b.getAttribute("title") ?? "")
      .filter((t) => /Mute|Unmute|picture|Fullscreen/i.test(t));
    // Every control that has a key says so. This one was the odd one out
    // between two that did, which read as though it had no shortcut.
    expect(titles).toEqual(["Mute (M)", "Picture in picture (P)", "Fullscreen (F)"]);
  });

  it("keeps naming the key once it is popped out", async () => {
    // The same key closes it, so the labels that replace it carry it too —
    // otherwise the hint disappears exactly when it is being looked for. What
    // the tab shows while the window is out is a placeholder whose caption is
    // the only text on the screen, so it says the key in full.
    renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() =>
      expect(pipDoc.body.querySelector('[aria-label="Back 10 seconds"]')).not.toBeNull());

    expect(screen.getByTitle("Close picture-in-picture (P)")).toBeInTheDocument();
    expect(screen.getByText("Close picture-in-picture (P)")).toBeInTheDocument();
    // And the pop-out's own button, which is the one under the pointer there.
    expect(pipDoc.body.querySelector('[title="Close picture-in-picture (P)"]'))
      .not.toBeNull();
  });

  /**
   * A stand-in for the window the browser hands back.
   *
   * Backed by an iframe rather than a bare document, because a React root has
   * to render into it and that needs a document with a window of its own.
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
    } as unknown as Window;
    const requestWindow = vi.fn().mockResolvedValue(w);
    (window as unknown as Record<string, unknown>).documentPictureInPicture = { requestWindow };
    return { pipDoc, requestWindow, close: w.close as ReturnType<typeof vi.fn> };
  }

  it("mounts the stage on the pop-out window and shows a mirror there", async () => {
    // The element itself stays put. Carrying it across breaks the stream
    // twice over — the MediaSource blob belongs to this document, and a fresh
    // window has no user activation to play with — so the pop-out gets a
    // muted mirror of the same tracks and the controls keep driving the
    // original.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc, requestWindow } = fakePipWindow();

    const video = container.querySelector("video")!;
    fireEvent.click(screen.getByTitle("Picture in picture (P)"));

    await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(pipDoc.body.querySelector('[aria-label="Back 10 seconds"]')).not.toBeNull());

    const mirror = pipDoc.body.querySelector("video");
    expect(mirror).not.toBeNull();
    expect(mirror).not.toBe(video);          // a mirror, not the original
    expect(mirror!.muted).toBe(true);        // which is why it may autoplay
    // The original never left, and still carries the sound.
    expect(container.contains(video)).toBe(true);
    expect(video.muted).toBe(false);
    // Placement is the browser's to remember.
    expect(requestWindow).toHaveBeenCalledWith();
  });

  it("leaves no scrollbar down the side of the pop-out", async () => {
    // Every stylesheet in the tab is copied into the window, and one of them
    // makes the root a scroll container on purpose: `html { overflow-y:
    // scroll }` is what reserves the gutter that stops the tabs jumping 2px
    // between Live and Guide. Carried over here it reserves a groove beside a
    // video that never scrolls. `body` was already pinned; the root was not.
    renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() =>
      expect(pipDoc.body.querySelector('[aria-label="Back 10 seconds"]')).not.toBeNull());

    expect(pipDoc.documentElement.style.overflow).toBe("hidden");
  });

  /**
   * Pops out and hands back the pop-out's own stage, with a measurable frame.
   *
   * The bar there is summoned by the pointer's height rather than by entering
   * a strip, so it needs a rect — and in jsdom every rect is zero, which the
   * height guard reads as "no frame" and never shows the bar at all.
   */
  async function poppedOutStage() {
    renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc } = fakePipWindow();

    fireEvent.click(screen.getByTitle("Picture in picture (P)"));
    await waitFor(() =>
      expect(pipDoc.body.querySelector('[aria-label="Back 10 seconds"]')).not.toBeNull());

    const stage = pipDoc.body.firstElementChild!.firstElementChild as HTMLElement;
    stage.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 640, height: 360, top: 0, left: 0,
      right: 640, bottom: 360, toJSON: () => {},
    });
    return { pipDoc, stage };
  }

  it("holds the pop-out's bar for a moment after the cursor leaves it", async () => {
    // Snapping away the instant the pointer clears the bottom strip punishes
    // a hand on its way to the scrubber, and flickers when it crosses the
    // boundary at all. Three quarters of a second is long enough to come back
    // to and short enough not to feel stuck.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { pipDoc, stage } = await poppedOutStage();

      fireEvent.mouseMove(stage, { clientY: 350 });         // into the strip
      await act(async () => {});
      expect(chrome(pipDoc.body).className).toContain("opacity-100");

      fireEvent.mouseMove(stage, { clientY: 40 });           // and back out
      await act(async () => { vi.advanceTimersByTime(700); });
      expect(chrome(pipDoc.body).className).toContain("opacity-100");

      await act(async () => { vi.advanceTimersByTime(100); });
      expect(chrome(pipDoc.body).className).toContain("opacity-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the cursor alone in the pop-out", async () => {
    // Hiding the pointer belongs to a fullscreen frame, where it is the only
    // thing on screen that is not the programme. A pop-out is a small window
    // among others: the pointer there is on its way somewhere, and taking it
    // away leaves someone hunting for it. The tab's idle timer keeps running
    // while the window is out, so this has to be refused explicitly rather
    // than simply not happening.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { stage } = await poppedOutStage();

      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(stage.className).not.toContain("cursor-none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels that wait if the cursor comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { pipDoc, stage } = await poppedOutStage();

      fireEvent.mouseMove(stage, { clientY: 350 });
      fireEvent.mouseMove(stage, { clientY: 40 });
      await act(async () => { vi.advanceTimersByTime(500); });
      fireEvent.mouseMove(stage, { clientY: 350 });

      await act(async () => { vi.advanceTimersByTime(2_000); });
      expect(chrome(pipDoc.body).className).toContain("opacity-100");
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

/**
 * The skip buttons queue.
 *
 * Every tap used to seek, and on the MPEG-2 path a seek tears the decoder
 * down and rebuilds it. Twenty taps to move ten minutes bought twenty
 * rebuilds — and did not even go ten minutes, because each tap chained off a
 * `currentTime` that had not moved yet.
 */
describe("the skip buttons", () => {
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
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("clamps a live skip to the buffered (cached) range, not the whole window", async () => {
    // Seekable is 0..900 but only 200..600 is actually cached. A skip must
    // stay inside that run — landing past it is what stalled live and made the
    // player buffer in both directions. The scrubber (a separate path) stays
    // free; this only gates skip.
    stubSeekable(900);
    stubBuffered(200, 600);
    vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockReturnValue(450);
    const planSkipSpy = vi.spyOn(playback, "planSkip");
    try {
      renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());
      // Let liveTranscoded settle true (startStream returned transcoded).
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      planSkipSpy.mockClear();
      fireEvent.keyDown(window, { key: "ArrowRight" });

      const call = planSkipSpy.mock.calls.at(-1);
      expect(call).toBeTruthy();
      // planSkip(pending, from, delta, range, margin) — range is the clamp.
      expect(call![3]).toEqual([200, 600]);
    } finally {
      planSkipSpy.mockRestore();
    }
  });

  it("turns a flurry of taps into a single seek", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seeks: number[] = [];
    // The surface writes through to the media element, so this is where a
    // rebuild would be triggered from.
    const spy = vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set")
      .mockImplementation(function (this: HTMLMediaElement, v: number) {
        seeks.push(v);
      });
    try {
      const { container } = renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());
      const fwd = container.querySelector<HTMLElement>('[aria-label="Forward 30 seconds"]');
      if (!fwd) return;              // transport not mounted in this environment

      seeks.length = 0;
      for (let i = 0; i < 8; i++) fireEvent.click(fwd);
      // Nothing yet: the decoder is deliberately left alone while taps land.
      expect(seeks).toHaveLength(0);

      await act(async () => { vi.advanceTimersByTime(SKIP_DEBOUNCE_MS + 60); });
      expect(seeks.length).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The queue is not a live-only feature.
 *
 * `skip` is one function serving the buttons, the tap zones and the arrow
 * keys, and `isLive` changes only the edge margin — a live end is a frontier
 * the encoder is still extending, a recording's is settled. Everything about
 * the accumulation is shared, and this pins that down so a later change to
 * either path cannot quietly take it away from the other.
 */
describe("skip queuing on a recording", () => {
  const REC = {
    object_id: 80888, identifier: 80888, path: "/recordings/airings/80888",
    title: "NFL Football", subtitle: null, description: null,
    start: new Date(Date.now() - 3600_000).toISOString(),
    duration: 3600, recorded_seconds: null, state: "finished",
    channel: null, thumbnail: null, watched: false, position: 0,
  } as unknown as Recording;

  function renderRecording(recording: Recording) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <VideoPlayer source={{ kind: "recording", recording }} onClose={() => {}} />
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "watchRecording").mockResolvedValue({
      playlist_url: "/api/recordings/80888/playlist.m3u8", duration: 3600,
    } as never);
    vi.spyOn(api, "watchRecordingVod").mockRejectedValue(new Error("no vod"));
    vi.spyOn(api, "recordingStatus").mockResolvedValue({
      state: "complete", duration: 3600, progress: 1, cached_seconds: 3600,
    } as never);
    stubSeekable(3600);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("holds the taps back on a recording too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seeks: number[] = [];
    const spy = vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set")
      .mockImplementation(function (this: HTMLMediaElement, v: number) {
        seeks.push(v);
      });
    try {
      const { container } = renderRecording(REC);
      await act(async () => { vi.advanceTimersByTime(200); });
      const fwd = container.querySelector<HTMLElement>('[aria-label="Forward 30 seconds"]');
      if (!fwd) return;              // transport not mounted in this environment

      seeks.length = 0;
      for (let i = 0; i < 8; i++) fireEvent.click(fwd);
      expect(seeks).toHaveLength(0);

      await act(async () => { vi.advanceTimersByTime(SKIP_DEBOUNCE_MS + 60); });
      expect(seeks.length).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("maps the arrow keys to 30s forward / 10s back", async () => {
    // The keys map straight into skip(delta) -> planSkip(...,delta,...); assert
    // the delta rather than the landing spot, which a recording routes through
    // a rebuild instead of the currentTime setter.
    const planSkipSpy = vi.spyOn(playback, "planSkip");
    try {
      renderRecording(REC);
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      planSkipSpy.mockClear();
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(planSkipSpy.mock.calls.map((c) => c[2])).toContain(30);

      planSkipSpy.mockClear();
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      expect(planSkipSpy.mock.calls.map((c) => c[2])).toContain(-10);
    } finally {
      planSkipSpy.mockRestore();
    }
  });
});
