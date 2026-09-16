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

/** The instant a daypart begins on the local day containing `t`. */
function partStart(t: number, part: Daypart): number {
  const d = new Date(dayStart(t));
  d.setHours(part.hour, 0, 0, 0);
  return d.getTime();
}

/** Where a daypart ends: the next one's start, or the end of the day. */
function partEnd(t: number, index: number): number {
  const next = DAYPARTS[index + 1];
  return next ? partStart(t, next) : dayStart(t) + 24 * HOUR;
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
    const to = from + seconds * 1000;
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

  for (let day = dayStart(startTime); day < endTime; day += 24 * HOUR) {
    // Re-derive from a Date rather than adding 24h repeatedly, so a daylight
    // saving change does not walk the boundary an hour off for every day after.
    const d = new Date(day);
    // The grid's own day, not merely the first row: a day with nothing to jump
    // to is skipped below, and counting rows would move "Today" onto tomorrow.
    const first = day === dayStart(startTime);

    const cells = DAYPARTS.map((part, i) => {
      const at = partStart(d.getTime(), part);
      const ends = partEnd(d.getTime(), i);
      const state: CellState =
        ends <= startTime ? "past"
          : now >= at && now < ends ? "live"
            : !anyCovered(covered, Math.max(at, startTime), Math.min(ends, endTime)) ? "empty"
              : "listed";
      return {
        part,
        // Never behind the grid's own origin: a reachable cell that begins
        // before the timeline does still has to land on the timeline.
        at: Math.max(at, startTime),
        state,
        label: state === "live" ? "NOW" : hourLabel(at),
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
  const d = new Date(at);
  const hour = d.getHours();

  // Before the first daypart of the day, the viewer is in the small hours —
  // which belong to the previous evening's Late block, and read that way.
  const index = DAYPARTS.findLastIndex((p) => hour >= p.hour);
  const part = index === -1 ? DAYPARTS[DAYPARTS.length - 1] : DAYPARTS[index];

  const sameDay = dayStart(at) === dayStart(startTime);
  const day = sameDay ? "Today" : d.toLocaleDateString([], { weekday: "short" });
  return `${day} · ${part.label}`;
}
