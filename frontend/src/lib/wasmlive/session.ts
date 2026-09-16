/**
 * One live WASM playback session.
 *
 * Owns the loop that ties the pieces together: the ring playlist is polled,
 * new segments go to the worker, decoded frames go to the presenter and the
 * sink, and the fallback machine watches for the whole thing failing to keep
 * up. Everything it touches is injected, so this file is about sequencing and
 * nothing else.
 */

import { initialFallbackState, reduceFallback } from "./fallback";
import type { FallbackState } from "./fallback";
import { parseMediaPlaylist, playlistWindow, segmentAt } from "./playlist";
import type { MediaPlaylist } from "./playlist";
import type { AudioSink } from "./audioSink";
import type { Presenter } from "./presenter";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";
import type { FromWorker, ToWorker } from "./workerProtocol";

/** How far the clock may run past the newest decoded frame before it counts. */
const STARVED_SECONDS = 1;

export interface SessionDeps {
  playlistUrl: string;
  /** When the backend opened this session, which media time is measured from. */
  originMs: number;
  worker: Worker;
  audio: AudioSink;
  presenter: Presenter;
  fetchText(url: string): Promise<string>;
  fetchBytes(url: string): Promise<ArrayBuffer>;
  nowMs(): number;
  /** Starts a repeating callback; returns a function that stops it. */
  schedule(callback: () => void, intervalMs: number): () => void;
}

export type SessionEvent = "ready" | "timeupdate" | "waiting" | "playing" | "error";

export interface LiveSession {
  start(): Promise<void>;
  /** Fetch whatever the ring has gained. Exposed so tests need no timers. */
  poll(): Promise<void>;
  /** One presentation step. Driven by animation frames in the browser. */
  tick(): void;
  seek(mediaSeconds: number): void;
  pause(): void;
  resume(): void;
  /** Silence the audio without stopping the clock. */
  setMuted(muted: boolean): void;
  readonly currentTime: number;
  readonly seekable: readonly [number, number] | null;
  readonly paused: boolean;
  readonly failure: string | null;
  diagnostics(): Record<string, unknown>;
  on(event: SessionEvent, handler: () => void): () => void;
  destroy(): void;
}

export function createSession(deps: SessionDeps): LiveSession {
  const handlers = new Map<SessionEvent, Set<() => void>>();
  const emit = (event: SessionEvent) => handlers.get(event)?.forEach((fn) => fn());
  const post = (message: ToWorker, transfer: Transferable[] = []) =>
    deps.worker.postMessage(message, transfer);

  let playlist: MediaPlaylist | null = null;
  /** Absolute media sequence of the newest segment sent to the worker. */
  let takenThrough = -1;
  let fallback: FallbackState = initialFallbackState(deps.nowMs());
  let paused = false;
  let stopPolling: (() => void) | null = null;
  let seekTarget: number | null = null;

  deps.worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === "video") {
      for (const frame of message.frames as DecodedVideoFrame[]) deps.presenter.offer(frame);
      return;
    }
    if (message.type === "audio") {
      for (const chunk of message.chunks as DecodedAudioChunk[]) deps.audio.push(chunk);
      return;
    }
    if (message.type === "error") {
      fallback = reduceFallback(fallback, { kind: "decode-error" });
      emit("error");
    }
  };

  /** Resolve a segment uri against the playlist it came from. */
  const segmentUrl = (uri: string) =>
    deps.playlistUrl.replace(/[^/]*$/, "") + uri;

  const poll = async () => {
    const text = await deps.fetchText(deps.playlistUrl);
    playlist = parseMediaPlaylist(text);

    // After a seek, start again from the segment covering the target rather
    // than from the live edge.
    if (seekTarget !== null) {
      const at = segmentAt(playlist, deps.originMs, seekTarget);
      takenThrough = at ? at.sequence - 1 : -1;
      seekTarget = null;
    }

    for (let index = 0; index < playlist.segments.length; index++) {
      const sequence = playlist.mediaSequence + index;
      if (sequence <= takenThrough) continue;
      const bytes = await deps.fetchBytes(segmentUrl(playlist.segments[index].uri));
      post({ type: "segment", bytes }, [bytes]);
      takenThrough = sequence;
    }
    emit("timeupdate");
  };

  const safePoll = async () => {
    try {
      await poll();
    } catch {
      // A backend restart or a dropped request is not the end of the session;
      // the next poll is a couple of seconds away.
    }
  };

  const tick = () => {
    if (!paused) deps.presenter.tick();

    const nowMs = deps.nowMs();
    if (deps.presenter.presentedCount > 0) {
      fallback = reduceFallback(fallback, { kind: "first-frame", atMs: nowMs });
    }
    fallback = reduceFallback(fallback, { kind: "tick", atMs: nowMs });

    if (!paused && deps.audio.starvedBy(deps.presenter.newestPts) > STARVED_SECONDS) {
      fallback = reduceFallback(fallback, { kind: "starved", atMs: nowMs });
      emit("waiting");
    }
    if (fallback.failed) emit("error");
  };

  return {
    async start() {
      post({ type: "open" });
      await safePoll();
      stopPolling = deps.schedule(
        () => { void safePoll(); },
        ((playlist?.targetDuration ?? 6) / 2) * 1000,
      );
      emit("ready");
      emit("playing");
    },

    poll: safePoll,
    tick,

    seek(mediaSeconds: number) {
      // Everything buffered belongs to where playback was, not where it is
      // going: the decoder restarts, the audio queue is dropped, and the
      // presenter's fields go with it.
      seekTarget = mediaSeconds;
      post({ type: "reset" });
      deps.audio.flush();
      deps.presenter.destroy();
      void safePoll();
    },

    pause() {
      paused = true;
      void deps.audio.suspend();
    },

    resume() {
      paused = false;
      void deps.audio.resume();
    },

    setMuted: (muted: boolean) => deps.audio.setMuted(muted),

    get currentTime() {
      return deps.audio.clockSeconds ?? playlistStart();
    },

    get seekable() {
      if (!playlist) return null;
      const { start, end } = playlistWindow(playlist, deps.originMs);
      return end > start ? ([start, end] as const) : null;
    },

    get paused() { return paused; },
    get failure() { return fallback.failed; },

    diagnostics: () => ({
      kind: "wasm",
      presented: deps.presenter.presentedCount,
      queuedFields: deps.presenter.queued,
      newestPts: deps.presenter.newestPts,
      takenThrough,
      failure: fallback.failed,
    }),

    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },

    destroy() {
      stopPolling?.();
      stopPolling = null;
      deps.presenter.destroy();
      post({ type: "close" });
      deps.worker.terminate();
      void deps.audio.destroy();
      handlers.clear();
    },
  };

  /** Where the window starts, for a clock that has not begun yet. */
  function playlistStart(): number {
    if (!playlist) return 0;
    return playlistWindow(playlist, deps.originMs).start;
  }
}
