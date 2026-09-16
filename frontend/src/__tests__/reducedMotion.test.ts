import { describe, it, expect, afterEach, vi } from "vitest";

import { prefersReducedMotion } from "../lib/drag";

/**
 * jsdom implements no `matchMedia`, so every read of the motion preference
 * threw — inside a pointer handler, where the throw escaped as an unhandled
 * error rather than a failure. Seven of them per run of the suite, sitting on
 * top of the guide's drag tests while every assertion passed. Errors nobody
 * owns are where a real one hides.
 */
describe("the viewer's motion preference", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads as unset where nothing has been asked for", () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it("reads what the viewer actually asked for", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue(
      { matches: true } as unknown as MediaQueryList);

    expect(prefersReducedMotion()).toBe(true);
  });
});
