/** Where the playhead may go without waiting on the encoder. */

/**
 * The stretch around `t` that plays immediately.
 *
 * `whole` is true when everything between `start` and `end` is available — a
 * live DVR window, or a recording that is fully cached. Otherwise only the
 * cached island containing `t` counts; standing in a gap, nothing does.
 *
 * The island is closed at both ends, unlike the half-open ranges elsewhere
 * here. A playhead resting exactly on a frontier got there by watching the
 * island up to it and stalling on the window past it — it has not left, and
 * everything behind it is still warm. Excluding that instant stranded the
 * viewer: the range collapsed to a point and both skips were pinned until the
 * encoder finished the next window, a minute of video away.
 */
export function readyRange(
  t: number,
  { ranges, start, end, whole }: {
    ranges: [number, number][];
    start: number;
    end: number;
    whole: boolean;
  },
): [number, number] {
  if (whole) return [start, end];
  const island = ranges.find(([a, b]) => t >= a && t <= b);
  return island
    ? [Math.max(start, island[0]), Math.min(end, island[1])]
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
