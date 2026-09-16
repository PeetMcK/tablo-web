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

/**
 * How much decoded media to keep ahead of the clock.
 *
 * Decode runs at about 8x realtime, so without a limit the session swallows
 * the ring's whole backlog in a few seconds and the presenter's queue fills
 * with fields the clock will not reach for a minute. Everything then evicts
 * before it can be shown. A few seconds is enough to ride out a slow fetch and
 * shallow enough that the queue holds what is about to be drawn.
 */
const LOOKAHEAD_SECONDS = 2;

/**
 * Below this much buffered audio, fetch regardless of the lookahead.
 *
 * The escape hatch from the deadlock: the playhead only advances while audio
 * renders, so if the buffer ever empties the clock freezes, the lookahead
 * looks satisfied for ever, and nothing is fetched again. An empty buffer is
 * always a reason to fetch.
 */
const MIN_BUFFER_SECONDS = 0.5;

/**
 * How much of the window to start behind the live edge.
 *
 * Live means live: starting at the oldest segment the ring still holds would
 * put the viewer a minute behind before they had seen a frame. One segment of
 * lead-in is enough to have something decoded when playback begins.
 */
const START_BEHIND_EDGE_SECONDS = 3;

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
  /**
   * What to add to a decoded timestamp to get media time.
   *
   * Frames and audio carry the device's own PTS timeline, which starts
   * wherever the broadcast happens to be; the ring's window is seconds since
   * this session opened. Those are different clocks, and comparing them
   * directly — which is what the first live run did — makes the playhead and
   * the seekable range disagree by however far apart the two origins are.
   */
  let ptsOffset: number | null = null;
  /** Media time of the first segment fed since the last reset. */
  let anchorMedia: number | null = null;
  /** Media time the decoder has been fed up to, which paces fetching. */
  let fedThroughMedia: number | null = null;
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
      const chunks = message.chunks as DecodedAudioChunk[];
      // The first chunk after opening or seeking ties the device's timeline to
      // the ring's: everything the player reads is in media time from here on.
      if (ptsOffset === null && anchorMedia !== null && chunks.length) {
        ptsOffset = anchorMedia - chunks[0].ptsSeconds;
      }
      for (const chunk of chunks) deps.audio.push(chunk);
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
    const { start: windowStart, end: windowEnd } = playlistWindow(playlist, deps.originMs);

    // After a seek, start again from the segment covering the target.
    if (seekTarget !== null) {
      const at = segmentAt(playlist, deps.originMs, seekTarget);
      takenThrough = at ? at.sequence - 1 : -1;
      seekTarget = null;
    } else if (takenThrough < 0) {
      // Opening: begin near the live edge rather than at the oldest thing the
      // ring still holds.
      const target = Math.max(windowStart, windowEnd - START_BEHIND_EDGE_SECONDS);
      const at = segmentAt(playlist, deps.originMs, target);
      if (at) takenThrough = at.sequence - 1;
    }

    // Where the decoder has already been fed up to, in media seconds.
    let at = windowStart;
    for (let index = 0; index < playlist.segments.length; index++) {
      const sequence = playlist.mediaSequence + index;
      const duration = playlist.segments[index].duration;

      if (sequence > takenThrough) {
        // Paced on media handed to the decoder against media already played,
        // not on decoded audio waiting in the sink: decoding lags fetching, so
        // pacing on the sink's depth over-fetches by however long decode takes
        // and the field queue fills with video seconds ahead of the sound.
        //
        // The buffer floor is the escape hatch. Without it this deadlocks: the
        // playhead only moves while audio renders, so an empty buffer freezes
        // the clock, the lookahead then looks satisfied for ever, and nothing
        // is ever fetched again.
        const clock = mediaClock() ?? anchorMedia ?? at;
        const fedAhead = fedThroughMedia === null ? 0 : fedThroughMedia - clock;
        const starving = deps.audio.bufferedSeconds < MIN_BUFFER_SECONDS;
        if (!starving && fedAhead > LOOKAHEAD_SECONDS) break;

        if (anchorMedia === null) anchorMedia = at;
        const bytes = await deps.fetchBytes(segmentUrl(playlist.segments[index].uri));
        post({ type: "segment", bytes }, [bytes]);
        takenThrough = sequence;
        fedThroughMedia = at + duration;
      }
      at += duration;
    }
    emit("timeupdate");
  };

  /**
   * One poll at a time, in order.
   *
   * `takenThrough` only advances after a fetch resolves, so two polls running
   * at once — the timer and a seek, say — both see the same segments as new
   * and fetch every one of them twice: double the device load and double the
   * decode, for nothing.
   */
  let pollChain: Promise<void> = Promise.resolve();

  const safePoll = () => {
    pollChain = pollChain.then(() => poll()).catch(() => {
      // A backend restart or a dropped request is not the end of the session;
      // the next poll is a couple of seconds away.
    });
    return pollChain;
  };

  const tick = () => {
    if (!paused) deps.presenter.tick();

    const nowMs = deps.nowMs();
    if (deps.presenter.presentedCount > 0) {
      fallback = reduceFallback(fallback, { kind: "first-frame", atMs: nowMs });
    }

    // The deadline measures the decoder, not the device. A freshly opened ring
    // is empty for the first few seconds — the same wait the transcode path
    // budgets twelve seconds for — so the clock only starts once there is
    // something to decode. Counting from the open gave up before the first
    // segment had even been written.
    if (fedThroughMedia === null) {
      fallback = { ...fallback, startedAtMs: nowMs };
      return;
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
      // The clock only advances while audio is being rendered, so a suspended
      // context is a frozen picture rather than merely a silent one.
      void deps.audio.resume();
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
      // The decoder restarts, so the timeline it emits does too: both the
      // anchor and the offset have to be re-derived from the next segment.
      ptsOffset = null;
      anchorMedia = null;
      fedThroughMedia = null;
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
      return mediaClock() ?? anchorMedia ?? playlistStart();
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
      ...deps.audio.diagnostics(),
      presented: deps.presenter.presentedCount,
      queuedFields: deps.presenter.queued,
      newestPts: deps.presenter.newestPts,
      oldestPts: deps.presenter.oldestPts,
      ptsOffset,
      anchorMedia,
      fedThroughMedia,
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

  /** The playhead in media time, or null before audio has started. */
  function mediaClock(): number | null {
    const clock = deps.audio.clockSeconds;
    if (clock === null) return null;
    return clock + (ptsOffset ?? 0);
  }
}
