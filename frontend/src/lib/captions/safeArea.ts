/**
 * Turning a broadcaster's window position into somewhere on screen.
 *
 * Broadcast positions assume the title-safe area a television shows, not the
 * full frame: a caption anchored at the very bottom is meant to sit inside the
 * safe margin, and placed against the raw edges it lands half off-screen on an
 * overscanned source. So positions are mapped into the safe box rather than
 * the viewport, and clamped there — a broadcaster is free to send coordinates
 * that make no sense, and the viewer should still be able to read the words.
 */

import type { CaptionAnchor } from "./types";

/**
 * The title-safe portion of the frame, per SMPTE practice: the middle 80%.
 *
 * So a position of 0% lands at 10% of the viewport, and 100% at 90%. Held as
 * whole percent rather than a fraction because the arithmetic has to come out
 * exact - `(1 - 0.8) / 2 * 100` is 9.999999999999998, and a caption placed
 * there is a string nobody can assert on.
 */
export const SAFE_AREA_PERCENT = 80;

export interface Placement {
  /** CSS `left`, as a percentage of the stage. */
  left: string;
  /** CSS `top`, as a percentage of the stage. */
  top: string;
  /** The translation that puts the requested anchor point on that spot. */
  transform: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Where within the box the anchor sits, as fractions for `translate`. */
function anchorOffsets(anchor: CaptionAnchor): { x: number; y: number } {
  const [vertical, horizontal] = anchor.split("-");
  const x = horizontal === "left" ? 0 : horizontal === "right" ? -100 : -50;
  const y = vertical === "top" ? 0 : vertical === "bottom" ? -100 : -50;
  return { x, y };
}

/**
 * Place a caption window.
 *
 * `xPercent` and `yPercent` are the broadcaster's anchor position; `anchor`
 * says which point of the caption box that position refers to. The result
 * positions the box's top-left and then translates it so the named point lands
 * where it was asked to.
 */
export function placeInSafeArea(
  anchor: CaptionAnchor,
  xPercent: number,
  yPercent: number,
): Placement {
  const margin = (100 - SAFE_AREA_PERCENT) / 2;
  const left = margin + (clamp(xPercent) * SAFE_AREA_PERCENT) / 100;
  const top = margin + (clamp(yPercent) * SAFE_AREA_PERCENT) / 100;
  const { x, y } = anchorOffsets(anchor);

  return {
    left: `${left}%`,
    top: `${top}%`,
    transform: `translate(${x}%, ${y}%)`,
  };
}
