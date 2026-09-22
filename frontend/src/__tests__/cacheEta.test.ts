/**
 * How long a download still has to run.
 *
 * The card already says how fast it is going and how much is done; what a
 * person actually wants from those two numbers is when they can stop watching
 * it. `realtime` is the useful rate here rather than Mb/s: it is output
 * seconds per wall second, so the arithmetic is the remaining *content*
 * divided by it, and it stays right whatever the bitrate happens to be.
 */
import { describe, it, expect } from "vitest";

import { cacheEta } from "../lib/cacheEta";

describe("cacheEta", () => {
  it("divides what is left by how fast it is being made", () => {
    // 2h21m recording, 23m done, running at 5.5x: (8472-1380)/5.5 = 1289s.
    expect(cacheEta(8472, 1380, 5.5)).toBeCloseTo(1289.5, 0);
  });

  it("says nothing until there is a rate to divide by", () => {
    // A download that has not produced a window yet has no honest estimate,
    // and a made-up one is worse than none.
    expect(cacheEta(8472, 0, 0)).toBeNull();
    expect(cacheEta(8472, 0, -1)).toBeNull();
  });

  it("says nothing when the duration is unknown", () => {
    expect(cacheEta(0, 0, 5)).toBeNull();
  });

  it("is zero, not negative, once everything is cached", () => {
    // Windows overrun their nominal length, so `cached` can pass `duration`.
    expect(cacheEta(8472, 8472, 5.5)).toBe(0);
    expect(cacheEta(8472, 8500, 5.5)).toBe(0);
  });
});
