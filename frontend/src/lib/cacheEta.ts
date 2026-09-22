/**
 * How long an offline copy still has to run, in seconds.
 *
 * `realtime` is output seconds produced per wall second — the same number the
 * card shows as "5.5×" — which makes this the remaining *content* divided by
 * it. Deliberately not derived from Mb/s: that varies with the bitrate of
 * whatever is being copied, while this does not.
 *
 * Null where there is no honest answer: nothing has been produced yet, so
 * there is no rate, or the recording's length is unknown. An invented estimate
 * reads as knowledge and is worse than an empty space.
 */
export function cacheEta(
  duration: number,
  cachedSeconds: number,
  realtime: number,
): number | null {
  if (!(duration > 0) || !(realtime > 0)) return null;
  // Windows overrun their nominal length, so what is cached can pass the
  // recording's duration; that is finished, not negative time remaining.
  return Math.max(0, duration - cachedSeconds) / realtime;
}
