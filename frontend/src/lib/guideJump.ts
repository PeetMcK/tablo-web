/**
 * Where the guide can jump to.
 *
 * The timeline is 400px an hour, so a day is about seven screens wide and a
 * control that only picks a date leaves most of the scrolling to do. The unit
 * people actually ask in is a stretch of a day — "Thursday evening" — so that
 * is the unit offered: every day the guide holds, crossed with four dayparts.
 *
 * Wall-clock throughout. A daypart is a human idea about a local day, not an
 * offset from an epoch, so every boundary here is built from local date parts.
 */

const HOUR = 3600_000;

/** How much of one airing is worth walking hour by hour. See `coveredHours`. */
const MAX_AIRING_HOURS = 14 * 24;

export interface Daypart {
  id: string;
  label: string;
  /** Local hour the stretch begins at. */
  hour: number;
}

/**
 * Prime starts at 7, not 8. A jump puts its target hour at the left edge and
 * the viewer reads forward from there, so landing on 7 leaves the 8 o'clock
 * hour on screen with its run-up; landing on 8 hides everything before it.
 *
 * Late runs to the next day's Morning rather than to midnight, so the small
 * hours belong to the evening they followed. Ending it at midnight left
 * 00:00-06:00 in no daypart at all: an overnight film could not be jumped to
 * from anywhere, and the button read "Late" at a position no cell could reach.
 */
export const DAYPARTS: Daypart[] = [
  { id: "morning", label: "Morning", hour: 6 },
  { id: "afternoon", label: "Afternoon", hour: 12 },
  { id: "prime", label: "Prime", hour: 19 },
  { id: "late", label: "Late", hour: 23 },
];

export type CellState = "past" | "empty" | "live" | "listed";

export interface JumpCell {
  part: Daypart;
  /** The instant this cell scrolls to. */
  at: number;
  state: CellState;
  /** What the cell reads: the hour it lands on, or NOW. */
  label: string;
}

export interface JumpDay {
  key: string;
  /** "Today", "Wed", "Thu" … */
  label: string;
  /** "9/16" */
  date: string;
  cells: JumpCell[];
}

/** Midnight at the start of `t`'s local day. */
function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Midnight at the start of the local day after `t`'s.
 *
 * Stepping the date rather than adding 24h: a local day is 23 or 25 hours long
 * either side of a daylight saving change, and an epoch day is always 24.
 */
function nextDayStart(t: number): number {
  const d = new Date(dayStart(t));
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The instant a daypart begins on the local day containing `t`. */
function partStart(t: number, part: Daypart): number {
  const d = new Date(dayStart(t));
  d.setHours(part.hour, 0, 0, 0);
  return d.getTime();
}

/** Where a daypart ends: the next one's start, or tomorrow's first. */
function partEnd(t: number, index: number): number {
  const next = DAYPARTS[index + 1];
  if (next) return partStart(t, next);
  // The last block runs past midnight into the small hours, which belong to
  // the evening before them and not to a morning that has not begun.
  return partStart(nextDayStart(t), DAYPARTS[0]);
}

/**
 * The hours these airings occupy, as hour-epochs.
 *
 * Read from the listings already in memory — the grid derives how far it runs
 * from the same data, so the two cannot disagree about where the guide ends.
 */
export function coveredHours(
  airings: { start?: string | null; duration?: number | null }[],
): Set<number> {
  const covered = new Set<number>();
  for (const airing of airings) {
    if (!airing.start) continue;
    const from = new Date(airing.start).getTime();
    const seconds = airing.duration ?? 0;
    if (Number.isNaN(from) || !(seconds > 0)) continue;
    // Bounded, because the loop below is per hour and the duration comes from
    // the device: a corrupt one would spin for millions of iterations on the
    // render path. Nothing the guide holds runs for a fortnight.
    const to = from + Math.min(seconds, MAX_AIRING_HOURS * 3600) * 1000;
    for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) covered.add(h);
  }
  return covered;
}

/** True when any hour between `from` and `to` carries a listing. */
function anyCovered(covered: Set<number>, from: number, to: number): boolean {
  for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) {
    if (covered.has(h)) return true;
  }
  return false;
}

function hourLabel(t: number): string {
  return new Date(t)
    .toLocaleTimeString([], { hour: "numeric" })
    .replace(/\s/g, "")
    .toLowerCase();
}

/**
 * One row per day the guide covers, each with a cell per daypart.
 *
 * A cell is only offered when it can be reached and there is something there:
 * the timeline starts at the current hour and runs forward, so anything
 * earlier is `past`, and a stretch no airing overlaps is `empty`. Both are
 * drawn, not hidden — a gap the viewer can see is information, and a control
 * that looks live but does nothing is worse than one that says it cannot.
 */
export function jumpDays({ startTime, totalHours, covered, now }: {
  startTime: number;
  totalHours: number;
  covered: Set<number>;
  now: number;
}): JumpDay[] {
  const endTime = startTime + totalHours * HOUR;
  const days: JumpDay[] = [];

  // Step the local date rather than adding 24h repeatedly: a daylight saving
  // change makes the local day 23 or 25 hours long, and the epoch arithmetic
  // walked the boundary an hour off for every day after it - which listed the
  // changeover day twice, once from its own midnight and once from 23:00.
  for (let day = dayStart(startTime); day < endTime; day = nextDayStart(day)) {
    const d = new Date(day);
    // The grid's own day, not merely the first row: a day with nothing to jump
    // to is skipped below, and counting rows would move "Today" onto tomorrow.
    const first = day === dayStart(startTime);

    const cells = DAYPARTS.map((part, i) => {
      const begins = partStart(day, part);
      const ends = partEnd(day, i);
      // Never behind the grid's own origin: a reachable cell that begins
      // before the timeline does still has to land on the timeline.
      const at = Math.max(begins, startTime);
      const state: CellState =
        ends <= startTime ? "past"
          : now >= at && now < ends ? "live"
            : !anyCovered(covered, at, Math.min(ends, endTime)) ? "empty"
              : "listed";
      return {
        part,
        at,
        state,
        // A cell that jumps is labelled with the hour it lands on, which is
        // not the daypart's own hour once the clamp above has moved it. A
        // dead cell jumps nowhere, so it keeps naming its daypart.
        label: state === "live" ? "NOW" : hourLabel(state === "listed" ? at : begins),
      };
    });

    // A day with nothing to jump to is not a row. The guide's last day usually
    // ends mid-morning, and a date that offers four dead cells reads as a
    // broken control rather than as the edge of the listings.
    if (!cells.some((c) => c.state === "listed" || c.state === "live")) continue;

    days.push({
      key: String(day),
      label: first ? "Today" : d.toLocaleDateString([], { weekday: "short" }),
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      cells,
    });
  }

  return days;
}

/**
 * What the trigger button reads for a scroll position — "Thu · Prime".
 *
 * The guide has never said where along itself it is; this is the only place
 * that answers it, which is half of what the control is for.
 */
export function positionLabel(
  startTime: number,
  offsetPx: number,
  hourWidth: number,
): string {
  const at = startTime + (offsetPx / hourWidth) * HOUR;
  const hour = new Date(at).getHours();

  // Before the day's first daypart the viewer is in the small hours, which
  // belong to the evening before them — the same block whose cell jumps here.
  // The day has to move back with the part, or the button names Wednesday
  // while the cell that reaches this hour sits in Tuesday's row.
  const small = hour < DAYPARTS[0].hour;
  const part = small
    ? DAYPARTS[DAYPARTS.length - 1]
    : DAYPARTS[DAYPARTS.findLastIndex((p) => hour >= p.hour)];
  const owning = small ? dayStart(at) - HOUR : at;

  const day = dayStart(owning) === dayStart(startTime)
    ? "Today"
    : new Date(owning).toLocaleDateString([], { weekday: "short" });
  return `${day} · ${part.label}`;
}
