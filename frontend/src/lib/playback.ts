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

/**
 * How far short of the frontier a clamped jump lands, in seconds.
 *
 * `hi` is the first instant that does *not* exist yet — the range is half-open,
 * the way `readyRange` tests it. Seeking exactly there stalls on the very
 * window the clamp exists to avoid, so a jump that would overshoot stops just
 * inside instead.
 */
const EDGE_MARGIN = 0.5;

/**
 * A jump of `delta` seconds from `from`, held inside `[lo, hi]`.
 *
 * A skip is meant to be instant, so it stops at the last playable moment rather
 * than landing past the encoder or past the live edge. Going somewhere cold on
 * purpose is the scrubber's job.
 */
export function clampSkip(from: number, delta: number, [lo, hi]: [number, number]): number {
  const target = from + delta;
  if (target <= lo) return lo;
  if (target >= hi) return Math.max(lo, hi - EDGE_MARGIN);
  return target;
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
