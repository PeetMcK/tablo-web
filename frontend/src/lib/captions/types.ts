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
