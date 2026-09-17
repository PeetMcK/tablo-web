/** Where the playhead may go without waiting on the encoder. */

/**
 * Ranges this close together are one range.
 *
 * Segment boundaries do not line up to the sample, so the cache's report and
 * the browser's buffer meet a few milliseconds apart even when they describe
 * touching media. hls.js treats a tenth of a second as no hole at all
 * (`maxBufferHole`); matching it keeps one continuous run from reading as two.
 */
const JOIN = 0.1;

/** Overlapping or touching ranges, flattened and sorted. */
function merge(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a - last[1] <= JOIN) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The stretch around `t` that plays immediately.
 *
 * `whole` is true when everything between `start` and `end` is available — a
 * live DVR window, or a recording that is fully cached. Both are served off
 * disk whether or not they happen to be buffered, so the whole span counts and
 * narrowing it to the buffer would only take away rewind that already works.
 *
 * Otherwise it is the run containing `t` across two sources that each know
 * something the other does not. `ranges` is the encoder's report: authoritative
 * about the far side of the recording, but it grows a whole 60s window at a
 * time and arrives on a 3s poll. `buffered` is what the browser holds right
 * now: the only account that is never stale, and the definition of instant.
 *
 * Trusting the report alone stranded the viewer. The playlist names every
 * segment of the recording, so hls.js reads minutes ahead and the backend
 * transcodes each cold window on demand — playback sails past the last window
 * the report knows about without ever stalling. For most of the minute that
 * followed, the report placed the playhead nowhere, the run collapsed to a
 * point, and every skip was pinned in both directions while the video played
 * on.
 *
 * The run is closed at both ends. A playhead resting exactly on a frontier got
 * there by watching up to it and stalling on what lies past it; it has not
 * left, and everything behind it is still warm.
 */
export function readyRange(
  t: number,
  { ranges, buffered = [], start, end, whole }: {
    ranges: [number, number][];
    buffered?: [number, number][];
    start: number;
    end: number;
    whole: boolean;
  },
): [number, number] {
  if (whole) return [start, end];
  const run = merge([...ranges, ...buffered]).find(([a, b]) => t >= a && t <= b);
  return run
    ? [Math.max(start, run[0]), Math.min(end, run[1])]
    : [t, t];
}

/** One HLS segment, matching the backend's `HLS_TIME` and `SEGMENT_SECONDS`. */
export const SEGMENT_SECONDS = 6;

/**
 * How far short of a settled end a clamped jump lands, in seconds.
 *
 * `hi` is the last instant that exists. Seeking exactly onto it runs the
 * playhead off the end of the media, so a jump that would overshoot stops just
 * inside. Nothing more is needed where `hi` is a real ending — a recording
 * that finished encoding is on disk to its last frame, and a wider cushion
 * would only fence off the closing seconds.
 */
const EDGE_MARGIN = 0.5;

/**
 * How far short of a *frontier* a clamped jump lands, in seconds.
 *
 * A live edge is not an end, it is the furthest the encoder has got. It
 * advances one segment at a time, a segment apart, so a playhead parked just
 * inside it plays for a moment and then waits — which is exactly what a skip
 * is supposed to never do. Half a second of cushion bought half a second of
 * video; the viewer tapped forward, hit the edge, and watched the encoder work
 * for two to four seconds at a time.
 *
 * Wider than a segment on purpose. Landing exactly one behind leaves no slack
 * for a segment that takes a moment longer than its own duration to appear,
 * and the frontier would swallow the playhead again on the first hiccup.
 */
export const LIVE_EDGE_MARGIN = 10;

/**
 * How far short of a recording's end a skip stops.
 *
 * Not the same question as the live margin. A seek on the MPEG-2 path rebuilds
 * the decoder, and a rebuilt decoder needs real media to produce its first
 * field. Landing on the last fraction of a second gives it none: measured on a
 * 21:23 recording whose final segment begins at 1282.98, a skip clamped to
 * within half a second fed exactly that segment, drew nothing, and six seconds
 * later the watchdog called it a decode error.
 *
 * Set by eye against the thing itself. Five seconds was tried first and read
 * as stopping short of the end; this is close enough to feel like the end
 * while still leaving the decoder something. It is under one segment, so the
 * decode failure above is not fully ruled out - what makes that survivable is
 * that the transcode fallback now resumes where the wasm session was rather
 * than at the first frame.
 */
export const RECORDING_EDGE_MARGIN = 1.5;

/**
 * Within this many seconds of the frontier counts as "at the live edge".
 *
 * Must stay wider than `LIVE_EDGE_MARGIN`. Go Live and a clamped forward skip
 * both land a margin short of the edge, and if that landing did not itself
 * read as live the badge would light up again the instant it arrived — the
 * button offering to make a jump it has just made.
 */
export const LIVE_EDGE_THRESHOLD = 12;

/**
 * A jump of `delta` seconds from `from`, held inside `[lo, hi]`.
 *
 * A skip is meant to be instant, so it stops at the last playable moment rather
 * than landing past the encoder or past the live edge. Going somewhere cold on
 * purpose is the scrubber's job.
 *
 * `margin` says what kind of thing `hi` is: pass `LIVE_EDGE_MARGIN` when it is
 * a frontier still being produced, and leave it alone when it is a settled end.
 * Overshooting returns the same landing spot every time, so a caller can tell
 * a skip that goes nowhere from one that moves.
 *
 * A skip never travels against its own direction. The playhead can already be
 * inside the margin — on live it usually is, because playback chases an edge
 * that is only ever seconds ahead — and clamping to a frontier that sits
 * behind it turned a tap on Forward into a rewind of several seconds.
 */
export function clampSkip(
  from: number,
  delta: number,
  [lo, hi]: [number, number],
  margin: number = EDGE_MARGIN,
): number {
  const target = from + delta;
  const landing = target <= lo ? lo
    : target >= hi ? Math.max(lo, hi - margin)
    : target;
  return delta > 0 ? Math.max(from, landing) : Math.min(from, landing);
}

/**
 * How long the skip buttons wait for the next tap before committing.
 *
 * Long enough to gather a deliberate burst, short enough that a single tap
 * still feels immediate. The picture does not wait on it: the timecode and the
 * scrubber move to the pending target the instant a tap lands, and only the
 * decoder is held back.
 */
export const SKIP_DEBOUNCE_MS = 400;

/**
 * Where a queued run of skips has got to.
 *
 * Taps accumulate from the *pending* target rather than from the playhead,
 * which is the whole point: a seek is asynchronous, so `currentTime` has not
 * moved when the second tap of a burst arrives. Chaining from it made twenty
 * taps of Forward 30 land thirty seconds away instead of ten minutes, and
 * bought twenty decoder rebuilds on the way - each one a teardown, a flushed
 * audio queue and a black frame.
 *
 * Clamping happens per tap, so the target can never run past either boundary
 * and a turnaround starts from where it actually landed rather than from the
 * phantom position the taps asked for. Pressing into a clamped edge returns the
 * same value every time, which is how a caller tells a skip that moves from one
 * that goes nowhere.
 *
 * Pass `pending` as null when no burst is in flight.
 */
export function planSkip(
  pending: number | null,
  currentTime: number,
  delta: number,
  range: [number, number],
  margin?: number,
): number {
  return clampSkip(pending ?? currentTime, delta, range, margin);
}

/**
 * Ties the media timeline to the wall clock.
 *
 * A live stream's `currentTime` counts from the start of its FFmpeg session,
 * while an airing is scheduled in wall-clock time. One reading of both — taken
 * the moment a playlist first exists — converts between them forever after:
 * the two advance at the same rate, and the encoder's lag is a constant this
 * absorbs.
 *
 * Captured once on purpose. Re-reading the clock every render would jitter the
 * bar by however long ago it last ticked.
 */
export interface LiveAnchor {
  wallMs: number;
  media: number;
}

/** What the media clock reads at a wall-clock instant. */
export function mediaAt(wallMs: number, anchor: LiveAnchor): number {
  return anchor.media + (wallMs - anchor.wallMs) / 1000;
}

/** An airing, as much of one as any of this needs. */
export interface Scheduled {
  start?: string | null;
  duration?: number | null;
}

/** Epoch milliseconds of an airing's start, or null if it has no usable one. */
function startMs(airing: Scheduled | null | undefined): number | null {
  if (!airing?.start) return null;
  const ms = new Date(airing.start).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The airing's span in media seconds — what the live scrubber is drawn over.
 *
 * Negative numbers are expected and correct: an airing that began before the
 * stream did starts before the session's own zero, which is exactly the part
 * the viewer missed. Null whenever the window cannot be known, which is the
 * signal to fall back to the DVR window instead of guessing one.
 */
export function programWindow(
  airing: Scheduled | null | undefined,
  anchor: LiveAnchor | null,
): [number, number] | null {
  if (!anchor) return null;
  const ms = startMs(airing);
  const duration = airing?.duration ?? 0;
  if (ms === null || !(duration > 0)) return null;
  const start = mediaAt(ms, anchor);
  return [start, start + duration];
}

/**
 * Whether an airing is on at `wallMs`.
 *
 * Half-open at the end, so the instant a programme ends belongs to the one
 * starting there — which is what rolls the bar over at the top of the hour. An
 * airing with no usable start or duration is on at no time at all, which is the
 * signal to fall back to the DVR bar.
 */
export function covers(airing: Scheduled | null | undefined, wallMs: number): boolean {
  const ms = startMs(airing);
  const duration = airing?.duration ?? 0;
  if (ms === null || !(duration > 0)) return false;
  return wallMs >= ms && wallMs < ms + duration * 1000;
}

/**
 * The airing covering `wallMs`, or null.
 *
 * Order is not assumed; the mirror sorts, but a caller need not.
 */
export function airingAt<T extends Scheduled>(airings: T[], wallMs: number): T | null {
  for (const airing of airings) if (covers(airing, wallMs)) return airing;
  return null;
}
