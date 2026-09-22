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

/**
 * How many characters wide a full-width 16:9 caption window is, per CEA-708-E.
 *
 * Two grids are easy to confuse and were: a window is *anchored* on a 210x75
 * grid of the frame, but its own `colCount` is a count of character cells,
 * which tops out at 42 across for 16:9. Sizing a window by dividing its
 * columns into 210 therefore makes every caption about five times too narrow
 * - a 32-column block came out at 12% of the frame - and the text then
 * re-wraps inside a sliver, which is what "708 renders too narrow and
 * off-centre" was. The anchor arithmetic was right the whole time.
 */
export const WINDOW_COLUMNS_16_9 = 42;

/**
 * The CEA-608 display grid: 15 rows of 32 columns.
 *
 * 608 is not the positionless standard this app first took it for. A
 * Preamble Address Code carries a row and an indent, the parser tracks both,
 * and flattening the screen to a string threw them away - so every 608
 * caption was drawn bottom-centre whatever the broadcaster asked for.
 *
 * (The vendored parser allocates 100 columns per row to tolerate overflow.
 * The standard's displayable width is 32, which is what a position means.)
 */
export const SCREEN_COLUMNS_608 = 32;
export const SCREEN_ROWS_608 = 15;

/**
 * How wide a window of `columns` character cells is, as a percentage of the
 * stage.
 *
 * Of the stage and not of the safe area, because that is the unit CSS wants
 * back. A full-width window is the whole safe area and no more.
 */
export function windowWidthPercent(
  columns: number,
  gridColumns: number = WINDOW_COLUMNS_16_9,
): number {
  const grid = Math.max(1, gridColumns);
  const cells = Math.max(1, Math.min(grid, columns));
  return (cells / grid) * SAFE_AREA_PERCENT;
}

export interface Placement {
  /** CSS `left`, as a percentage of the stage. */
  left: string;
  /** CSS `top`, as a percentage of the stage. */
  top: string;
  /** The translation that puts the requested anchor point on that spot. */
  transform: string;
  /**
   * The same `top`, as a number, and the share of the box's own height the
   * transform shifts it by: 0 anchoring its top edge, -100 its bottom.
   *
   * Together these give the box's resting position without reading it off
   * the page. Reading it off the page is wrong while the box is moving: it
   * has a transition, so a measurement taken during one catches it partway
   * and the lift computed from it is too small, which then moves it further,
   * which measures smaller still. Measured on ABC, a caption overlapping the
   * transport by forty-eight pixels climbed a hundred and fifty-two.
   */
  topPercent: number;
  anchorShiftYPercent: number;
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
    topPercent: top,
    anchorShiftYPercent: y,
  };
}

/**
 * Where the bottom edge of a placed box sits when nothing has moved it.
 *
 * Worked out rather than measured, because the box has a transition and a
 * measurement taken during one catches it partway. A lift computed from that
 * is short, applying it starts another transition, and the next reading is
 * shorter still - the caption climbs by increments until it saturates. On
 * ABC a caption overlapping the controls by forty-eight pixels rose a
 * hundred and fifty-two.
 *
 * `stageTop` and `stageHeight` are the stage in viewport coordinates;
 * `height` is the box's own, which is the one thing a transform leaves alone
 * and so the one thing safe to measure while it moves.
 */
export function restingBottomPx(
  stageTop: number,
  stageHeight: number,
  placement: Pick<Placement, "topPercent" | "anchorShiftYPercent">,
  height: number,
): number {
  const top = stageTop
    + (placement.topPercent / 100) * stageHeight
    + (placement.anchorShiftYPercent / 100) * height;
  return top + height;
}
