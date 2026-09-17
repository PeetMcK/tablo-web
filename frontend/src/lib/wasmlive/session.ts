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
 * Buffered audio at which the field queue is allowed to hold feeding back.
 *
 * Well clear of `MIN_BUFFER_SECONDS`, and that gap is the point. The queue
 * gate below stops the transport when the presenter already has all the fields
 * it can hold; gating it on merely being above the starvation floor makes the
 * floor a set point, and a session sitting on its floor has no margin for a
 * slow device poll. Measured: a soak that held the buffer at exactly 0.5s for
 * eighty-four seconds while drifting from ten seconds behind the live edge to
 * twenty, and then gave up. (The rule it gave up under has since been removed
 * — see `fallback.ts` — but riding the floor is still the wrong place to sit.)
 */
const COMFORTABLE_BUFFER_SECONDS = 1.5;

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
    const growingIsStale = deps.vod?.growing === true
      && seekTarget === null
      && deps.nowMs() - playlistReadAtMs >= GROWING_MAX_AGE_MS;

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
        if (wedged) {
          if (fedThisPoll >= WEDGED_SEGMENTS_PER_POLL) break;
        } else if (fedAhead > limit) break;
        // And whatever the media says, do not decode into a full queue - but
        // only once there is enough sound to keep the clock moving while we
        // wait, because the clock is what drains the queue in the first place.
        if (deps.audio.bufferedSeconds > COMFORTABLE_BUFFER_SECONDS
            && deps.presenter.queued > QUEUE_HIGH_WATER) break;

        // The timeline has a place again, so the seek's own answer is no
        // longer needed.
        if (anchorMedia === null) { anchorMedia = at; seekedTo = null; }
        const bytes = await deps.fetchBytes(segmentUrl(playlist.segments[index].uri));
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
      .catch(() => {
        // A backend restart or a dropped request is not the end of the session;
        // the next poll is a couple of seconds away.
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
          clock: deps.audio.clockSeconds,
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
      queuedFields: deps.presenter.queued,
      newestPts: deps.presenter.newestPts,
      oldestPts: deps.presenter.oldestPts,
      ptsOffset,
      anchorMedia,
      fedThroughMedia,
      takenThrough,
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
