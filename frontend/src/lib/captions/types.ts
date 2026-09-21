/**
 * The shapes the caption path passes around.
 *
 * Kept apart from both the extractor and the parser so that neither has to
 * import the other to name what it produces.
 */

/** One EIA-608 byte pair, as carried in ATSC picture user data. */
export interface CcPair {
  /**
   * Which 608 field this pair belongs to.
   *
   * 0 is field 1, which carries CC1 and CC2; 1 is field 2, which carries CC3,
   * CC4 and XDS. `cc_type` 2 and 3 are DTVCC (CEA-708) and never appear here.
   */
  field: 0 | 1;
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
