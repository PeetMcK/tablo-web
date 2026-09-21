/**
 * One live WASM playback session.
 *
 * Owns the loop that ties the pieces together: the ring playlist is polled,
 * new segments go to the worker, decoded frames go to the presenter and the
 * sink, and the fallback machine watches for the whole thing failing to keep
 * up. Everything it touches is injected, so this file is about sequencing and
 * nothing else.
 */

import { log } from "../debug";
import { initialFallbackState, reduceFallback } from "./fallback";
import type { FallbackState } from "./fallback";
import { MAX_QUEUED_FRAMES } from "./frameQueue";
import { createSegmentSupply } from "./supply";
import { parseMediaPlaylist, playlistWindow, segmentAt, startNearEdge } from "./playlist";
import type { MediaPlaylist } from "./playlist";
import type { AudioSink } from "./audioSink";
import type { Presenter } from "./presenter";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";
import type { FromWorker, ToWorker } from "./workerProtocol";

/**
 * How long a picture that was playing may stop dead before the channel goes
 * back to the transcode.
 *
 * Generous: a rebuffer is not a failure, and the fallback costs a tuner change.
 * But a still picture with no end is worse than either, and it is what a
 * stopped clock produces.
 */
const FROZEN_MS = 6000;

/**
 * How long the picture may hold with fields still in hand before it is worth a
 * line in the log. Three field periods at 59.94, so ordinary jitter is quiet.
 */
const HELD_MS = 100;

/** How often to report where the fields went. */
const ROLLUP_MS = 5000;

/**
 * How much decoded media to keep ahead of the clock.
 *
 * Decode runs at about 8x realtime, so without a limit the session swallows
 * the ring's whole backlog in a few seconds and the presenter's queue fills
 * with fields the clock will not reach for a minute. Everything then evicts
 * before it can be shown.
 *
 * This must stay comfortably under what the field queue holds, or the queue is
 * permanently full and evicting in normal running. At 59.94 fields a second,
 * two seconds is about 120 of the 200 it can keep.
 *
 * It also has to cover the lag between handing bytes over and getting decoded
 * audio back, because that lag comes out of the buffer. At 1.25s the measured
 * buffer oscillated between 0.54s and 0.97s - repeatedly grazing the 0.5s
 * starvation floor, with the field queue swinging from 33 to 59 and no margin
 * anywhere.
 */
export const LOOKAHEAD_SECONDS = 2;

/**
 * Below this much buffered audio, fetch past the ordinary lookahead.
 *
 * The escape hatch from the deadlock: the playhead only advances while audio
 * renders, so if the buffer ever empties the clock freezes, the lookahead
 * looks satisfied for ever, and nothing is fetched again. An empty buffer is
 * always a reason to fetch.
 */
const MIN_BUFFER_SECONDS = 0.5;

/**
 * Segments a poll may feed while the clock is stopped for want of sound.
 *
 * Enough to restart it, few enough that startup - where the buffer is empty
 * for the same reason - cannot swallow the window while decode is in flight.
 */
const WEDGED_SEGMENTS_PER_POLL = 2;

/**
 * How far ahead it may feed while the buffer is empty.
 *
 * Bounded, and that bound is the point. An empty buffer used to bypass pacing
 * outright, and at startup the buffer is empty by definition — so the first
 * poll fed the ring's entire primed window in one pass. The audio sink keeps
 * everything it is given, so the worklet ended up holding six seconds; the
 * field queue can only hold two and refused the rest, so video ran dry and
 * never recovered while audio played on. Measured: 5.7s buffered, 181 chunks
 * queued in the worklet, and video fields a second behind the clock.
 *
 * Enough audio to restart a frozen clock is a second or two, not a window.
 * It is bounded at both ends: above the ordinary lookahead, or the escape does
 * nothing at all, and no higher than the field queue can hold, or relieving
 * starvation causes it somewhere else.
 */
export const STARVED_LOOKAHEAD_SECONDS = 2.5;

/**
 * How full the field queue may be before the transport stops feeding.
 *
 * Pacing on media alone is not enough, because the decoder is not paced by it:
 * a segment handed over becomes forty-five frames in about fifty milliseconds,
 * and those ninety field presentations land on a queue that was draining. Once
 * it reaches its cap the excess is refused, and refused fields are gone - which
 * leaves a hole in the timeline rather than merely a short queue. Measured: a
 * burst of 74 frames against a 150 field cap, then presentation stopping dead
 * for 300ms with 104 fields queued and the oldest of them 0.286s in the future,
 * because the clock had to cross the gap the refusal made.
 *
 * Holding the segment back instead costs nothing: it stays in the ring, on
 * disk, where it already is.
 *
 * The room left has to be a whole segment's worth, not a fraction of the
 * queue. The unit the transport deals in is one segment, and this device's
 * longest run to about 1.8s - sixty frames, a hundred and twenty field
 * presentations. Gating at six tenths of the cap still let a burst land on
 * ninety and overflow; leaving less than a burst's room does the same, and
 * leaving too much starves the sound. Both were measured.
 */
const SEGMENT_FIELDS = 120;
const QUEUE_HIGH_WATER = Math.max(0, MAX_QUEUED_FRAMES - SEGMENT_FIELDS);

/**
 * How much of the window to start behind the live edge.
 *
 * Live means live: starting at the oldest segment the ring still holds would
 * put the viewer a minute behind before they had seen a frame. But three
 * seconds was riding the edge of the data. The ring gains segments in lumps -
 * the follower polls the device on its own schedule and each segment fetch off
 * this device takes the better part of a second - so three seconds of runway
 * is spent by one slow poll, and playback then waits on the device rather than
 * on anything we control. Repeated often enough, that is what the fallback's
 * starvation rule is for, and it duly fired.
 *
 * Ten seconds is still ahead of where viewers sit today: the transcode path
 * carries about twelve seconds of encoder lead, which is what this design set
 * out to claw back.
 */
const START_BEHIND_EDGE_SECONDS = 10;

/**
 * How often to ask the ring what it has gained.
 *
 * Fixed, and deliberately shorter than the lookahead. This used to be half the
 * playlist's target duration, which for this device's ring is 1.5s — longer
 * than the 1.25s of media the lookahead permits, so every cycle fed a quarter
 * of a second less than playback consumed and the queue drained to empty
 * between polls. Measured: audio pinned at the 0.5s starvation floor, 13
 * fields queued, and the clock running 4% slow from underruns.
 *
 * It is cheap. The ring is served by our own backend over the loopback, and
 * the device is polled separately by the follower, so this costs nothing that
 * a slower interval would save.
 */
export const POLL_INTERVAL_MS = 500;

/**
 * How stale a growing recording's index may be before a poll re-reads it.
 *
 * Only the *end* of a recording moves, and only forwards, so the cost of being
 * a few seconds behind it is a scrubber that lags the frontier by a few
 * seconds. The cost of being current is a 70KB fetch and parse in the path that
 * feeds the decoder — which is what starved it. Well above the 500ms poll, and
 * above the backend's own 3s refresh floor, so a read that does happen is
 * usually answered from what the backend already holds.
 */
export const GROWING_MAX_AGE_MS = 8000;

/**
 * How long the worker gets to free its decoder before it is terminated anyway.
 *
 * Generous enough for a `close` that has to drain a read in flight, short
 * enough that a worker wedged inside libav — the failure that started all of
 * this — cannot keep its thread alive after the session is gone.
 */
export const CLOSE_GRACE_MS = 2000;

/**
 * How long silence at the end of a finished index has to last to be the end.
 *
 * Short enough to be invisible against the last frame, long enough to outlast
 * one decode: a seek landing in the final segment looks exactly like an ending
 * until its audio arrives, and without this it would end the recording at the
 * moment the viewer jumped to it.
 */
export const ENDED_STILL_MS = 400;

/**
 * Buffered audio at or below which the sound has run out.
 *
 * Not exactly zero. The worklet reports every 4800 frames — a tenth of a second
 * — so the accounting can come to rest on a residue smaller than one report and
 * stay there, and an ending gated on a hard zero would then never arrive. A
 * tenth of a second is also below anything a viewer could notice being cut.
 *
 * Safe only in company: mid-recording the buffer dips under this routinely, and
 * what makes it mean "the end" is that every segment of a finished index has
 * already been fed and the silence has lasted `ENDED_STILL_MS`.
 */
export const ENDED_QUIET_SECONDS = 0.1;

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
  /**
   * Set for a finished recording, which is a fixed index rather than a window.
   *
   * Three things differ and nothing else does: the playlist is fetched once
   * because it carries EXT-X-ENDLIST and will never change, playback starts at
   * the beginning rather than near the live edge, and the seekable range is the
   * recording's real duration rather than what has been fetched so far.
   *
   * Feeding, pacing, the epoch, the field queue and the fallback are the live
   * path's, untouched — a seek already tears the decoder down and rebuilds it
   * at a new epoch, which is exactly what seeking in a recording needs.
   */
  vod?: {
    durationSeconds: number;
    /**
     * The recording is still being written, so the index grows behind it.
     *
     * Only two things change: the playlist is re-read on every poll, and the
     * seekable end comes from that playlist rather than from the length at
     * open. Where it *starts* is the same either way — at the beginning, which
     * is the point of the whole path.
     */
    growing?: boolean;
  };
}

export type SessionEvent =
  | "ready" | "timeupdate" | "waiting" | "playing" | "ended" | "error";

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
  /** The level, 0..1, held apart from mute — see the sink. */
  setVolume(volume: number): void;
  readonly volume: number;
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

  /**
   * Segments on their way, ahead of the decoder.
   *
   * The transport takes from here rather than from the network, so a slow
   * device round trip no longer lands on the audio buffer. Pacing below is
   * unchanged and still governs how far *decode* runs ahead; this governs how
   * far *fetching* does, which is bounded by bytes rather than raw planes and
   * can therefore be much further.
   */
  const supply = createSegmentSupply({ fetchBytes: deps.fetchBytes });

  let playlist: MediaPlaylist | null = null;
  /** When `playlist` was last read, for the growing case's staleness check. */
  let playlistReadAtMs = 0;
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
  /** Whether the worker's script ran at all, as opposed to the decoder opening. */
  let workerBooted = false;
  /** Whether any audio has ever arrived, which separates startup from a stall. */
  let sawAudio = false;
  /**
   * Which side of the last seek we are on.
   *
   * Bumped by `seek`, stamped on every segment sent and checked on every piece
   * of media that comes back. It replaces a flag that was set from the seek
   * until the worker acknowledged it, and which covered only half the race:
   * messages already in flight *from the worker*, never fetches already in
   * flight *from the page*.
   */
  let epoch = 0;
  /** For the frozen-picture watchdog, which is now the only failure detector. */
  let lastPresentedCount = 0;
  let lastProgressAtMs = 0;
  /** Whether the presenter currently has nothing to draw. */
  let wasStalled = false;
  /** Whether the picture is currently holding with fields still queued. */
  let wasHeld = false;
  /**
   * Where the last rollup was taken from, so the next one reports a rate.
   *
   * Null rather than zero: `nowMs` is `performance.now()` in the app but zero
   * in a test harness, and a zero sentinel there means the mark is re-taken on
   * every tick and no interval ever elapses.
   */
  let rollupAtMs: number | null = null;
  let rollupMark = { presented: 0, skipped: 0, dropped: 0, ticks: 0 };
  /** The worker's last word on what the decoder is doing. */
  let decoderStats: Record<string, unknown> | null = null;
  /**
   * What actually went wrong, as opposed to which rule tripped.
   *
   * The fallback machine records a category — "decode error", "no first frame"
   * — which is enough to fail over and useless for finding out why. This keeps
   * the message beside it.
   */
  let failureDetail: string | null = null;
  /** So the per-frame tick reports a failure once rather than sixty times a second. */
  let failureLogged = false;
  let paused = false;
  let stopPolling: (() => void) | null = null;
  let seekTarget: number | null = null;
  /**
   * Where the last seek asked to go, held until the clock catches up.
   *
   * Distinct from `seekTarget`, which a poll consumes the moment it resolves a
   * segment — long before any audio renders. Without this, `currentTime` fell
   * through to `playlistStart()` in the window between, which for a recording
   * is zero: a seek near the end reported the playhead at the beginning.
   *
   * That is not cosmetic. The skip buttons read `currentTime` to decide where
   * to jump from, so a tap landing in that window computed `0 + 30` and threw
   * a viewer at 31:12 back to 0:30. Seen when a rebuilt decoder failed to
   * open, which leaves the clock unanchored indefinitely rather than for a
   * few hundred milliseconds.
   */
  let seekedTo: number | null = null;
  /** So the end is announced once rather than on every animation frame. */
  let announcedEnd = false;
  /** Since when the end has looked like the end — see the check in `tick`. */
  let endStillSinceMs: number | null = null;

  /**
   * Every segment the index names has been handed to the decoder.
   *
   * The state nothing could see, and the reason every recording died at its
   * end. The watchdog below measures presentations, so a decoder that has run
   * out of media and a decoder that has wedged produce the identical
   * observation — and six seconds later the session was failed as a decode
   * error, reported as one, and handed to a rebuild that fed the lone short
   * final fragment to a fresh demuxer, which cannot probe on it.
   */
  function fedToTheEnd(): boolean {
    if (playlist === null || playlist.segments.length === 0) return false;
    return takenThrough >= playlist.mediaSequence + playlist.segments.length - 1;
  }

  /**
   * Whether a failed request means the backend has forgotten this session.
   *
   * `open.ts` throws `playlist 404` and `segment 404` with the status in the
   * message, which is the only thing that crosses this boundary. Matched on
   * the status alone: 404 is the single answer that will never become an
   * answer, because the only thing that could restore a session is opening a
   * new one. A 502 is the device blinking and a 503 is it busy - both worth
   * asking again for.
   */
  function sessionGone(e: unknown): boolean {
    return e instanceof Error && / 404$/.test(e.message);
  }

  /**
   * And the index is final, so there will never be another segment.
   *
   * `EXT-X-ENDLIST` is the whole of the difference between an ending and a
   * wait. A recording still being written reaches the end of its index all the
   * time — that is what catching up to the device looks like — and gains the
   * tag only once the device has finished.
   */
  function atTheEnd(): boolean {
    return fedToTheEnd() && (playlist!.endList || (!!deps.vod && !deps.vod.growing));
  }

  deps.worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    // Media from before the last seek belongs to where playback was. Audio
    // especially: it anchors the clock, so one stale chunk landing after the
    // flush puts the playhead back where the viewer just left while frames
    // arrive from where they went. Measured on a press of Back 10s: "starved
    // by 12.32s" twice in the same millisecond, and the channel handed back to
    // the transcode before a single new frame was drawn.
    //
    // Only media is filtered. An error or a set of counters from the old
    // decoder still describes something that went wrong, and dropping it would
    // hide the failure rather than the position.
    if ((message.type === "video" || message.type === "audio") && message.epoch !== epoch) {
      return;
    }
    if (message.type === "reset") {
      log.wasm(`decoder rebuilt at epoch ${message.epoch}`);
      return;
    }
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
      if (chunks.length) sawAudio = true;
      for (const chunk of chunks) deps.audio.push(chunk);
      return;
    }
    if (message.type === "booted") {
      workerBooted = true;
      log.wasm("worker booted");
      return;
    }
    if (message.type === "opened") {
      log.wasm("decoder opened");
      return;
    }
    if (message.type === "stats") {
      const stats = message.stats;
      // Logged on the transitions only. Every segment carries these, and a line
      // per segment would bury the two moments that matter in a scroll of noise.
      if (!decoderStats || (decoderStats as { opened?: boolean }).opened !== stats.opened) {
        log.wasm(`decoder ${stats.opened ? "open" : "not open"}`, stats);
      } else if (!(decoderStats as { videoFrames?: number }).videoFrames && stats.videoFrames) {
        log.wasm(`first frames decoded`, stats);
      }
      // Said on the rise, not on arrival. The decoder drops a refused batch
      // and keeps going — that is what makes a damaged recording playable —
      // but a drop nobody sees is a decision made on the viewer's behalf and
      // never reported. Tied to the counts moving so it stays one line per
      // spot of damage rather than one per segment.
      const before = decoderStats as { videoDropped?: number; audioDropped?: number } | null;
      const droppedBefore = (before?.videoDropped ?? 0) + (before?.audioDropped ?? 0);
      const droppedNow = (stats.videoDropped ?? 0) + (stats.audioDropped ?? 0);
      if (droppedNow > droppedBefore) {
        log.warn(`damaged batch dropped — decoding continues`, stats);
      }
      decoderStats = stats as unknown as Record<string, unknown>;
      return;
    }
    if (message.type === "error") {
      log.warn(`wasm decoder error: ${message.message}`, decoderStats);
      failureDetail = message.message;
      fallback = reduceFallback(fallback, { kind: "decode-error" });
      emit("error");
    }
  };

  // A worker that fails to load says nothing through `onmessage` — no frames,
  // no audio, no error — which is the same silence a broken decoder produces
  // and used to be indistinguishable from it. A module worker whose script or
  // wasm asset 404s lands here and nowhere else.
  deps.worker.onerror = (event: ErrorEvent | Event) => {
    failureDetail = (event as ErrorEvent).message || "worker failed to load";
    log.warn(`wasm worker error: ${failureDetail}`, { workerBooted });
    // Only a worker that never got as far as saying "booted" failed to
    // initialise. One that has been running for a minute and then throws is a
    // decode failure wearing the wrong label, and the label is what anyone
    // reads first when working out why a channel fell back.
    fallback = reduceFallback(fallback, {
      kind: workerBooted ? "decode-error" : "init-failed",
    });
    emit("error");
  };
  deps.worker.onmessageerror = () => {
    failureDetail = "worker message could not be deserialised";
    fallback = reduceFallback(fallback, { kind: "decode-error" });
    emit("error");
  };

  /** Resolve a segment uri against the playlist it came from. */
  const segmentUrl = (uri: string) =>
    deps.playlistUrl.replace(/[^/]*$/, "") + uri;

  const poll = async () => {
    // The epoch this poll belongs to, captured before the first await.
    //
    // Every await below is a place a seek can happen, and a poll that resumes
    // afterwards is working from the old position: its `takenThrough`, its
    // `anchorMedia` and the bytes it is holding all belong to where playback
    // was. Checking after each one is the page-side half of the seek race —
    // the worker-side half is the epoch stamped on what comes back.
    const mine = epoch;

    // A finished recording's index is complete and fixed — it carries
    // EXT-X-ENDLIST — so it is read once and never again. The timer still runs,
    // because it is what drives feeding as the clock advances; it is only the
    // fetch that is pointless. The live path re-reads every time because its
    // window slides.
    //
    // A recording still being written has to be re-read, because the device
    // keeps appending — but on its own clock, never on this one. Re-reading it
    // every poll is what killed it: measured, the backend's refresh of the
    // device's playlist takes ~330ms and the body is 70KB, so one poll in six
    // stalled a third of a second and parsed 70KB before it could feed. Feeding
    // never got ahead of playback — 11.5s of media in 10s of wall clock — the
    // picture froze, and the frozen-picture watchdog called it a decode error
    // and fell the session back to the transcode about fifteen seconds in.
    //
    // A seek never waits on it at all. The seek target is inside what is
    // already held, because `seekable` is derived from it, so nothing about a
    // fresh read can change where the seek lands — it would only add latency to
    // the one operation that must feel instant.
    // Except when it has been fed to the end of what it holds, which is the
    // one moment the age is the wrong question. A viewer who catches up to the
    // frontier is waiting on a segment that only a re-read can reveal, and the
    // staleness window is 8s against a watchdog that gives up after 6 — so
    // watching a programme as it records, which is the point of this path, was
    // a guaranteed death two seconds before the index would next be read.
    const growingIsStale = deps.vod?.growing === true
      && seekTarget === null
      && (fedToTheEnd()
        || deps.nowMs() - playlistReadAtMs >= GROWING_MAX_AGE_MS);

    if (!deps.vod || playlist === null || growingIsStale) {
      const text = await deps.fetchText(deps.playlistUrl);
      if (mine !== epoch) return;
      playlist = parseMediaPlaylist(text);
      playlistReadAtMs = deps.nowMs();
    }
    if (playlist === null) return;
    const { start: windowStart } = playlistWindow(playlist, deps.originMs);

    // After a seek, start again from the segment covering the target.
    if (seekTarget !== null) {
      // A target the window cannot place falls back to the live edge, never to
      // the front of the window. `takenThrough = -1` used to mean the latter,
      // and it also skipped the `else if` below — so a seek past the end fed
      // from `mediaSequence` and took the viewer up to an hour backwards.
      const at = segmentAt(playlist, deps.originMs, seekTarget)
        ?? startNearEdge(playlist, START_BEHIND_EDGE_SECONDS);
      takenThrough = at ? at.sequence - 1 : -1;
      seekTarget = null;
      // Bytes fetched for where the viewer used to be are worthless, and
      // harmful if they arrive afterwards and are treated as current.
      supply.reset();
    } else if (takenThrough < 0 && deps.vod) {
      // A recording has a beginning, and that is where it starts. Joining near
      // the edge is a live behaviour: it exists so a viewer is not a minute
      // behind the broadcast, which means nothing for something already
      // recorded.
      takenThrough = playlist.mediaSequence - 1;
    } else if (takenThrough < 0) {
      // Opening: begin near the live edge, counted back from the newest
      // segment rather than looked up by media time. A primed ring fetches the
      // device's whole backlog at once, so its timestamps compress forty
      // seconds of media into a moment and a media-time target lands far
      // behind live - which had every fresh session replaying the same content
      // twenty-five seconds late.
      const at = startNearEdge(playlist, START_BEHIND_EDGE_SECONDS);
      if (at) takenThrough = at.sequence - 1;
    }

    // What is coming, so bytes can be on their way while the decoder is still
    // chewing the last segment. This is a plan, not a command: the supply
    // decides how far ahead to run and stops at its own ceilings.
    // Bound to a const: `playlist` is a `let` the closure below cannot be
    // shown to keep non-null.
    const current = playlist;
    supply.advise(
      current.segments.flatMap((segment, index) => {
        const sequence = current.mediaSequence + index;
        return sequence > takenThrough
          ? [{
              sequence,
              url: segmentUrl(segment.uri),
              durationSeconds: segment.duration,
            }]
          : [];
      }),
    );

    // Where the decoder has already been fed up to, in media seconds.
    let at = windowStart;
    let fedThisPoll = 0;
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
        // Starvation widens the lookahead; it does not remove it.
        const starving = deps.audio.bufferedSeconds < MIN_BUFFER_SECONDS;
        const limit = starving ? STARVED_LOOKAHEAD_SECONDS : LOOKAHEAD_SECONDS;

        // Except when the sound has run out entirely, which is the one state
        // the lookahead cannot be trusted in: the clock only moves while audio
        // renders, so an empty buffer freezes it, `fedAhead` is then measured
        // against a stopped clock and stays over its limit for ever, and
        // nothing is fetched again. Measured: a session wedged at buffered 0
        // with 78 fields queued and not one drawn for forty-six seconds - and
        // no fallback, because a stopped clock is never ahead of anything for
        // the starvation rule to notice.
        //
        // Feeding a bounded amount per poll breaks the cycle without letting
        // startup, where the buffer is also empty, swallow the window.
        const wedged = sawAudio && deps.audio.bufferedSeconds <= 0;
        // An empty field queue is starvation as surely as an empty audio
        // buffer, and until now only the audio had an escape: with no fields
        // at all the transport still waited for `fedAhead` to fall under the
        // lookahead, which is why a video stall lasted the better part of a
        // second — 0.86s and 1.26s measured on 2026-09-17 — rather than
        // ending the moment more media arrived. Feeding is what refills the
        // queue, so refusing to feed while it is empty is the one case the
        // lookahead must not govern.
        // Guarded on having drawn something: at startup the queue is empty by
        // definition, and bypassing pacing there is how the whole primed
        // window used to be swallowed in one pass.
        const videoDry = deps.presenter.presentedCount > 0 && deps.presenter.queued === 0;
        if (wedged || videoDry) {
          if (fedThisPoll >= WEDGED_SEGMENTS_PER_POLL) break;
        } else if (fedAhead > limit) break;
        // And whatever the media says, do not decode into a full queue: the
        // queue refuses what it cannot hold, and a refused field is a hole in
        // the timeline rather than merely a short queue.
        //
        // This used to require a comfortable audio buffer before it would
        // hold anything back, so that relieving audio starvation could not be
        // blocked by a full queue. But the gate was then unarmed exactly when
        // the buffer sits between the floor and comfortable — which, since
        // segments started arriving from the supply rather than from the
        // network, is where it now sits most of the time. The floor is the
        // right threshold: below it the clock is at risk of stopping and
        // sound wins; at or above it, destroying fields to decode more is a
        // straight loss.
        //
        // (The old threshold was a `COMFORTABLE_BUFFER_SECONDS` of 1.5,
        // chosen so a session could not sit on its starvation floor as a set
        // point. That concern belongs to the audio escape above, which is
        // where it now lives; it never had anything to do with the queue.)
        if (deps.audio.bufferedSeconds >= MIN_BUFFER_SECONDS
            && deps.presenter.queued > QUEUE_HIGH_WATER) break;

        // The timeline has a place again, so the seek's own answer is no
        // longer needed.
        if (anchorMedia === null) { anchorMedia = at; seekedTo = null; }
        const bytes = await supply.take(
          sequence, segmentUrl(playlist.segments[index].uri),
        );
        // The seek race, in the one place it actually bites: this fetch was
        // outstanding when the viewer pressed Back 10s, so the worker would
        // receive `reset` and *then* this segment from before it. Its audio
        // would set the clock's origin to the old position, every new frame
        // would read ten seconds early, and the session would fall back to the
        // transcode before drawing anything.
        if (mine !== epoch) return;
        log.wasm(`fed segment ${sequence}`, {
          bytes: bytes.byteLength,
          mediaFrom: Number(at.toFixed(2)),
          clock: mediaClock() === null ? null : Number(mediaClock()!.toFixed(2)),
          // The pacing decision itself, and the quantity it is meant to
          // approximate. They measure the same thing - media handed over
          // against media played - so they have to agree, and a live run where
          // one read 1.25s while the other read 5.7s is how this was found.
          fedAhead: Number(fedAhead.toFixed(2)),
          buffered: Number(deps.audio.bufferedSeconds.toFixed(2)),
          anchorMedia: anchorMedia === null ? null : Number(anchorMedia.toFixed(2)),
          rawClock: deps.audio.clockSeconds === null
            ? null : Number(deps.audio.clockSeconds.toFixed(2)),
          ptsOffset: ptsOffset === null ? null : Number(ptsOffset.toFixed(3)),
          queuedFields: deps.presenter.queued,
          presented: deps.presenter.presentedCount,
        });
        post({ type: "segment", bytes, epoch }, [bytes]);
        takenThrough = sequence;
        fedThisPoll += 1;
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
  /** Polls queued or running, so the timer does not pile up behind a slow one. */
  let pollsQueued = 0;

  const safePoll = () => {
    pollsQueued += 1;
    pollChain = pollChain
      .then(() => poll())
      .catch((e: unknown) => {
        // A dropped request is not the end of the session; the next poll is a
        // couple of seconds away.
        //
        // A 404 from our own backend is. Sessions live in memory, so a backend
        // restart or the 120s idle reaper removes one out from under a player
        // still holding its playlist, and every request after that answers 404
        // for ever. Retrying that quietly is what left thousands of
        // `/api/vod/{session}/NNNNN.ts` 404s in the console: nothing could
        // succeed, so `takenThrough` never advanced, so every poll asked for
        // the same segments again.
        if (sessionGone(e)) {
          failureDetail = String((e as Error)?.message ?? e);
          fallback = reduceFallback(fallback, { kind: "session-gone" });
        }
      })
      .finally(() => { pollsQueued -= 1; });
    return pollChain;
  };

  /**
   * The timer's poll, which gives up its turn if one is already in flight.
   *
   * The chain is what stops two polls claiming the same segments, but on its
   * own it only defers the work: a poll that outlasts the interval — remote
   * access, a proxied backend, one slow segment — leaves the next tick queued
   * behind it, and the one after that, without bound. A seek still enqueues
   * unconditionally, because a seek must always be acted on.
   */
  const scheduledPoll = () => {
    // A failed session must not keep polling. Once the fallback machine has
    // latched a failure (a decode error, no first frame, a gone backend), the
    // surface is on its way to being torn down or rebuilt; continuing to ask
    // the backend for segments it no longer has is the 404 storm. Stop the
    // timer here so the storm cannot outlive the failure even for the window
    // before the surface is destroyed.
    if (fallback.failed) {
      stopPolling?.();
      stopPolling = null;
      return;
    }
    if (pollsQueued > 0) return;
    void safePoll();
  };

  const tick = () => {
    if (!paused) deps.presenter.tick();

    const nowMs = deps.nowMs();
    if (deps.presenter.presentedCount > 0) {
      fallback = reduceFallback(fallback, { kind: "first-frame", atMs: nowMs });
    }

    // Neither timer may run while the audio context is not rendering.
    //
    // A suspended context renders no samples, so the clock never advances, so
    // no field is ever due and nothing is ever presented — which is exactly
    // what a broken decoder looks like from here. The session duly failed with
    // "no first frame" after eight seconds, before the viewer had a chance to
    // click. The context starts suspended whenever there is no user activation
    // behind it: a deep link, a tab opened in the background, or a first visit
    // under Chrome's autoplay policy.
    //
    // Held rather than skipped, for the same reason as the pause below: the
    // first tick after the context starts must not look back over the whole
    // wait and call it a stall.
    if (deps.audio.contextState !== "running") {
      fallback = { ...fallback, startedAtMs: nowMs };
      lastProgressAtMs = nowMs;
      return;
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

    // Whether there is anything left to draw, reported as a state rather than
    // as an event.
    //
    // A rebuffer is not a failure — the old rule ended the session on two
    // consecutive animation frames — and it is not permanent either. `waiting`
    // used to be emitted with no matching `playing`, and the stall overlay
    // clears only on `playing`, so a single spurious event pinned "stalled" on
    // screen until the session was replaced. A state has both edges by
    // construction.
    const stalled = !paused && sawAudio && deps.presenter.queued === 0;
    if (stalled !== wasStalled) {
      wasStalled = stalled;
      if (stalled) {
        log.warn("waiting for fields", {
          // The raw sink clock. Media time is this plus `ptsOffset`, which is
          // what every other line logs — comparing the two as though they were
          // the same quantity reads as a three-second clock jump that is not
          // happening.
          rawClock: deps.audio.clockSeconds,
          clock: mediaClock(),
          ptsOffset,
          // Animation frames stop in a hidden or fully occluded window, and
          // while they are stopped the queue fills and every further field is
          // refused. A long gap here says nobody was asking to draw; a short
          // one says the decoder produced nothing.
          msSinceTick: Math.round(deps.presenter.msSinceTick),
          visibility: typeof document === "undefined" ? null : document.visibilityState,
          droppedFields: deps.presenter.droppedCount,
          // Fields passed over, and chances to draw. Together with `presented`
          // these say whether the picture was behind because nothing arrived or
          // because nobody was asking.
          skippedFields: deps.presenter.skippedCount,
          ticks: deps.presenter.tickCount,
          // How far the clock has run past the newest field. Useful here, as a
          // description of a stall that has already been detected some other
          // way; useless as the detector, which is what it used to be.
          aheadOfNewest: Number(deps.audio.starvedBy(deps.presenter.newestPts).toFixed(2)),
          buffered: Number(deps.audio.bufferedSeconds.toFixed(2)),
          fedThroughMedia,
          presented: deps.presenter.presentedCount,
        });
      }
      emit(stalled ? "waiting" : "playing");
    }

    // The stall above fires on an empty queue, and a hole in the middle of a
    // segment does not empty the queue: it leaves it full of fields whose
    // moment has not come. The clock runs, nothing is due, the picture holds,
    // and until now the only thing that ever noticed was the six-second
    // watchdog — by which point the session had already been failed over.
    //
    // No `emit()`. This is not a stall as far as the viewer is concerned, and
    // raising the overlay for a quarter-second hole would be worse than the
    // hole.
    const held = !paused && sawAudio && deps.presenter.nothingDueMs > HELD_MS;
    if (held !== wasHeld) {
      wasHeld = held;
      if (held) {
        log.warn("picture held", {
          heldMs: Math.round(deps.presenter.nothingDueMs),
          queued: deps.presenter.queued,
          oldestPts: deps.presenter.oldestPts,
          newestPts: deps.presenter.newestPts,
          // Raw sink clock and media time, both named, because they are what
          // the queued timestamps and the rest of the log respectively speak.
          rawClock: deps.audio.clockSeconds,
          clock: mediaClock(),
          ptsOffset,
          msSinceTick: Math.round(deps.presenter.msSinceTick),
          buffered: Number(deps.audio.bufferedSeconds.toFixed(2)),
          fedThroughMedia,
        });
      }
    }

    // A stopped clock is the one failure starvation cannot see: it measures how
    // far the clock has outrun the newest frame, and a clock that is not moving
    // never outruns anything. A session wedged at buffered zero with a full
    // queue therefore sat there indefinitely, showing a still picture, with
    // nothing to hand the channel back to the transcode.
    if (paused) {
      // A pause is not a freeze, and the difference is the whole point of the
      // watchdog. Held rather than merely skipped: leaving the mark where it
      // was means the first tick after resuming looks back over however long
      // the viewer sat paused and calls it a stall, which fell the session
      // back to the transcode on every resume more than six seconds later.
      lastProgressAtMs = nowMs;
    } else if (deps.vod && fedToTheEnd()) {
      // Nor is running out of media, and for the same reason: the watchdog
      // asks whether the decoder is still drawing, and a decoder with nothing
      // left to draw answers no. Held rather than skipped, so that a viewer who
      // seeks back out of the end is not immediately judged on however long
      // they sat at it.
      //
      // Only for a recording. A live ring is re-read every poll and playback
      // trails its edge by ten seconds, so reaching the end of the index there
      // means the device has genuinely stopped producing — which is the failure
      // this watchdog is live's only detector for.
      //
      // The cost is that a decoder wedging inside the final segment goes
      // unnoticed. One segment, against failing every recording that plays to
      // its end.
      lastProgressAtMs = nowMs;
    } else if (deps.presenter.presentedCount > 0) {
      if (deps.presenter.presentedCount !== lastPresentedCount) {
        lastPresentedCount = deps.presenter.presentedCount;
        lastProgressAtMs = nowMs;
      } else if (nowMs - lastProgressAtMs > FROZEN_MS) {
        failureDetail =
          `nothing drawn for ${Math.round((nowMs - lastProgressAtMs) / 1000)}s` +
          ` (queued ${deps.presenter.queued}, buffered ${deps.audio.bufferedSeconds.toFixed(1)}s)`;
        fallback = reduceFallback(fallback, { kind: "decode-error" });
      }
    }
    // The recording is over: nothing left to feed, and nothing left to hear.
    //
    // Both, because the first on its own is a lie. The last segment is handed
    // over a second or two before the viewer hears it, and announcing the end
    // there would cut off precisely the part someone watched the programme for.
    //
    // Sound is what says it is over, and *not* an empty field queue, which
    // sounds like the obvious test and can never happen here. The clock is
    // derived from samples the worklet has rendered, so when audio runs out the
    // clock stops — and the presenter is then left holding the handful of
    // fields whose timestamps lie past where it stopped, for ever. Measured on
    // a 3:55:13 recording: it reached the end, held there correctly, and never
    // said so, because `queued` was waiting to reach a zero it could not.
    //
    // Drawing rather than sound is what says playback happened at all: a
    // recording with no audio track buffers nothing from its first frame to its
    // last, and would otherwise never be allowed to end. A decoder that drew
    // nothing is a different thing entirely, and the first-frame deadline above
    // already has it.
    const drained = !paused
      && atTheEnd()
      && deps.presenter.presentedCount > 0
      && mediaClock() !== null
      && deps.audio.bufferedSeconds <= ENDED_QUIET_SECONDS;
    if (!drained) {
      endStillSinceMs = null;
    } else {
      // Held for a moment first. A seek that lands in the last segment passes
      // every test above while its decode is still in flight — fed to the end,
      // drawn before, and momentarily silent — and announcing an end there
      // would end the recording as the viewer arrived at it. Audio coming back
      // clears this; audio that never comes back is the end.
      endStillSinceMs ??= nowMs;
      if (!announcedEnd && nowMs - endStillSinceMs >= ENDED_STILL_MS) {
        announcedEnd = true;
        log.player("recording ended", {
          at: Number((mediaClock() ?? 0).toFixed(2)),
          takenThrough,
          presented: deps.presenter.presentedCount,
          // Fields the stopped clock will never reach. Expected, and small;
          // worth seeing if it is ever neither.
          stranded: deps.presenter.queued,
        });
        emit("ended");
      }
    }

    // Once, not sixty times a second. `emit("error")` used to fire on every
    // animation frame for the rest of the session, and the same flag that
    // already keeps the log line to one occurrence serves for both.
    if (fallback.failed && !failureLogged) {
      failureLogged = true;
      log.warn(`wasm session failed: ${fallback.failed}`, {
        detail: failureDetail,
        workerBooted,
        decoder: decoderStats,
        fedThroughMedia,
        takenThrough,
        presented: deps.presenter.presentedCount,
        buffered: deps.audio.bufferedSeconds,
      });
      emit("error");
    }

    // Where the fields went, as rates rather than as totals.
    //
    // Every real finding in this area came from a number pasted into the
    // conversation; every wrong one came from reasoning about a log that
    // lacked it. `presented` on its own counts ticks that drew, not fields
    // consumed, and reading it as a field rate is how "the presenter is
    // drawing a thirtieth of what it should" survived a whole evening on the
    // strength of a number that had never measured that.
    //
    // `ticks` against `drawn + skipped` is the question the rest cannot
    // answer: animation frames stop entirely in a hidden or fully occluded
    // window — an undocked DevTools window over the player is enough, which is
    // how these logs get read in the first place.
    if (rollupAtMs === null) {
      rollupAtMs = nowMs;
    } else if (nowMs - rollupAtMs >= ROLLUP_MS) {
      const span = (nowMs - rollupAtMs) / 1000;
      const per = (n: number) => Math.round(n / span);
      log.wasm("fields", {
        drawn: per(deps.presenter.presentedCount - rollupMark.presented),
        skipped: per(deps.presenter.skippedCount - rollupMark.skipped),
        refused: per(deps.presenter.droppedCount - rollupMark.dropped),
        ticks: per(deps.presenter.tickCount - rollupMark.ticks),
        queued: deps.presenter.queued,
        buffered: Number(deps.audio.bufferedSeconds.toFixed(2)),
      });
      rollupAtMs = nowMs;
      rollupMark = {
        presented: deps.presenter.presentedCount,
        skipped: deps.presenter.skippedCount,
        dropped: deps.presenter.droppedCount,
        ticks: deps.presenter.tickCount,
      };
    }
  };

  return {
    async start() {
      log.wasm("session starting", { playlistUrl: deps.playlistUrl, originMs: deps.originMs });
      post({ type: "open" });
      // The clock only advances while audio is being rendered, so a suspended
      // context is a frozen picture rather than merely a silent one.
      void deps.audio.resume();
      await safePoll();
      stopPolling = deps.schedule(scheduledPoll, POLL_INTERVAL_MS);
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
      seekedTo = mediaSeconds;
      // Seeking back out of the end un-ends it, so playing to the end a second
      // time says so a second time.
      announcedEnd = false;
      endStillSinceMs = null;
      // The decoder restarts, so the timeline it emits does too: both the
      // anchor and the offset have to be re-derived from the next segment.
      ptsOffset = null;
      anchorMedia = null;
      fedThroughMedia = null;
      // Bumped before the reset is posted, so a poll already awaiting a fetch
      // abandons what it is holding rather than sending it on afterwards.
      epoch += 1;
      post({ type: "reset", epoch });
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

    setVolume: (volume: number) => deps.audio.setVolume(volume),
    get volume() { return deps.audio.volume; },

    get currentTime() {
      // `seekedTo` sits above `playlistStart()` so that a seek whose decoder
      // has not yet produced anything reports where it was sent, not the front
      // of the recording.
      return mediaClock() ?? anchorMedia ?? seekedTo ?? playlistStart();
    },

    get seekable() {
      // A recording's range is its whole runtime, known up front from the
      // index — not the part that happens to have been fetched. That is what
      // lets the scrubber show 215 minutes and a seek land anywhere in them.
      //
      // One still being written has no whole runtime yet: its end is wherever
      // the device has got to, which the playlist reports and which grows under
      // a viewer who is watching from the start. Pinning it to the length at
      // open would fence off everything recorded since. `durationSeconds` still
      // covers the moment before the first playlist arrives.
      if (deps.vod?.growing) {
        if (!playlist) return [0, deps.vod.durationSeconds] as const;
        const { end } = playlistWindow(playlist, deps.originMs);
        return [0, Math.max(end, deps.vod.durationSeconds)] as const;
      }
      if (deps.vod) return [0, deps.vod.durationSeconds] as const;
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
      droppedFields: deps.presenter.droppedCount,
      skippedFields: deps.presenter.skippedCount,
      ticks: deps.presenter.tickCount,
      msSinceTick: Math.round(deps.presenter.msSinceTick),
      heldMs: Math.round(deps.presenter.nothingDueMs),
      queuedFields: deps.presenter.queued,
      newestPts: deps.presenter.newestPts,
      oldestPts: deps.presenter.oldestPts,
      ptsOffset,
      anchorMedia,
      fedThroughMedia,
      takenThrough,
      // Whether the transport is waiting on the network or on its own pacing.
      // Answering that took a temporary instrumented build on 2026-09-17; it
      // should not need one again.
      supplyHeldSeconds: supply.heldSeconds,
      supplyHeldBytes: supply.heldBytes,
      supplyInFlight: supply.inFlight,
      failure: fallback.failed,
      failureDetail,
      workerBooted,
      // What the decoder itself says. Null here means the worker has never
      // answered — a different problem from a decoder that answered badly,
      // and `workerBooted` says which.
      decoder: decoderStats,
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

      // Let the worker free its decoder before the thread goes.
      //
      // This posted `close` and called `terminate()` on the next line, which
      // kills the thread before it dequeues the message — so `close` never ran
      // and everything inside it was dead code that had never once executed in
      // production. Terminating does reclaim the thread's memory either way,
      // which is why nothing was visibly wrong; it is also why this is cheap
      // to do properly.
      let terminated = false;
      const finish = () => {
        if (terminated) return;
        terminated = true;
        deps.worker.terminate();
      };
      deps.worker.onmessage = (event: MessageEvent<FromWorker>) => {
        if (event.data?.type === "closed") finish();
      };
      post({ type: "close" });
      // And a deadline, because a worker wedged inside libav would otherwise
      // never be terminated at all.
      setTimeout(finish, CLOSE_GRACE_MS);

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
