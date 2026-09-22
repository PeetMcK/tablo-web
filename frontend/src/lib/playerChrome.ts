/**
 * Dimensions the player's chrome and the things that must clear it agree on.
 *
 * One constant rather than the same number written twice: the scrim gradient
 * and the caption overlay both need to know where the transport band starts,
 * and a caption sitting on top of the scrubber is exactly what happens when
 * the two drift apart.
 */

/**
 * Height of the bottom band the transport occupies, in CSS pixels.
 *
 * Measured from the scrim gradient, which fades to full opacity across this
 * distance because that is what it takes to make the scrubber and the buttons
 * legible over arbitrary video.
 */
export const CHROME_BOTTOM_BAND_PX = 132;

/** A little air between whatever is being cleared and the band's top edge. */
export const CHROME_CLEARANCE_PX = 8;

/**
 * How far something must rise to clear the transport, in CSS pixels.
 *
 * Zero unless it actually overlaps. Captions used to be lifted on a rule
 * about where the broadcaster anchored them - anything below three quarters
 * of the frame moved, and moved by the whole height of the band - which knows
 * the anchor but not where the box ends up. A caption sitting comfortably
 * above the controls would jump a hundred and fifty pixels up the picture to
 * clear a bar it was never near. Whether two boxes overlap is a question
 * about their edges, and the answer is also the distance.
 *
 * Both arguments are viewport coordinates, as `getBoundingClientRect` gives
 * them.
 */
export function liftToClearChrome(boxBottom: number, stageBottom: number): number {
  const bandTop = stageBottom - (CHROME_BOTTOM_BAND_PX + CHROME_CLEARANCE_PX);
  return Math.max(0, Math.round(boxBottom - bandTop));
}
