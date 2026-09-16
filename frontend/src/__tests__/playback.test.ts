import { describe, it, expect } from "vitest";

import { airingAt, clampSkip, mediaAt, programWindow, readyRange } from "../lib/playback";

describe("readyRange", () => {
  const cached: [number, number][] = [[0, 600], [1800, 2400]];

  it("is the whole timeline when everything is available", () => {
    expect(readyRange(120, { ranges: [], start: 0, end: 3600, whole: true }))
      .toEqual([0, 3600]);
  });

  it("is the cached island the playhead is standing in", () => {
    expect(readyRange(120, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([0, 600]);
    expect(readyRange(2000, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([1800, 2400]);
  });

  it("still belongs to the island whose frontier it is stalled on", () => {
    // A forward skip parks at the last playable instant, playback rolls the
    // remaining half-second, and the playhead comes to rest exactly on the
    // window boundary waiting for the encoder. It has not left the island it
    // was watching, and rewinding into it is the one move guaranteed warm.
    expect(readyRange(600, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([0, 600]);
  });

  it("is a point when the playhead sits in a gap", () => {
    expect(readyRange(1000, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([1000, 1000]);
  });
});

describe("clampSkip", () => {
  it("jumps freely inside the ready range", () => {
    expect(clampSkip(100, 30, [0, 600])).toBe(130);
    expect(clampSkip(100, -10, [0, 600])).toBe(90);
  });

  it("stops just inside the frontier, not on it", () => {
    // The range is half-open: 600 is the first instant that does not exist yet,
    // so landing exactly there would stall on the window being encoded.
    expect(clampSkip(592, 30, [0, 600])).toBe(599.5);
    // At the live edge, forward stays put rather than seeking past it.
    expect(clampSkip(600, 30, [0, 600])).toBe(599.5);
  });

  it("will not rewind out of the ready range either", () => {
    expect(clampSkip(1805, -10, [1800, 2400])).toBe(1800);
  });

  it("holds still when the playhead is in a gap", () => {
    // readyRange collapses to a point there; a jump must not escape it.
    expect(clampSkip(1000, 30, [1000, 1000])).toBe(1000);
    expect(clampSkip(1000, -10, [1000, 1000])).toBe(1000);
  });
});

// An 8:00–9:00 PM news hour, tuned into at 8:15. The player has been running
// 900 media-seconds by then, so that instant anchors the two timelines.
const EIGHT_PM = new Date("2026-09-15T20:00:00").getTime();
const EIGHT_FIFTEEN = EIGHT_PM + 15 * 60_000;
const ANCHOR = { wallMs: EIGHT_FIFTEEN, media: 900 };
const NEWS_HOUR = { start: "2026-09-15T20:00:00", duration: 3600 };
const NEXT_SHOW = { start: "2026-09-15T21:00:00", duration: 1800 };

describe("mediaAt", () => {
  it("walks the media clock with the wall clock", () => {
    expect(mediaAt(EIGHT_FIFTEEN, ANCHOR)).toBe(900);
    expect(mediaAt(EIGHT_PM, ANCHOR)).toBe(0);
    expect(mediaAt(EIGHT_FIFTEEN + 60_000, ANCHOR)).toBe(960);
  });
});

describe("programWindow", () => {
  it("spans the airing, so a quarter in reads as a quarter in", () => {
    const window = programWindow(NEWS_HOUR, ANCHOR);
    expect(window).toEqual([0, 3600]);
    const [start, end] = window!;
    // Where the playhead sits at 8:15, as a fraction of the bar.
    expect((900 - start) / (end - start)).toBeCloseTo(0.25);
  });

  it("puts an airing already underway before the session's own zero", () => {
    // Tuning in at 8:45 of the same hour: 45 minutes of it predate the stream.
    const late = { wallMs: EIGHT_PM + 45 * 60_000, media: 0 };
    expect(programWindow(NEWS_HOUR, late)).toEqual([-2700, 900]);
  });

  it("knows nothing without an anchor or a usable airing", () => {
    expect(programWindow(NEWS_HOUR, null)).toBeNull();
    expect(programWindow(null, ANCHOR)).toBeNull();
    expect(programWindow({ start: null, duration: 3600 }, ANCHOR)).toBeNull();
    expect(programWindow({ start: "whenever", duration: 3600 }, ANCHOR)).toBeNull();
    expect(programWindow({ start: NEWS_HOUR.start, duration: 0 }, ANCHOR)).toBeNull();
    expect(programWindow({ start: NEWS_HOUR.start, duration: null }, ANCHOR)).toBeNull();
  });
});

describe("airingAt", () => {
  const schedule = [NEXT_SHOW, NEWS_HOUR];

  it("picks whatever covers the moment, unsorted input and all", () => {
    expect(airingAt(schedule, EIGHT_FIFTEEN)).toBe(NEWS_HOUR);
  });

  it("hands the boundary to the airing starting there", () => {
    // 9:00:00 belongs to the show beginning at 9:00, not to the one ending.
    expect(airingAt(schedule, EIGHT_PM + 3_600_000)).toBe(NEXT_SHOW);
  });

  it("covers nothing outside the schedule", () => {
    expect(airingAt(schedule, EIGHT_PM - 1)).toBeNull();
    expect(airingAt([], EIGHT_FIFTEEN)).toBeNull();
    expect(airingAt([{ start: "whenever", duration: 60 }], EIGHT_FIFTEEN)).toBeNull();
  });
});

describe("stalled on the encoder's frontier", () => {
  const cached: [number, number][] = [[0, 600]];
  const opts = { ranges: cached, start: 0, end: 3600, whole: false };

  it("rewinds out of the stall instead of holding still", () => {
    // Skipping forward near the frontier lands just inside it; half a second of
    // playback later the playhead is on the boundary, waiting for the next
    // 60s window to encode. A rewind from there must move.
    const parked = clampSkip(590, 30, readyRange(590, opts));
    expect(parked).toBe(599.5);
    expect(clampSkip(600, -10, readyRange(600, opts))).toBe(590);
  });

  it("does not jump forward into the window being encoded", () => {
    expect(clampSkip(600, 30, readyRange(600, opts))).toBeLessThan(600);
  });
});

describe("a skip never leaves what exists", () => {
  it("stops at the live edge even when the bar runs an hour past it", () => {
    // The bar spans 8:00–9:00; only 8:00–8:15 is on disk. Forward 30 from near
    // the live edge must stay on disk rather than seeking into unbroadcast
    // time, which would stall and raise the transcoding overlay.
    const range = readyRange(880, { ranges: [], start: 0, end: 900, whole: true });
    expect(clampSkip(880, 30, range)).toBe(899.5);
    expect(clampSkip(899.5, 30, range)).toBeLessThan(900);
  });
});
