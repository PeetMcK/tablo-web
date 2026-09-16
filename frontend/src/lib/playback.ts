/** Where the playhead may go without waiting on the encoder. */

/**
 * The stretch around `t` that plays immediately.
 *
 * `whole` is true when everything between `start` and `end` is available — a
 * live DVR window, or a recording that is fully cached. Otherwise only the
 * cached island containing `t` counts; standing in a gap, nothing does.
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
  const island = ranges.find(([a, b]) => t >= a && t < b);
  return island
    ? [Math.max(start, island[0]), Math.min(end, island[1])]
    : [t, t];
}

/**
 * A jump of `delta` seconds from `from`, held inside `[lo, hi]`.
 *
 * A skip is meant to be instant, so it stops at the last playable moment rather
 * than landing past the encoder or past the live edge. Going somewhere cold on
 * purpose is the scrubber's job.
 */
export function clampSkip(from: number, delta: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, from + delta));
}
