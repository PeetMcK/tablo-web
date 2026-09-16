/**
 * Audio out, and the clock that comes with it.
 *
 * The state functions are kept apart from the AudioContext plumbing because
 * the accounting is the part with consequences: everything on screen is timed
 * against it, and it is the only part that can be tested without a browser.
 */

import { audioClockSeconds, starvationSeconds } from "./audioClock";
import type { AudioClockState } from "./audioClock";
import type { DecodedAudioChunk } from "./types";

export type SinkState = AudioClockState;

export function createSinkState(sampleRate: number): SinkState {
  return { firstPtsSeconds: null, samplesPlayed: 0, sampleRate };
}

/** The first chunk sets where the clock begins; later ones do not move it. */
export function notePts(state: SinkState, ptsSeconds: number): void {
  if (state.firstPtsSeconds === null) state.firstPtsSeconds = ptsSeconds;
}

export function onSamplesPlayed(state: SinkState, framesPlayed: number): void {
  state.samplesPlayed += framesPlayed;
}

export const sinkClockSeconds = audioClockSeconds;
export const starvedBy = starvationSeconds;

export interface AudioSink {
  push(chunk: DecodedAudioChunk): void;
  /** Media seconds, or null before any audio has played. */
  readonly clockSeconds: number | null;
  /** Seconds the clock is ahead of the newest decoded frame. */
  starvedBy(newestFramePts: number | null): number;
  /** Drop what is queued — for a seek. */
  flush(): void;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  destroy(): Promise<void>;
}

export async function createAudioSink(
  context: AudioContext,
  workletUrl: string,
): Promise<AudioSink> {
  await context.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(context, "pcm-processor", { outputChannelCount: [2] });
  node.connect(context.destination);

  const state = createSinkState(context.sampleRate);
  node.port.onmessage = (event: MessageEvent<number>) => onSamplesPlayed(state, event.data);

  return {
    push(chunk: DecodedAudioChunk) {
      notePts(state, chunk.ptsSeconds);
      node.port.postMessage(chunk.samples, [chunk.samples.buffer]);
    },
    get clockSeconds() { return sinkClockSeconds(state); },
    starvedBy: (newestFramePts: number | null) => starvedBy(state, newestFramePts),
    flush() { node.port.postMessage(null); },
    resume: () => context.resume(),
    suspend: () => context.suspend(),
    async destroy() {
      node.port.onmessage = null;
      node.disconnect();
      await context.close();
    },
  };
}
