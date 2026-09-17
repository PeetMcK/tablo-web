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
  /** The AudioContext time when `samplesPlayed` was last reported. */
  anchorContextTime: number | null;
}

/**
 * How far past the last report the clock may be carried.
 *
 * Interpolation assumes audio is still being rendered, and on an underrun that
 * assumption is wrong: the worklet emits silence and stops counting frames
 * while `currentTime` runs on regardless. Capping just above the reporting
 * interval means a stall freezes the picture, as it should, instead of letting
 * video sail past sound.
 */
export const MAX_INTERPOLATION_SECONDS = 0.12;

/**
 * The playhead, in media seconds.
 *
 * `contextTime` smooths it between reports. The worklet reports every 4800
 * frames — a tenth of a second — so without this the clock is a staircase with
 * ten steps a second, and video presented against it can only be drawn ten
 * times a second however many fields are ready. Measured on the real device:
 * 60 animation frames a second, a clock that moved on twelve of them, and 8
 * field presentations reaching the screen out of 59.94 offered.
 *
 * Each report re-anchors it, so this interpolates rather than free-runs: any
 * error is discarded a tenth of a second later instead of accumulating.
 */
export function audioClockSeconds(
  state: AudioClockState,
  contextTime?: number,
): number | null {
  if (state.firstPtsSeconds === null) return null;
  const played = state.firstPtsSeconds + state.samplesPlayed / state.sampleRate;
  if (contextTime === undefined || state.anchorContextTime === null) return played;
  const since = Math.max(0, contextTime - state.anchorContextTime);
  return played + Math.min(since, MAX_INTERPOLATION_SECONDS);
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
  contextTime?: number,
): number {
  const clock = audioClockSeconds(state, contextTime);
  if (clock === null || newestFramePts === null) return 0;
  return Math.max(0, clock - newestFramePts);
}
