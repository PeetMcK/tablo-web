/**
 * The shapes the caption path passes around.
 *
 * Kept apart from both the extractor and the parser so that neither has to
 * import the other to name what it produces.
 */

/** One EIA-608 byte pair, as carried in ATSC picture user data. */
export interface CcPair {
  /**
   * The `cc_type` this pair was carried under.
   *
   * 0 and 1 are the two EIA-608 fields: field 1 carries CC1 and CC2, field 2
   * carries CC3, CC4 and XDS. 2 and 3 are DTVCC, which is how CEA-708 travels
   * - 3 starts a packet and 2 continues it.
   */
  field: 0 | 1 | 2 | 3;
  /** First byte, odd parity bit still set. */
  a: number;
  /** Second byte, odd parity bit still set. */
  b: number;
}

/** A line or block of caption text, and the span it is shown across. */
export interface CaptionCue {
  /**
   * When the cue appears.
   *
   * In whatever domain the producer works in: the decoder emits raw PTS, and
   * the session converts to media time when it is asked for a cue. See
   * `session.ts`.
   */
  startSeconds: number;
  endSeconds: number;
  /** Rows joined by newlines, as 608 captions are up to four rows. */
  text: string;
}

/**
 * One picture's caption bytes, split by the standard they belong to.
 *
 * Split at extraction rather than filtered later because the two never share
 * a decoder: 608 is a byte-pair command stream, DTVCC is a sequenced packet
 * protocol, and a consumer of one has no use for the other.
 */
export interface CcData {
  cea608: CcPair[];
  dtvcc: CcPair[];
}

/** Which point of a caption window is pinned to its position. */
export type CaptionAnchor =
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "middle-center" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

/**
 * A caption that knows where the broadcaster put it.
 *
 * 608 has only the bottom rows to work with, so its cues carry no region and
 * render where they always have. 708 anchors a window somewhere in the frame,
 * which is the one thing it offers that 608 cannot.
 */
export interface PositionedCue extends CaptionCue {
  region?: {
    anchor: CaptionAnchor;
    /** Position of the anchor point, as a percentage of the safe area. */
    xPercent: number;
    yPercent: number;
    /**
     * The window's size in character cells, as the broadcaster declared it.
     *
     * Not decoration: the window's width is what makes a caption look like a
     * caption. Drawn to its content instead, a block the broadcaster sized at
     * 32 cells of a 210-cell frame becomes a narrow plate that re-wraps its
     * own lines, and its anchor then lands the wrong part of the wrong box in
     * the right place. Which is what "708 renders off-centre for no reason"
     * was.
     */
    rows: number;
    columns: number;
    /**
     * The grid `columns` is counted in: 42 across for a 16:9 CEA-708 window,
     * 32 for a CEA-608 screen.
     *
     * Carried rather than assumed because the two standards count in
     * different units and mixing them is exactly the mistake that made every
     * 708 caption five times too narrow.
     */
    gridColumns: number;
    /**
     * How the broadcaster justified the text inside the window.
     *
     * A window is wider than its text, so where the text sits within it is a
     * decision the broadcaster made and not one to guess at.
     */
    align: "left" | "center" | "right";
  };
  /**
   * Styling, where the broadcaster set any.
   *
   * Taken from the first styled run of the cue. 708 allows style to change
   * mid-line; carrying that faithfully would mean rendering runs rather than a
   * string, which is not what these broadcasts need - measured on ABC, every
   * pen attribute arrives at its default.
   */
  style?: {
    foreground?: string;
    background?: string;
    italic?: boolean;
    underline?: boolean;
  };
}
