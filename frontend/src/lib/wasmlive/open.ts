/**
 * Assembling a live WASM session out of its parts.
 *
 * The parts are all independently testable and none of them know about the
 * browser's globals; this is the one file that does the wiring, so it is the
 * one file that needs a real Worker, AudioContext and canvas.
 */

import { createAudioSink } from "./audioSink";
import { createRenderer } from "./deinterlace";
import { createPresenter } from "./presenter";
import { createSession } from "./session";
import { createWasmSurface } from "./wasmSurface";
import type { PlaybackSurface } from "../playbackSurface";
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

export interface OpenOptions {
  /** The ring playlist to follow. */
  playlistUrl: string;
  /** When the backend opened the session; media time counts from here. */
  originMs: number;
  /** Where the picture goes. */
  canvas: HTMLCanvasElement | null;
  /** Called when the session gives up, with the reason. */
  onFailure: (reason: string) => void;
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
  try {
    const context = new AudioContext({ sampleRate: 48000 });
    audio = await createAudioSink(context, workletUrl);
    // An AudioContext created after an await has no user activation behind it,
    // so it starts suspended — and a suspended context renders no samples, so
    // the clock never advances and video freezes on whatever was due at the
    // first timestamp. Resuming here covers the usual case; pressing play
    // resumes it again if the browser refused this one.
    await context.resume().catch(() => {});
  } catch (e) {
    worker.terminate();
    renderer.destroy();
    throw e;
  }

  const presenter = createPresenter({
    now: () => audio.clockSeconds ?? 0,
    upload: (frame) => renderer.upload(frame),
    draw: (field) => renderer.drawField(field.parity, field.interlaced),
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
    nowMs: () => performance.now(),
    schedule: (callback, intervalMs) => {
      const id = setInterval(callback, intervalMs);
      return () => clearInterval(id);
    },
  });

  // Presentation is driven by the display, and timed against the audio clock.
  let frame = 0;
  const loop = () => {
    session.tick();
    if (session.failure) {
      cancelAnimationFrame(frame);
      options.onFailure(session.failure);
      return;
    }
    frame = requestAnimationFrame(loop);
  };

  await session.start();
  frame = requestAnimationFrame(loop);

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
    get error() { return surface.error; },
    diagnostics: () => surface.diagnostics(),
    on: (event, handler) => surface.on(event, handler),
    destroy() {
      cancelAnimationFrame(frame);
      surface.destroy();
      renderer.destroy();
    },
  };
}
