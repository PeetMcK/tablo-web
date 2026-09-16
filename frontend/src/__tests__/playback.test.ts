import { describe, it, expect } from "vitest";

import { clampSkip, readyRange } from "../lib/playback";

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

  it("stops at the last playable moment instead of jumping past it", () => {
    // Forward 30s with only 8s of encoded video left.
    expect(clampSkip(592, 30, [0, 600])).toBe(600);
    // At the live edge, forward does nothing.
    expect(clampSkip(600, 30, [0, 600])).toBe(600);
  });

  it("will not rewind out of the ready range either", () => {
    expect(clampSkip(1805, -10, [1800, 2400])).toBe(1800);
  });
});
