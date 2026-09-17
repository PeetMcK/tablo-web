/**
 * Turning the decoder's audio timestamps into a timeline the sink can count on.
 *
 * Two things are true at once and they pull in opposite directions.
 *
 * The decoder's own timestamps are the truth about *when* audio happens: they
 * carry drops, discontinuities, and the device's idea of the broadcast clock.
 * But they cannot be used directly, because buffersink re-bases what it emits
 * onto the filter graph's timeline rather than the stream's — on a live feed it
 * reported audio at 30.6s while video from the same instant read 69.6s, a
 * 39-second lip-sync error dressed up as a starving decoder.
 *
 * So the output timeline is counted in samples, which are exact, and corrected
 * from the input timestamps, which are authoritative. A gap is measured where
 * it is unambiguous — on the decoder's frames, before the graph — and carried
 * into the output as a permanent offset.
 *
 * What this replaces counted samples and nothing else: it read the decoder's
 * timestamp exactly once, at the first frame, and synthesised every one after
 * it. One AC-3 frame lost to a CRC error on marginal reception and every later
 * timestamp was 32ms low, for the life of the session — seconds of lip sync per
 * hour on a feed that drops a frame a minute. A real discontinuity was worse:
 * the clock kept counting from an origin an hour behind, no picture was ever
 * due, and the frozen-picture watchdog handed the channel back to the transcode
 * calling it a decode error.
 *
 * ffplay does the equivalent per frame: `audio_decode_frame` sets
 * `audio_clock = af->pts + nb_samples/sample_rate` for every frame it takes,
 * so a drop or a jump is corrected at the next one rather than accumulating.
 */

/**
 * How far a decoded frame may land from where it was expected before the gap
 * is treated as real.
 *
 * Under one AC-3 frame (1536 samples, 32ms at 48kHz), so a single dropped
 * frame is caught; well over any rounding in a 90kHz timebase, so ordinary
 * jitter is not. The graph's own steady-state delay cannot reach this
 * threshold either, because it is measured on the decoder's output rather than
 * the graph's — which is the whole reason the measurement happens there.
 */
export const GAP_SECONDS = 0.02;

export interface AudioTimeline {
  /** Media time of the first decoded frame; where the output timeline begins. */
  anchorOut: number | null;
  /** Where the next decoded frame should start if nothing were lost. */
  expectedIn: number | null;
  /** Output sample frames emitted since the anchor. */
  framesEmitted: number;
  /** Input gaps accumulated so far, carried into every later output timestamp. */
  drift: number;
}

export function createTimeline(): AudioTimeline {
  return { anchorOut: null, expectedIn: null, framesEmitted: 0, drift: 0 };
}

/**
 * Account for one frame as the decoder produced it.
 *
 * Called before the filter graph, on the frames whose timestamps mean
 * something.
 */
export function noteDecoded(
  timeline: AudioTimeline,
  ptsSeconds: number,
  frames: number,
  sampleRate: number,
): void {
  const advance = sampleRate > 0 ? frames / sampleRate : 0;

  if (timeline.anchorOut === null) {
    timeline.anchorOut = ptsSeconds;
    timeline.expectedIn = ptsSeconds + advance;
    return;
  }

  if (timeline.expectedIn !== null) {
    const gap = ptsSeconds - timeline.expectedIn;
    // Both directions. A stream that repeats a frame is as real as one that
    // drops it, and closing either silently is what puts lip sync out.
    if (Math.abs(gap) > GAP_SECONDS) timeline.drift += gap;
  }
  timeline.expectedIn = ptsSeconds + advance;
}

/** Media time for the next chunk of output. */
export function nextOutputPts(timeline: AudioTimeline, sampleRate: number): number {
  const counted = sampleRate > 0 ? timeline.framesEmitted / sampleRate : 0;
  return (timeline.anchorOut ?? 0) + counted + timeline.drift;
}

/** Account for output actually handed on, in sample frames. */
export function noteEmitted(timeline: AudioTimeline, frames: number): void {
  timeline.framesEmitted += frames;
}
