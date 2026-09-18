/**
 * Assembling a live WASM session out of its parts.
 *
 * The parts are all independently testable and none of them know about the
 * browser's globals; this is the one file that does the wiring, so it is the
 * one file that needs a real Worker, AudioContext and canvas.
 */

import { createAudioSink } from "./audioSink";
import { createRenderer } from "./deinterlace";
import { createPresenter, type FieldPresentation } from "./presenter";
import { createSession } from "./session";
import { createWasmSurface } from "./wasmSurface";
import {
  startFrameLoop, type FrameSource, type PlaybackSurface,
} from "../playbackSurface";
import workletUrl from "./pcmWorklet.js?url";

/**
 * How long a request to our own backend may take before it is abandoned.
 *
 * Generous: these are loopback or LAN requests, but the backend may be priming
 * a ring or serving a segment off a device that is thinking about it. Short
 * enough that a dropped connection does not hold the transport until the
 * watchdog gives up on the whole session.
 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * Resume the audio context on the viewer's next gesture, whatever it is.
 *
 * Chrome refuses to start a context without user activation behind it, and the
 * one we create is always after an await — opening the channel is a click, but
 * the activation is spent by the time the sink exists. The refusal is not an
 * error anywhere: the context simply stays suspended, the worklet renders
 * nothing, the clock never advances, and because video is presented against
 * that clock the picture freezes on the first field while the player's
 * controls insist it is playing.
 *
 * So anything counts as the unlock — a click on the page, a key, a touch —
 * rather than only the play button, which a viewer has no reason to press when
 * the player already says it is playing. jsmpeg does the same thing under the
 * name `unlock`.
 *
 * `once` per event and all three removed on the first success, so this costs
 * nothing after it has worked.
 */
function unlockOnGesture(context: AudioContext): () => void {
  if (context.state === "running") return () => {};

  const events = ["pointerdown", "keydown", "touchstart"] as const;
  const stop = () => {
    for (const type of events) document.removeEventListener(type, resume, true);
  };
  const resume = () => {
    void context.resume().then(stop).catch(() => {});
  };
  // Capture phase: the player stops some of these before they reach the
  // document, and an unlock that depends on which control was hit is not an
  // unlock.
  for (const type of events) document.addEventListener(type, resume, true);
  return stop;
}

export interface OpenOptions {
  /** The ring playlist to follow. */
  playlistUrl: string;
  /** When the backend opened the session; media time counts from here. */
  originMs: number;
  /** Where the picture goes. */
  canvas: HTMLCanvasElement | null;
  /** Called when the session gives up, with the reason. */
  onFailure: (reason: string) => void;
  /**
   * Set for a finished recording: a fixed index rather than a sliding window.
   *
   * Read the session's own `vod` for what this changes — it is three things,
   * and the decode path is not one of them.
   */
  vod?: { durationSeconds: number; growing?: boolean };
  /** Where animation frames come from. Defaults to the main document's. */
  frames?: FrameSource;
}

export async function openWasmSurface(options: OpenOptions): Promise<PlaybackSurface> {
  const { canvas } = options;
  if (!canvas) throw new Error("no canvas to draw on");

  // Checked by asking rather than by feature detection: a machine with
  // acceleration disabled has the constructor and no context behind it.
  const renderer = createRenderer(canvas);

  const worker = new Worker(new URL("./decode.worker.ts", import.meta.url), {
    type: "module",
  });

  let audio;
  let releaseUnlock = () => {};
  try {
    const context = new AudioContext({ sampleRate: 48000 });
    audio = await createAudioSink(context, workletUrl);
    // An AudioContext created after an await has no user activation behind it,
    // so it starts suspended — and a suspended context renders no samples, so
    // the clock never advances and video freezes on whatever was due at the
    // first timestamp. Resuming here covers the usual case.
    await context.resume().catch(() => {});
    releaseUnlock = unlockOnGesture(context);
  } catch (e) {
    worker.terminate();
    renderer.destroy();
    throw e;
  }

  // The last field drawn, kept so it can be drawn again.
  //
  // Two things need that. The context is created with
  // `preserveDrawingBuffer: false`, so the picture exists only until it is
  // composited — a window that shows this canvas and schedules no frames of
  // its own ends up black. And `captureStream` emits a frame only when the
  // canvas is drawn to, so a paused session hands the pop-out's mirror a
  // track that is live, correctly sized, and has never produced a frame.
  // Redrawing costs one draw call against textures that are already resident.
  let lastField: FieldPresentation | null = null;

  const presenter = createPresenter({
    now: () => audio.clockSeconds ?? 0,
    nowMs: () => performance.now(),
    upload: (frame) => renderer.upload(frame),
    draw: (field) => {
      lastField = field;
      renderer.drawField(field.parity, field.interlaced);
    },
  });

  const session = createSession({
    playlistUrl: options.playlistUrl,
    originMs: options.originMs,
    worker,
    audio,
    presenter,
    // Both bounded. Neither was, and one hung request blocks every later poll
    // behind it until the frozen-picture watchdog ends the session six seconds
    // later — for a backend that is merely slow, or a connection that dropped
    // without closing. The device-side requests were given timeouts; these,
    // between the page and our own backend, were missed.
    fetchText: async (url) => {
      const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`playlist ${resp.status}`);
      return resp.text();
    },
    fetchBytes: async (url) => {
      const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`segment ${resp.status}`);
      return resp.arrayBuffer();
    },
    vod: options.vod,
    nowMs: () => performance.now(),
    schedule: (callback, intervalMs) => {
      const id = setInterval(callback, intervalMs);
      return () => clearInterval(id);
    },
  });

  await session.start();

  // Presentation is driven by the display, and timed against the audio clock.
  // Which display is not fixed, though: the picture can be popped out into a
  // window of its own, and the document left behind runs no animation frames
  // at all once it is hidden — so the loop can be pointed at another window.
  const loop = startFrameLoop(() => {
    session.tick();
    if (session.failure) {
      options.onFailure(session.failure);
      return false;
    }
    return true;
  }, options.frames);

  const surface = createWasmSurface(session);
  // Delegated property by property rather than spread: spreading would read
  // each getter once and hand back a frozen snapshot of the clock.
  return {
    play: () => surface.play(),
    pause: () => surface.pause(),
    seek: (seconds: number) => surface.seek(seconds),
    get currentTime() { return surface.currentTime; },
    get seekable() { return surface.seekable; },
    get duration() { return surface.duration; },
    get paused() { return surface.paused; },
    get muted() { return surface.muted; },
    setMuted: (muted: boolean) => surface.setMuted(muted),
    get volume() { return surface.volume; },
    setVolume: (volume: number) => surface.setVolume(volume),
    get error() { return surface.error; },
    diagnostics: () => surface.diagnostics(),
    on: (event, handler) => surface.on(event, handler),
    setFrameSource: (next: FrameSource) => loop.setFrameSource(next),
    repaint() {
      if (lastField) renderer.drawField(lastField.parity, lastField.interlaced);
    },
    destroy() {
      loop.stop();
      releaseUnlock();
      surface.destroy();
      renderer.destroy();
    },
  };
}
