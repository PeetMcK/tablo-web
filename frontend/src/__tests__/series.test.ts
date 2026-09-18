import { describe, it, expect } from "vitest";

import { orderEpisodes, seriesKey, siblingEpisodes } from "../lib/series";
import type { Episode } from "../lib/series";

/** An episode, with everything absent unless a test says otherwise. */
function ep(over: Partial<Episode> & { object_id: number }): Episode {
  return {
    title: null,
    series_path: null,
    sport_path: null,
    season_number: null,
    episode_number: null,
    orig_air_date: null,
    start: "2026-09-17T00:00Z",
    ...over,
  };
}

describe("seriesKey", () => {
  it("files an episode under its series", () => {
    expect(seriesKey(ep({ object_id: 1, series_path: "/recordings/series/86119" })))
      .toBe("/recordings/series/86119");
  });

  it("falls back to the title, which is what holds the NFL together", () => {
    // Measured on the live library: of eighteen recordings the six with no
    // `series_path` are all NFL Football - the sport that has no episode
    // numbers either, and so the one case date ordering exists to serve.
    // Keying on `series_path` alone gave every one of them an empty card.
    const a = ep({ object_id: 1, title: "NFL Football" });
    const b = ep({ object_id: 2, title: "NFL Football" });
    expect(seriesKey(a)).toBe(seriesKey(b));
    expect(seriesKey(a)).not.toBeNull();
  });

  it("files a game under its sport, which is its series by another name", () => {
    // `/recordings/sports/{id}` carries a title, a description, the same three
    // images and its own airing count, and the Tablo app heads its sheet
    // "Series Recording Scheduled" over the league's picture. Every NFL game on
    // this device hangs off one such record.
    const a = ep({ object_id: 1, title: "NFL Football",
                   sport_path: "/recordings/sports/63558" });
    const b = ep({ object_id: 2, title: "NFL Football",
                   sport_path: "/recordings/sports/63558" });
    expect(seriesKey(a)).toBe("/recordings/sports/63558");
    expect(seriesKey(a)).toBe(seriesKey(b));
  });

  it("believes the device over a matching title", () => {
    // The title carried sport on its own before the path was projected, and it
    // worked - six games do share one - but only by accident. Two different
    // shows can share a title; two the device files apart belong apart.
    const a = ep({ object_id: 1, title: "NFL Football",
                   sport_path: "/recordings/sports/63558" });
    const b = ep({ object_id: 2, title: "NFL Football",
                   sport_path: "/recordings/sports/99999" });
    expect(seriesKey(a)).not.toBe(seriesKey(b));
  });

  it("prefers a series path to a sport path where a record has both", () => {
    expect(seriesKey(ep({
      object_id: 1,
      series_path: "/recordings/series/10",
      sport_path: "/recordings/sports/20",
    }))).toBe("/recordings/series/10");
  });

  it("does not file two different shows together", () => {
    expect(seriesKey(ep({ object_id: 1, title: "NFL Football" })))
      .not.toBe(seriesKey(ep({ object_id: 2, title: "MLB Baseball" })));
  });

  it("has nowhere to file a recording with neither", () => {
    expect(seriesKey(ep({ object_id: 1 }))).toBeNull();
  });
});

describe("orderEpisodes", () => {
  it("puts a numbered series in episode order, oldest at the top", () => {
    const later = ep({ object_id: 2, season_number: 2, episode_number: 8 });
    const earlier = ep({ object_id: 1, season_number: 2, episode_number: 7 });
    expect(orderEpisodes([later, earlier]).map((e) => e.object_id)).toEqual([1, 2]);
  });

  it("orders Saturday Night Live by episode, not by when it was recorded", () => {
    // S24E16 aired in 1999 and S49E7 in 2023, and both were recorded the same
    // morning off a rerun marathon - so recording order says nothing at all
    // about them and episode order says everything.
    const s49 = ep({
      object_id: 2, series_path: "/recordings/series/86088",
      season_number: 49, episode_number: 7,
      orig_air_date: "2023-12-09", start: "2026-09-17T07:00Z",
    });
    const s24 = ep({
      object_id: 1, series_path: "/recordings/series/86088",
      season_number: 24, episode_number: 16,
      orig_air_date: "1999-03-20", start: "2026-09-17T08:00Z",
    });
    expect(orderEpisodes([s49, s24]).map((e) => e.season_number)).toEqual([24, 49]);
  });

  it("orders sport by when it was recorded, having no numbers to use", () => {
    const sunday = ep({ object_id: 1, title: "NFL Football", start: "2026-09-13T17:00Z" });
    const monday = ep({ object_id: 2, title: "NFL Football", start: "2026-09-15T00:15Z" });
    expect(orderEpisodes([monday, sunday]).map((e) => e.object_id)).toEqual([1, 2]);
  });

  it("prefers the air date to the recording date where there is one", () => {
    // A rerun recorded today of something that aired years ago belongs where it
    // aired, not where the tuner happened to catch it.
    const old = ep({
      object_id: 1, orig_air_date: "2018-05-08", start: "2026-09-17T12:00Z",
    });
    const recent = ep({
      object_id: 2, orig_air_date: "2024-11-20", start: "2026-09-17T06:00Z",
    });
    expect(orderEpisodes([recent, old]).map((e) => e.object_id)).toEqual([1, 2]);
  });

  it("falls to dates when only some of the group is numbered", () => {
    // Every, not any. Under episode order the unnumbered ones collapse together
    // at one end whatever their dates say, which is worse than not using
    // numbers at all.
    const numbered = ep({
      object_id: 2, season_number: 1, episode_number: 1,
      orig_air_date: "2026-01-02",
    });
    const bare = ep({ object_id: 1, orig_air_date: "2026-01-01" });
    expect(orderEpisodes([numbered, bare]).map((e) => e.object_id)).toEqual([1, 2]);
  });

  it("holds a three-way tie still", () => {
    // Not hypothetical: `First Civilizations` holds three recordings that are
    // all S1E3 with one air date, so every rule above ties on all three. An
    // unstable tail reshuffles the list between renders.
    const tied = (object_id: number, start: string) => ep({
      object_id, series_path: "/recordings/series/86041",
      season_number: 1, episode_number: 3,
      orig_air_date: "2018-05-08", start,
    });
    const a = tied(3, "2026-09-16T22:00Z");
    const b = tied(1, "2026-09-16T22:00Z");
    const c = tied(2, "2026-09-16T22:00Z");
    expect(orderEpisodes([a, b, c]).map((e) => e.object_id)).toEqual([1, 2, 3]);
    expect(orderEpisodes([c, a, b]).map((e) => e.object_id)).toEqual([1, 2, 3]);
  });

  it("does not disturb what it was given", () => {
    const list = [ep({ object_id: 2 }), ep({ object_id: 1 })];
    orderEpisodes(list);
    expect(list.map((e) => e.object_id)).toEqual([2, 1]);
  });

  it("survives a date nothing can be made of", () => {
    const bad = ep({ object_id: 1, orig_air_date: "not a date" });
    const good = ep({ object_id: 2, orig_air_date: "2026-01-01" });
    expect(orderEpisodes([bad, good]).map((e) => e.object_id)).toEqual([2, 1]);
  });
});

describe("siblingEpisodes", () => {
  const carl = (object_id: number, episode_number: number) => ep({
    object_id, title: "Carl the Collector",
    series_path: "/recordings/series/86119",
    season_number: 1, episode_number,
  });

  it("lists the show it belongs to, including the one just watched", () => {
    // The card is the show with your place marked in it, not a list of what is
    // left. Seeing where you are in a run is most of what it is for.
    const all = [carl(2, 30), carl(1, 5), ep({ object_id: 9, title: "Something Else" })];
    expect(siblingEpisodes(carl(1, 5), all).map((e) => e.object_id)).toEqual([1, 2]);
  });

  it("gives nothing for the only recording of its show", () => {
    // A list of one is worse than no list.
    const only = carl(1, 5);
    expect(siblingEpisodes(only, [only])).toEqual([]);
  });

  it("gives nothing for a recording that belongs nowhere", () => {
    const orphan = ep({ object_id: 1 });
    expect(siblingEpisodes(orphan, [orphan, ep({ object_id: 2 })])).toEqual([]);
  });

  it("gathers sport by title, where there is no series to gather by", () => {
    const game = (object_id: number, start: string) =>
      ep({ object_id, title: "NFL Football", start });
    const all = [game(3, "2026-09-15T00:15Z"), game(1, "2026-09-13T17:00Z"),
                 game(2, "2026-09-14T00:15Z")];
    expect(siblingEpisodes(all[1], all).map((e) => e.object_id)).toEqual([1, 2, 3]);
  });
});
