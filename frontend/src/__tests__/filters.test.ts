import { describe, it, expect } from "vitest";
import type { GuideChannel, GridChannel, Program } from "../api/tablo";
import {
  recordingMatchesFilter, type FilterableRecording,
} from "../lib/contentFilters";

// ── replicated filter logic (mirrors ChannelGrid.tsx / GuideGridView.tsx) ──

type ContentFilter = "all" | "movies" | "sports" | "news" | "reality" | "documentary" | "ota" | "fast";

function matchesContentFilter(ch: GuideChannel, f: ContentFilter): boolean {
  if (f === "all") return true;
  if (f === "ota") return ch.kind === "ota";
  if (f === "fast") return ch.kind === "ott";
  const prog = ch.current_program;
  if (!prog) return false;
  const genres = prog.genres ?? [];
  if (f === "movies")      return prog.kind === "movieAiring";
  if (f === "sports")      return prog.kind === "sportEvent" || genres.some(g => /sport/i.test(g));
  if (f === "news")        return genres.some(g => /news/i.test(g));
  if (f === "reality")     return genres.some(g => /reality/i.test(g));
  if (f === "documentary") return genres.some(g => /documentary/i.test(g));
  return true;
}

function airingMatchesFilter(air: Program, f: ContentFilter): boolean {
  if (f === "all") return true;
  const genres = air.genres ?? [];
  if (f === "movies")      return air.kind === "movieAiring";
  if (f === "sports")      return air.kind === "sportEvent" || genres.some(g => /sport/i.test(g));
  if (f === "news")        return genres.some(g => /news/i.test(g));
  if (f === "reality")     return genres.some(g => /reality/i.test(g));
  if (f === "documentary") return genres.some(g => /documentary/i.test(g));
  return false;
}

function channelMatchesFilter(ch: GridChannel, f: ContentFilter): boolean {
  if (f === "all")  return true;
  if (f === "ota")  return ch.kind === "ota";
  if (f === "fast") return ch.kind === "ott";
  return ch.airings.some(a => airingMatchesFilter(a, f));
}

// ── helpers ────────────────────────────────────────────────────────────────

function makeGuide(kind: string, program?: Partial<Program>): GuideChannel {
  return {
    identifier: "test",
    call_sign: "TEST",
    major: 1,
    minor: 1,
    network: "Test",
    kind,
    display_name: "Test Channel",
    logo_url: null,
    current_program: program
      ? { title: "Test Show", description: null, start: new Date().toISOString(), duration: 3600, ...program }
      : null,
  };
}

function makeGrid(kind: string, airings: Partial<Program>[] = []): GridChannel {
  return {
    identifier: "test",
    call_sign: "TEST",
    major: 1,
    minor: 1,
    network: "Test",
    kind,
    display_name: "Test Channel",
    logo_url: null,
    airings: airings.map(a => ({
      title: "Test", description: null,
      start: new Date().toISOString(), duration: 3600, ...a,
    })),
  };
}

// ── Live TV filter tests ────────────────────────────────────────────────────

describe("matchesContentFilter (Live TV)", () => {
  it("all passes everything", () => {
    expect(matchesContentFilter(makeGuide("ota"), "all")).toBe(true);
    expect(matchesContentFilter(makeGuide("ott"), "all")).toBe(true);
  });

  it("ota matches only ota channels", () => {
    expect(matchesContentFilter(makeGuide("ota"), "ota")).toBe(true);
    expect(matchesContentFilter(makeGuide("ott"), "ota")).toBe(false);
  });

  it("fast matches only ott channels", () => {
    expect(matchesContentFilter(makeGuide("ott"), "fast")).toBe(true);
    expect(matchesContentFilter(makeGuide("ota"), "fast")).toBe(false);
  });

  it("movies matches movieAiring kind", () => {
    expect(matchesContentFilter(makeGuide("ota", { kind: "movieAiring" }), "movies")).toBe(true);
    expect(matchesContentFilter(makeGuide("ota", { kind: "episode" }), "movies")).toBe(false);
  });

  it("sports matches sportEvent kind", () => {
    expect(matchesContentFilter(makeGuide("ota", { kind: "sportEvent" }), "sports")).toBe(true);
  });

  it("sports matches Sports genre", () => {
    expect(matchesContentFilter(makeGuide("ota", { genres: ["Sports"] }), "sports")).toBe(true);
  });

  it("news matches News genre", () => {
    expect(matchesContentFilter(makeGuide("ota", { genres: ["News"] }), "news")).toBe(true);
    expect(matchesContentFilter(makeGuide("ota", { genres: ["Comedy"] }), "news")).toBe(false);
  });

  it("reality matches Reality genre case-insensitively", () => {
    expect(matchesContentFilter(makeGuide("ota", { genres: ["Reality"] }), "reality")).toBe(true);
    expect(matchesContentFilter(makeGuide("ota", { genres: ["reality tv"] }), "reality")).toBe(true);
  });

  it("documentary matches Documentary genre", () => {
    expect(matchesContentFilter(makeGuide("ota", { genres: ["Documentary"] }), "documentary")).toBe(true);
  });

  it("returns false when program is null for content filters", () => {
    expect(matchesContentFilter(makeGuide("ota"), "movies")).toBe(false);
    expect(matchesContentFilter(makeGuide("ota"), "news")).toBe(false);
  });
});

// ── Guide Grid filter tests ─────────────────────────────────────────────────

describe("channelMatchesFilter (Guide Grid)", () => {
  it("all passes everything", () => {
    expect(channelMatchesFilter(makeGrid("ota"), "all")).toBe(true);
  });

  it("ota / fast filter by channel kind", () => {
    expect(channelMatchesFilter(makeGrid("ota"), "ota")).toBe(true);
    expect(channelMatchesFilter(makeGrid("ott"), "fast")).toBe(true);
    expect(channelMatchesFilter(makeGrid("ota"), "fast")).toBe(false);
  });

  it("movies matches if any airing is movieAiring", () => {
    const ch = makeGrid("ota", [{ kind: "episode" }, { kind: "movieAiring" }]);
    expect(channelMatchesFilter(ch, "movies")).toBe(true);
  });

  it("no match if no airings have the right genre", () => {
    const ch = makeGrid("ota", [{ kind: "episode", genres: ["Comedy"] }]);
    expect(channelMatchesFilter(ch, "news")).toBe(false);
  });
});


// ── recordingMatchesFilter, imported rather than replicated ──
//
// The Library filters recordings, not channels, so this one is the real
// function: there is a single copy of it in `lib/contentFilters`, and a test
// against a hand-copied duplicate would only ever test the copy.

describe("recordingMatchesFilter (Library)", () => {
  function rec(over: Partial<FilterableRecording> = {}): FilterableRecording {
    return { kind: "episode", genres: [], channel: { kind: "ota" }, ...over };
  }

  it("all passes everything", () => {
    expect(recordingMatchesFilter(rec({ kind: null, channel: null }), "all")).toBe(true);
  });

  it("files a film by its kind, which is all a film has", () => {
    // No show record behind one, so no genres either - matching on genre alone
    // would drop every film out of the filter named after it.
    expect(recordingMatchesFilter(rec({ kind: "movie" }), "movies")).toBe(true);
    expect(recordingMatchesFilter(rec({ kind: "episode" }), "movies")).toBe(false);
  });

  it("takes a game either from its kind or from the show's genres", () => {
    expect(recordingMatchesFilter(rec({ kind: "sport" }), "sports")).toBe(true);
    expect(recordingMatchesFilter(
      rec({ kind: "episode", genres: ["Sports non-event"] }), "sports")).toBe(true);
    expect(recordingMatchesFilter(rec({ genres: ["Comedy"] }), "sports")).toBe(false);
  });

  it("reads the genres of the show an episode belongs to", () => {
    const doc = rec({ genres: ["Documentary", "History"] });
    expect(recordingMatchesFilter(doc, "documentary")).toBe(true);
    expect(recordingMatchesFilter(doc, "news")).toBe(false);
  });

  it("files Broadcast and Streaming by the station it was recorded from", () => {
    expect(recordingMatchesFilter(rec(), "ota")).toBe(true);
    expect(recordingMatchesFilter(rec(), "fast")).toBe(false);
    expect(recordingMatchesFilter(rec({ channel: { kind: "ott" } }), "fast")).toBe(true);
  });

  it("drops a card that knows nothing rather than guessing at it", () => {
    // An offline copy snapshotted before these fields existed. It falls out of
    // every filter but All, which is the honest answer.
    const blank = rec({ kind: null, genres: [], channel: null });
    for (const f of ["movies", "sports", "news", "reality",
                     "documentary", "ota", "fast"] as const) {
      expect(recordingMatchesFilter(blank, f)).toBe(false);
    }
  });
});
