import { describe, it, expect, beforeEach } from "vitest";

import {
  fitPipWindow, loadPipArea, savePipArea,
  PIP_AREA_DEFAULT, PIP_AREA_STORAGE_KEY,
} from "../lib/pipWindow";

/** A screen big enough that nothing here is clamped by it. */
const ROOMY = { width: 3840, height: 2160 };

const ratio = (b: { width: number; height: number }) => b.width / b.height;

describe("the box a pop-out asks for", () => {
  it("takes its shape from the picture, not from the last window", () => {
    // The bug: a size remembered from 16:9 is handed to a 4:3 programme,
    // which then plays with bands above and below it.
    const wide = fitPipWindow({ width: 1920, height: 1080 }, ROOMY, PIP_AREA_DEFAULT)!;
    const boxy = fitPipWindow({ width: 640, height: 480 }, ROOMY, PIP_AREA_DEFAULT)!;
    expect(ratio(wide)).toBeCloseTo(16 / 9, 2);
    expect(ratio(boxy)).toBeCloseTo(4 / 3, 2);
  });

  it("keeps the area the viewer last left, whatever the shape", () => {
    const area = 900 * 900;
    for (const picture of [
      { width: 1920, height: 1080 },
      { width: 640, height: 480 },
      { width: 480, height: 640 },
    ]) {
      const box = fitPipWindow(picture, ROOMY, area)!;
      expect(box.width * box.height).toBeGreaterThan(area * 0.99);
      expect(box.width * box.height).toBeLessThan(area * 1.01);
      expect(ratio(box)).toBeCloseTo(picture.width / picture.height, 2);
    }
  });

  it("shrinks to fit a small screen without changing shape", () => {
    const box = fitPipWindow({ width: 1920, height: 1080 }, { width: 800, height: 600 },
      4000 * 4000)!;
    expect(ratio(box)).toBeCloseTo(16 / 9, 2);
    expect(box.width).toBeLessThanOrEqual(800);
    expect(box.height).toBeLessThanOrEqual(600);
  });

  it("asks for nothing at all before anything has decoded", () => {
    // Zero is what both sources report until the first frame, and a window
    // shaped from zero is a window shaped from nothing. The browser's own
    // guess is better than ours here.
    expect(fitPipWindow({ width: 0, height: 0 }, ROOMY, PIP_AREA_DEFAULT)).toBeNull();
    expect(fitPipWindow({ width: 1920, height: 0 }, ROOMY, PIP_AREA_DEFAULT)).toBeNull();
    expect(fitPipWindow({ width: NaN, height: NaN }, ROOMY, PIP_AREA_DEFAULT)).toBeNull();
  });
});

describe("the remembered size", () => {
  beforeEach(() => localStorage.clear());

  it("comes back as the area of the window that was closed", () => {
    savePipArea(1000, 500);
    expect(loadPipArea()).toBe(500_000);
  });

  it("ignores a stored value too small to be a window", () => {
    // A pop-out mid-close can report a collapsed size, and storing that would
    // make the next one open as a sliver.
    savePipArea(4, 3);
    expect(loadPipArea()).toBe(PIP_AREA_DEFAULT);
    localStorage.setItem(PIP_AREA_STORAGE_KEY, "12");
    expect(loadPipArea()).toBe(PIP_AREA_DEFAULT);
    localStorage.setItem(PIP_AREA_STORAGE_KEY, "not a number");
    expect(loadPipArea()).toBe(PIP_AREA_DEFAULT);
  });
});
