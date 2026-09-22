/**
 * How the Library arranges what it holds: what the cards are grouped under,
 * and what order they come in.
 *
 * Pure, and apart from the view for the reason `series.ts` is: the rules are
 * the part with consequences, and they are worth reading without a component
 * around them.
 */
import {
  ArrowDownAZ, ArrowUpAZ, CalendarDays, Clock3, History, Layers, Radio,
  type LucideIcon,
} from "lucide-react";

import { dayKey, formatDayHeading } from "./format";
import { seriesKey } from "./series";

export type LibraryGroup = "day" | "show" | "channel";
export type LibrarySort = "newest" | "oldest" | "title" | "title-desc";

export interface LayoutOption<T extends string> {
  id: T;
  label: string;
  Icon: LucideIcon;
}

/** The groupings the menu offers, in the order it offers them. */
export const LIBRARY_GROUPS: LayoutOption<LibraryGroup>[] = [
  { id: "day",     label: "Day",     Icon: CalendarDays },
  { id: "show",    label: "Show",    Icon: Layers },
  { id: "channel", label: "Channel", Icon: Radio },
];

/** The orders the menu offers. */
export const LIBRARY_SORTS: LayoutOption<LibrarySort>[] = [
  { id: "newest",     label: "Newest",  Icon: Clock3 },
  { id: "oldest",     label: "Oldest",  Icon: History },
  { id: "title",      label: "A–Z",     Icon: ArrowDownAZ },
  { id: "title-desc", label: "Z–A",     Icon: ArrowUpAZ },
];

/** What the Library needs of a recording to arrange it. */
export interface Arrangeable {
  object_id: number;
  title: string | null;
  subtitle: string | null;
  start: string;
  series_path: string | null;
  sport_path: string | null;
  channel: { call_sign: string | null; number: string | null } | null;
}

/** One heading and the cards under it. */
export interface LibrarySection<T> {
  /** Stable across renders and unique within the page — React's key. */
  key: string;
  /** What the heading reads. */
  label: string;
  /**
   * A recording from this section whose `start` tints the heading, or null
   * where a tint would be a lie.
   *
   * Only a day is one colour: every card under "MONDAY 9/21" aired that day.
   * A show or a channel spans weeks, so colouring its rule by the first card's
   * weekday would be picking a colour at random.
   */
  tintFrom: string | null;
  items: T[];
}

/** `8.1 CBS`, or whichever half the device gave us. */
function channelLabel(rec: Arrangeable): string {
  const ch = rec.channel;
  if (!ch) return "No channel";
  return [ch.number, ch.call_sign].filter(Boolean).join(" ") || "No channel";
}

/** Epoch milliseconds, or -Infinity for a stamp nothing can be made of. */
function stamp(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Title and episode as one comparable string, so a show sorts by its own order. */
function titleKey(rec: Arrangeable): string {
  return `${rec.title ?? ""} ${rec.subtitle ?? ""}`.trim().toLowerCase();
}

/** How two recordings compare under one sort. Ties break on start, then id. */
function compare(a: Arrangeable, b: Arrangeable, sort: LibrarySort): number {
  if (sort === "title" || sort === "title-desc") {
    const byTitle = titleKey(a).localeCompare(titleKey(b));
    if (byTitle !== 0) return sort === "title" ? byTitle : -byTitle;
  } else {
    const byStart = stamp(a.start) - stamp(b.start);
    if (byStart !== 0) return sort === "newest" ? -byStart : byStart;
  }
  // Always the same tail, so a list of identically-titled recordings does not
  // reshuffle between renders. Three copies of one episode is not a
  // hypothetical - see `orderEpisodes`.
  const byStart = stamp(b.start) - stamp(a.start);
  if (byStart !== 0) return byStart;
  return a.object_id - b.object_id;
}

/**
 * The cards, under their headings, in the order asked for.
 *
 * The sort does two jobs and they are the same job: it orders the cards inside
 * each section, and it orders the sections against each other. Grouping by
 * show and sorting by Newest means shows in the order they last recorded, not
 * shows alphabetically with newest episodes inside — anything else would leave
 * "Newest" pointing at a card halfway down the page.
 *
 * Grouping by day is the exception that proves it: a day's heading *is* a
 * date, so ordering those sections by date is the same answer either way, and
 * sorting a day's cards alphabetically leaves the days themselves newest-first.
 */
export function arrange<T extends Arrangeable>(
  items: T[], group: LibraryGroup, sort: LibrarySort,
): LibrarySection<T>[] {
  const sections = new Map<string, LibrarySection<T>>();

  for (const rec of items) {
    const start = rec.start ?? "";
    let key: string;
    let label: string;
    let tintFrom: string | null = null;

    if (group === "day") {
      // Keyed on the local day, not on the timestamp: `2026-09-14` parsed as
      // UTC midnight names the day before for anyone west of UTC, which is the
      // very slip `dayKey` exists to avoid. The heading is rendered from a real
      // recording's stamp for the same reason.
      key = dayKey(start);
      label = formatDayHeading(start) || "Undated";
      tintFrom = start;
    } else if (group === "channel") {
      label = channelLabel(rec);
      key = label;
    } else {
      // The show, however the device files it — `series_path`, `sport_path`, or
      // the title where it offers neither. Every NFL game hangs off one sport
      // record, which is exactly what makes this grouping worth having.
      key = seriesKey(rec) ?? `title:${rec.title ?? ""}`;
      label = rec.title || "Untitled";
    }

    const section = sections.get(key);
    if (section) section.items.push(rec);
    else sections.set(key, { key, label, tintFrom, items: [rec] });
  }

  const out = [...sections.values()];
  for (const section of out) section.items.sort((a, b) => compare(a, b, sort));

  out.sort((a, b) => {
    if (group === "day") {
      // Newest day first whatever the sort, because a day heading is a date
      // and reading dates out of order is a different page, not a sorted one.
      // Oldest asks for the other direction and means it.
      const byDay = b.key.localeCompare(a.key);
      return sort === "oldest" ? -byDay : byDay;
    }
    if (sort === "title" || sort === "title-desc") {
      const byLabel = a.label.localeCompare(b.label);
      if (byLabel !== 0) return sort === "title" ? byLabel : -byLabel;
      return a.key.localeCompare(b.key);
    }
    // By whichever of its cards the sort puts first — its newest for Newest,
    // its oldest for Oldest. The sections are then in the same order their
    // first cards are.
    return compare(a.items[0], b.items[0], sort);
  });

  return out;
}
