/**
 * The clock everything else follows.
 *
 * Wall time and requestAnimationFrame both drift against the media; the number
 * of samples the AudioWorklet has actually played does not. Video is presented
 * against this, so lip sync is a property of the design rather than something
 * to keep correcting.
 */

export interface AudioClockState {
  firstPtsSeconds: number | null;
  samplesPlayed: number;
  sampleRate: number;
}

export function audioClockSeconds(state: AudioClockState): number | null {
  if (state.firstPtsSeconds === null) return null;
  return state.firstPtsSeconds + state.samplesPlayed / state.sampleRate;
}

/**
 * How far the clock has outrun the newest frame the decoder has produced.
 *
 * Zero before anything has been decoded: startup is not starvation, and the
 * fallback machine has its own deadline for a first frame.
 */
export function starvationSeconds(
  state: AudioClockState,
  newestFramePts: number | null,
): number {
  const clock = audioClockSeconds(state);
  if (clock === null || newestFramePts === null) return 0;
  return Math.max(0, clock - newestFramePts);
}
