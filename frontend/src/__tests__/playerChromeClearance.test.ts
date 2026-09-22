/**
 * Whether a caption has to move for the transport, and how far.
 *
 * This replaced a rule that guessed from the broadcaster's anchor: any window
 * below three quarters of the frame was lifted by the whole height of the
 * band. That knows where a window was anchored but not where its box ends up,
 * so a caption sitting comfortably clear of the controls would jump a hundred
 * and fifty pixels up the picture to clear a bar it was never near.
 */

import { describe, it, expect } from "vitest";

import {
  CHROME_BOTTOM_BAND_PX, CHROME_CLEARANCE_PX, liftToClearChrome,
} from "../lib/playerChrome";

/** A 1000px-tall stage, so the band's top edge is easy to reason about. */
const STAGE_BOTTOM = 1000;
const BAND_TOP = STAGE_BOTTOM - (CHROME_BOTTOM_BAND_PX + CHROME_CLEARANCE_PX);

describe("clearing the transport", () => {
  it("leaves a box that ends above the band alone", () => {
    expect(liftToClearChrome(BAND_TOP - 200, STAGE_BOTTOM)).toBe(0);
  });

  it("leaves a box resting exactly on the band's edge alone", () => {
    expect(liftToClearChrome(BAND_TOP, STAGE_BOTTOM)).toBe(0);
  });

  it("lifts an overlapping box by exactly the overlap", () => {
    expect(liftToClearChrome(BAND_TOP + 40, STAGE_BOTTOM)).toBe(40);
  });

  it("lifts a box at the very bottom clear of the whole band", () => {
    expect(liftToClearChrome(STAGE_BOTTOM, STAGE_BOTTOM))
      .toBe(CHROME_BOTTOM_BAND_PX + CHROME_CLEARANCE_PX);
  });

  it("never lifts by more than the band, however far down the box starts", () => {
    // A box cannot end below the stage, so this is the ceiling on the lift -
    // and the old rule's constant is now the maximum rather than the answer.
    expect(liftToClearChrome(STAGE_BOTTOM, STAGE_BOTTOM))
      .toBeLessThanOrEqual(CHROME_BOTTOM_BAND_PX + CHROME_CLEARANCE_PX);
  });
});
