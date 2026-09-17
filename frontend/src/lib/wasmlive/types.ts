/**
 * One decoded picture, planar I420, packed to the minimum stride.
 *
 * Still interlaced. Phase 0 measured `bwdif` in WASM at 0.82x realtime against
 * 8.8x for the decoder alone, so deinterlacing happens on the GPU instead and
 * a frame carries what the shader needs to know about its fields rather than
 * arriving already resolved into progressive lines.
 */
export interface DecodedVideoFrame {
  data: Uint8Array;
  width: number;
  height: number;
  ptsSeconds: number;
  /** Seconds until the next frame, which is what times the second field. */
  durationSeconds: number;
  /** False for progressive content — commercials, some subchannels. */
  interlaced: boolean;
  /** Which field is first in time. Meaningless when not interlaced. */
  topFieldFirst: boolean;
  /**
   * Pixel shape, as width/height. 1 for square pixels.
   *
   * Broadcast subchannels are routinely anamorphic: 13.4 arrives as 720x480
   * with a sample aspect of 32:27, which is a 16:9 picture stored in a 1.5
   * frame. Drawn as if the pixels were square it is 16% too narrow, and
   * everything in it is tall and thin.
   */
  sampleAspectRatio: number;
}

/** Decoded audio, interleaved stereo float. */
export interface DecodedAudioChunk {
  samples: Float32Array;
  sampleRate: number;
  ptsSeconds: number;
}

/** Which half of an interlaced frame a presentation slot is showing. */
export type FieldParity = "top" | "bottom";
