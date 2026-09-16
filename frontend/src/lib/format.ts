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
