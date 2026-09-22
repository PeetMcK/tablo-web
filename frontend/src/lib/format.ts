/**
 * Display formatting shared by the library cards.
 *
 * Lives outside the component so it can be tested directly: a component module
 * that also exports a plain function trips react-refresh's
 * `only-export-components`, which would cost fast refresh for the whole view.
 */

/** Space that never becomes a line break. */
const NBSP = " ";

/**
 * One colour per weekday, indexed by `Date.getDay()` — Sunday first.
 *
 * Fixed rather than alternating, so a day always looks the same wherever it
 * lands in the list. Red is deliberately absent: it means destructive here, and
 * a heading is not a warning.
 */
export const DAY_COLORS = [
  "#a78bfa", // Sunday — violet
  "#478cc9", // Monday — blue, the brand swatch
  "#22d3ee", // Tuesday — cyan
  "#34d399", // Wednesday — green
  "#fbbf24", // Thursday — amber
  "#fb923c", // Friday — orange
  "#f472b6", // Saturday — pink
] as const;

/** The colour for the day `iso` falls on. */
export function dayColor(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DAY_COLORS[0] : DAY_COLORS[d.getDay()];
}

/**
 * Local calendar day of `iso`, as `2026-09-14`.
 *
 * Built from the local parts rather than `toISOString`, which would shift a
 * late-evening recording into the next day for anyone west of UTC — exactly the
 * recordings a "what aired last night" list is made of.
 */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Heading for a day of recordings, as `Monday 9/14`. */
export function formatDayHeading(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const weekday = d.toLocaleDateString([], { weekday: "long" });
  return `${weekday} ${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * When a recording aired, as `9/13/2026 2:25 PM`.
 *
 * The date and the time are each tied together with non-breaking spaces, so the
 * single ordinary space between them is the only place the stamp can wrap. The
 * cards are narrow enough to need one, and left alone the browser took the last
 * opportunity instead of the sensible one - stranding "PM" on a line by itself
 * under the time it belongs to. Tying the date matters too: plenty of locales
 * spell it "13 Sep 2026", which would otherwise come apart in three places.
 */
export function formatAired(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString().replace(/\s/g, NBSP);
  const time = d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    // Recent ICU separates the meridiem with U+202F, not a plain space, so
    // match on whitespace generally rather than on " ".
    .replace(/\s/g, NBSP);
  return `${date} ${time}`;
}

/**
 * Runtime as `1h 0m`, matching LibraryView's own rendering.
 *
 * Lowercase h/m deliberately: in a metadata row of uppercase-ish tokens,
 * `1H 0M` reads as units of something other than time.
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
