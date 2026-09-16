import { describe, it, expect } from "vitest";
import {
  DATE_GAIN, DRAG_SLOP, MIN_THROW, THROW_WINDOW_MS,
  dominantAxis, throwVelocity, type DragSample,
} from "../lib/drag";

/** A flick: `n` samples `gap` ms apart, each `step` px further along. */
function flick(n: number, gap: number, step: number, axis: "x" | "y" = "x"): DragSample[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * gap,
    x: axis === "x" ? i * step : 0,
    y: axis === "y" ? i * step : 0,
  }));
}

describe("throwVelocity", () => {
  it("measures the throw in pixels per millisecond", () => {
    const v = throwVelocity(flick(5, 10, 20), 40);
    expect(v).not.toBeNull();
    expect(v!.x).toBeCloseTo(2, 5);
    expect(v!.y).toBe(0);
  });

  it("ignores everything older than the window", () => {
    // A slow reposition, then a flick. Averaging the whole gesture reads this
    // as crawling; only the last 90ms is the throw.
    const samples: DragSample[] = [
      { t: 0, x: 0, y: 0 },
      { t: 500, x: 10, y: 0 },      // 500ms to move 10px
      { t: 540, x: 90, y: 0 },      // then 80px in 40ms
    ];
    const v = throwVelocity(samples, 545)!;
    expect(v.x).toBeCloseTo(2, 5);  // not 90/540, which is 0.17
  });

  it("refuses a throw when the pointer rested before letting go", () => {
    // Drag, hold still, release: a placement, not a throw. The gap between
    // the last two moves cannot see the pause, so the release time must.
    const samples = flick(5, 10, 20);
    const last = samples[samples.length - 1].t;
    expect(throwVelocity(samples, last + 5)).not.toBeNull();
    expect(throwVelocity(samples, last + THROW_WINDOW_MS + 1)).toBeNull();
  });

  it("refuses a throw it cannot measure", () => {
    expect(throwVelocity([], 0)).toBeNull();
    expect(throwVelocity([{ t: 0, x: 0, y: 0 }], 0)).toBeNull();
    // Every sample at the same instant: no span, so no speed.
    expect(throwVelocity([
      { t: 5, x: 0, y: 0 },
      { t: 5, x: 40, y: 0 },
    ], 5)).toBeNull();
  });

  it("survives samples arriving sparsely", () => {
    // Two samples 80ms apart is all a busy main thread may deliver. It is
    // still inside the window, so it is still a throw - the bug this replaced
    // kept a stale first sample and read every such throw as standing still.
    const v = throwVelocity([
      { t: 0, x: 0, y: 0 },
      { t: 80, x: 160, y: 0 },
    ], 85)!;
    expect(v.x).toBeCloseTo(2, 5);
    expect(Math.abs(v.x)).toBeGreaterThan(MIN_THROW);
  });

  it("reports a vertical throw on the vertical axis", () => {
    const v = throwVelocity(flick(5, 10, 20, "y"), 45)!;
    expect(v.x).toBe(0);
    expect(v.y).toBeCloseTo(2, 5);
  });
});

describe("dominantAxis", () => {
  it("takes whichever way the gesture travelled furthest", () => {
    expect(dominantAxis(30, 4)).toBe("x");
    expect(dominantAxis(4, 30)).toBe("y");
    expect(dominantAxis(-30, 4)).toBe("x");
    expect(dominantAxis(4, -30)).toBe("y");
  });

  it("gives a tie to time, which is the axis the guide is about", () => {
    expect(dominantAxis(10, 10)).toBe("x");
  });
});

describe("the constants the gestures are tuned to", () => {
  it("separates a click from a drag by a few pixels, not a few dozen", () => {
    // Big enough to survive the wobble of a click, small enough that a drag
    // does not feel like it sticks before it moves.
    expect(DRAG_SLOP).toBeGreaterThanOrEqual(3);
    expect(DRAG_SLOP).toBeLessThanOrEqual(8);
  });

  it("gears the date band well clear of one-to-one", () => {
    expect(DATE_GAIN).toBeGreaterThan(1);
  });
});
