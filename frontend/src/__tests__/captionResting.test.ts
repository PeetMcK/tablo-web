/**
 * Where a caption sits before anything moves it.
 *
 * The lift is the overlap between the box's resting position and the
 * transport band. Getting the resting position by measuring the box is wrong
 * exactly when it matters: the box has a transition, so a reading taken
 * during one catches it partway, the lift computed from it is short,
 * applying that lift starts another transition, and the next reading is
 * shorter still. Measured on ABC, a caption overlapping the controls by
 * forty-eight pixels climbed a hundred and fifty-two - the whole band, by a
 * different route than the anchor rule this replaced.
 */

import { describe, it, expect } from "vitest";

import { placeInSafeArea, restingBottomPx } from "../lib/captions/safeArea";
import { liftToClearChrome, CHROME_BOTTOM_BAND_PX, CHROME_CLEARANCE_PX }
  from "../lib/playerChrome";

/** A 1000px stage starting at the top of the viewport. */
const STAGE_TOP = 0;
const STAGE_HEIGHT = 1000;
const STAGE_BOTTOM = STAGE_TOP + STAGE_HEIGHT;

describe("a caption's resting position", () => {
  it("hangs a top-anchored box below its placement", () => {
    const placement = placeInSafeArea("top-left", 0, 50);
    // 50% of the safe area is 50% of the stage; the box hangs below it.
    expect(restingBottomPx(STAGE_TOP, STAGE_HEIGHT, placement, 40)).toBe(540);
  });

  it("hangs a bottom-anchored box above its placement", () => {
    const placement = placeInSafeArea("bottom-left", 0, 50);
    expect(restingBottomPx(STAGE_TOP, STAGE_HEIGHT, placement, 40)).toBe(500);
  });

  it("does not depend on any lift already applied", () => {
    // The whole point: the same inputs give the same answer however far the
    // box has been moved, so repeated passes settle instead of climbing.
    const placement = placeInSafeArea("bottom-left", 10, 99);
    const first = restingBottomPx(STAGE_TOP, STAGE_HEIGHT, placement, 60);
    const again = restingBottomPx(STAGE_TOP, STAGE_HEIGHT, placement, 60);
    expect(again).toBe(first);
  });

  it("lifts a low caption by the overlap and no more", () => {
    const placement = placeInSafeArea("bottom-left", 10, 99);
    const bottom = restingBottomPx(STAGE_TOP, STAGE_HEIGHT, placement, 60);
    const lift = liftToClearChrome(bottom, STAGE_BOTTOM);

    // It does overlap, and by less than the whole band - which is what the
    // two previous rules both got wrong in opposite directions.
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeLessThan(CHROME_BOTTOM_BAND_PX + CHROME_CLEARANCE_PX);

    // And once lifted, it clears: the band's top edge is where it now ends.
    expect(bottom - lift).toBe(STAGE_BOTTOM - (CHROME_BOTTOM_BAND_PX + CHROME_CLEARANCE_PX));
  });

  it("leaves a caption riding above a lower-third where it is", () => {
    // NBC puts captions above its banner, well clear of the transport. This
    // is the case that used to jump a hundred and fifty pixels.
    const placement = placeInSafeArea("top-left", 12, 75);
    const bottom = restingBottomPx(STAGE_TOP, STAGE_HEIGHT, placement, 60);
    expect(liftToClearChrome(bottom, STAGE_BOTTOM)).toBe(0);
  });
});
