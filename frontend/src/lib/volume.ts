/**
 * The playback level, remembered per browser.
 *
 * A device preference rather than a fact about a programme, so it lives in
 * localStorage beside the theme rather than on the server beside resume
 * positions: the right level depends on the speakers in front of you, and
 * carrying one machine's choice to another would be wrong more often than
 * right.
 *
 * Kept separate from mute, which the element already tracks. Zero here is a
 * level a viewer chose; muted is the sound being switched off with that level
 * held for when it comes back.
 */
export const VOLUME_STORAGE_KEY = "tablo:volume";

/** Anyone who never chose gets all of it, as every player does. */
const DEFAULT_VOLUME = 1;

/**
 * The one funnel every level passes through, doing two jobs.
 *
 * It clamps, because `video.volume` throws an IndexSizeError outside 0..1: a
 * corrupted or hand-edited entry would break playback rather than merely
 * sound wrong.
 *
 * And it quantises to whole hundredths, because binary floats do not add up
 * to the step they are made of — twelve presses of a twentieth arrives at
 * 0.39999999999999963, which was then stored verbatim. Rounding here rather
 * than at each caller means the next one to add a way of changing the level
 * does not have to rediscover it.
 */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

export function loadVolume(): number {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  try {
    const stored = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    if (stored === null) return DEFAULT_VOLUME;
    return clampVolume(Number.parseFloat(stored));
  } catch {
    // Private mode and locked-down storage both throw on access.
    return DEFAULT_VOLUME;
  }
}

export function saveVolume(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(clampVolume(value)));
  } catch {
    // Nothing to do — the level still holds for this session.
  }
}
