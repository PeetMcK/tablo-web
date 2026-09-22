/**
 * How the Library arranges what it holds.
 *
 * The rules, without a component around them: what heading a card lands under,
 * what order cards come in, and — the part that is easy to get wrong — what
 * order the headings themselves come in.
 */
import { describe, it, expect } from "vitest";

import { arrange, LIBRARY_LAYOUTS, type Arrangeable } from "../lib/libraryLayout";

function rec(over: Partial<Arrangeable> & { object_id: number }): Arrangeable {
  return {
    title: "Wild Kratts",
    subtitle: null,
    start: "2026-09-21T18:00:00Z",
    series_path: "/recordings/series/900",
    sport_path: null,
    channel: { call_sign: "PBS", number: "7.1" },
    ...over,
  };
}

const KRATTS_MON = rec({ object_id: 1, subtitle: "The Fourth Bald Eagle" });
const KRATTS_SUN = rec({
  object_id: 2, subtitle: "Temple of Tigers", start: "2026-09-20T15:00:00Z",
});
const GAME = rec({
  object_id: 3, title: "NFL Football", subtitle: "Giants at Rams",
  start: "2026-09-21T22:15:00Z",
  series_path: null, sport_path: "/recordings/sports/63558",
  channel: { call_sign: "ABC", number: "23.1" },
});
const JEOPARDY = rec({
  object_id: 4, title: "Jeopardy!", subtitle: null,
  start: "2026-09-20T23:00:00Z",
  series_path: "/recordings/series/700",
  channel: { call_sign: "CBS", number: "8.1" },
});

const ALL = [KRATTS_MON, KRATTS_SUN, GAME, JEOPARDY];

/** Section labels, in the order they would be drawn. */
const labels = (items: Arrangeable[], group: Parameters<typeof arrange>[1],
                sort: Parameters<typeof arrange>[2]) =>
  arrange(items, group, sort).map(s => s.label);

/** The object_ids under each section, in order. */
const ids = (items: Arrangeable[], group: Parameters<typeof arrange>[1],
             sort: Parameters<typeof arrange>[2]) =>
  arrange(items, group, sort).map(s => s.items.map(i => i.object_id));

describe("grouping by day", () => {
  it("heads each day with its own date, newest first", () => {
    expect(labels(ALL, "day", "newest")).toEqual(["Monday 9/21", "Sunday 9/20"]);
  });

  it("turns the days around for Oldest, because a date heading read out of "
     + "order is a different page rather than a sorted one", () => {
    expect(labels(ALL, "day", "oldest")).toEqual(["Sunday 9/20", "Monday 9/21"]);
  });

  it("keeps the days newest-first when the sort is alphabetical", () => {
    // A day heading is a date. Sorting the cards inside it by title says
    // nothing about which day comes first, and the answer there has not
    // changed.
    expect(labels(ALL, "day", "title")).toEqual(["Monday 9/21", "Sunday 9/20"]);
    expect(ids(ALL, "day", "title")).toEqual([[3, 1], [4, 2]]);
  });

  it("tints a day heading from a real recording, never from its key", () => {
    // `2026-09-21` parsed as UTC midnight names the day before for anyone west
    // of UTC — the very slip keying on the local day exists to avoid.
    const [monday] = arrange(ALL, "day", "newest");
    expect(monday.tintFrom).toBe(KRATTS_MON.start);
    expect(new Date(monday.tintFrom!).getDay()).toBe(1);
  });
});

describe("grouping by show", () => {
  it("gathers a show's recordings under one heading", () => {
    expect(labels(ALL, "show", "title")).toEqual(["Jeopardy!", "NFL Football", "Wild Kratts"]);
  });

  it("files games under their sport, which is where the device files them", () => {
    const sport = arrange([GAME, rec({
      object_id: 5, title: "NFL Football", subtitle: "Colts at Chiefs",
      start: "2026-09-20T17:00:00Z",
      series_path: null, sport_path: "/recordings/sports/63558",
    })], "show", "newest");

    expect(sport).toHaveLength(1);
    expect(sport[0].items.map(i => i.object_id)).toEqual([3, 5]);
  });

  it("orders the shows by their newest recording, not alphabetically", () => {
    // Otherwise "Newest" points at a card halfway down the page: the first
    // section would be whatever starts with A.
    expect(labels(ALL, "show", "newest")).toEqual(["NFL Football", "Wild Kratts", "Jeopardy!"]);
  });

  it("leaves a show heading untinted", () => {
    // A show spans weeks. Colouring its rule by the first card's weekday would
    // be picking a colour at random.
    expect(arrange(ALL, "show", "newest")[0].tintFrom).toBeNull();
  });

  it("keeps two shows that share a title apart when the device does", () => {
    const a = rec({ object_id: 6, title: "News", series_path: "/recordings/series/1" });
    const b = rec({ object_id: 7, title: "News", series_path: "/recordings/series/2" });

    expect(arrange([a, b], "show", "newest")).toHaveLength(2);
  });
});

describe("grouping by channel", () => {
  it("heads each station with its number and call sign", () => {
    expect(labels(ALL, "channel", "title")).toEqual(["23.1 ABC", "7.1 PBS", "8.1 CBS"]);
  });

  it("says so when a recording has no channel left to name", () => {
    // An offline copy of something the device deleted: the airing that
    // described it is gone too.
    const orphan = rec({ object_id: 8, channel: null });
    expect(labels([orphan], "channel", "newest")).toEqual(["No channel"]);
  });
});

describe("the order inside a section", () => {
  it("sorts by title and episode, so a show reads in its own order", () => {
    // Same show, so the episode decides: "Temple of Tigers" before "The Fourth
    // Bald Eagle".
    expect(ids([KRATTS_MON, KRATTS_SUN], "show", "title")).toEqual([[2, 1]]);
    expect(ids([KRATTS_MON, KRATTS_SUN], "show", "title-desc")).toEqual([[1, 2]]);
  });

  it("sorts by when it was recorded, both directions", () => {
    expect(ids(ALL, "show", "newest")[1]).toEqual([1, 2]);
    expect(ids([KRATTS_MON, KRATTS_SUN], "show", "oldest")).toEqual([[2, 1]]);
  });

  it("breaks every tie the same way, so nothing reshuffles between renders", () => {
    // Three recordings of one episode with one timestamp is not hypothetical —
    // see `orderEpisodes`, which found three of `First Civilizations`.
    const same = [3, 1, 2].map(id => rec({
      object_id: id, subtitle: "Ritual", start: "2026-09-21T18:00:00Z",
    }));

    expect(ids(same, "show", "title")).toEqual([[1, 2, 3]]);
    expect(ids([...same].reverse(), "show", "title")).toEqual([[1, 2, 3]]);
  });

  it("puts an unreadable timestamp last rather than dropping the card", () => {
    const broken = rec({ object_id: 9, start: "not a date" });
    const out = arrange([...ALL, broken], "day", "newest");

    expect(out.flatMap(s => s.items.map(i => i.object_id))).toContain(9);
  });
});

describe("an empty library", () => {
  it("has no sections at all", () => {
    expect(arrange([], "day", "newest")).toEqual([]);
  });
});

describe("the layouts on offer", () => {
  it("offers cards and rows, cards first", () => {
    // Cards is what the Library has always been, so it is the fallback the
    // page renders before any preference has been read.
    expect(LIBRARY_LAYOUTS.map(l => l.id)).toEqual(["cards", "list"]);
  });

  it("names each one in words, not by its icon alone", () => {
    for (const layout of LIBRARY_LAYOUTS) expect(layout.label).toBeTruthy();
  });
});
