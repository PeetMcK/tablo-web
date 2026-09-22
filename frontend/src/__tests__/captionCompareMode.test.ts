/**
 * Where the compare flag is allowed to live.
 *
 * It was read from `location.search` alone, and the app routes on the hash —
 * so `#/live/ch/X?cc=compare`, which is the form that comes to hand when you
 * are looking at a page and want to add a flag to it, silently did nothing.
 * The flag looked broken, the diagnostic looked broken, and the bug it was
 * built to find kept its cover.
 */

import { describe, it, expect } from "vitest";

import { captionCompareRequested } from "../lib/captions/compareMode";

describe("the compare flag", () => {
  it("is off when nothing asks for it", () => {
    expect(captionCompareRequested("", "#/live/ch/S34654_008_01")).toBe(false);
  });

  it("is on before the hash", () => {
    expect(captionCompareRequested("?cc=compare", "#/live/ch/S34654_008_01")).toBe(true);
  });

  it("is on inside the hash route, which is where it comes to hand", () => {
    expect(captionCompareRequested("", "#/live/ch/S34654_008_01?cc=compare")).toBe(true);
  });

  it("is on alongside other route parameters", () => {
    expect(captionCompareRequested("", "#/library/rec/96321?q=nfl&cc=compare")).toBe(true);
  });

  it("ignores the parameter set to anything else", () => {
    expect(captionCompareRequested("?cc=off", "#/live")).toBe(false);
    expect(captionCompareRequested("", "#/live?cc=1")).toBe(false);
  });
});
