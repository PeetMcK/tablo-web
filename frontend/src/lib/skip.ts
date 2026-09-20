/**
 * How far the skip controls jump, remembered per browser.
 *
 * A viewer preference like the volume, not a fact about a programme, so it
 * lives in localStorage rather than on the device. One setting feeds every
 * skip path — the on-screen buttons, the keyboard, the tap zones, and the OS
 * media controls (seek and next/previous track) — so nothing can jump by a
 * stale amount. Callers read it fresh at the moment of the skip; a change made
 * mid-playback takes effect on the very next press.
 */
export const SKIP_FORWARD_STORAGE_KEY = "tablo:skipForward";
export const SKIP_BACK_STORAGE_KEY = "tablo:skipBack";

/** A commercial forward, a missed line back. */
export const SKIP_FORWARD_DEFAULT = 30;
export const SKIP_BACK_DEFAULT = 10;

/** Fired on save so a live-mounted player refreshes its labels — a same-tab
 *  write never raises a `storage` event, which only reaches other tabs. */
export const SKIP_CONFIG_EVENT = "tablo:skipconfig";

const MIN = 1;
const MAX = 600;

/**
 * The one funnel every value passes through: whole seconds within 1..600.
 *
 * A corrupted or hand-edited entry (0, negative, NaN, a huge number) would
 * otherwise make skip do nothing or leap off the end, so it falls back to the
 * direction's default rather than trusting the stored text.
 */
export function clampSkip(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const whole = Math.round(value);
  if (whole < MIN) return fallback;
  return Math.min(MAX, whole);
}

function load(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    return clampSkip(Number.parseFloat(stored), fallback);
  } catch {
    // Private mode and locked-down storage both throw on access.
    return fallback;
  }
}

function save(key: string, value: number, fallback: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(clampSkip(value, fallback)));
    window.dispatchEvent(new CustomEvent(SKIP_CONFIG_EVENT));
  } catch {
    // Nothing to do — the value still holds for this session.
  }
}

export function loadSkipForward(): number {
  return load(SKIP_FORWARD_STORAGE_KEY, SKIP_FORWARD_DEFAULT);
}

export function loadSkipBack(): number {
  return load(SKIP_BACK_STORAGE_KEY, SKIP_BACK_DEFAULT);
}

export function saveSkipForward(value: number): void {
  save(SKIP_FORWARD_STORAGE_KEY, value, SKIP_FORWARD_DEFAULT);
}

export function saveSkipBack(value: number): void {
  save(SKIP_BACK_STORAGE_KEY, value, SKIP_BACK_DEFAULT);
}
