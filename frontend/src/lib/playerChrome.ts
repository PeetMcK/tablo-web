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
