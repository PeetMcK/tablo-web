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
  /**
   * Silence the output without stopping it.
   *
   * Muting must not touch the clock: the worklet keeps rendering, so time
   * keeps advancing and video keeps playing. Suspending the context instead
   * would freeze the picture along with the sound.
   */
  setMuted(muted: boolean): void;
  readonly muted: boolean;
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
  const gain = context.createGain();
  node.connect(gain);
  gain.connect(context.destination);

  const state = createSinkState(context.sampleRate);
  node.port.onmessage = (event: MessageEvent<number>) => onSamplesPlayed(state, event.data);
  let muted = false;

  return {
    push(chunk: DecodedAudioChunk) {
      notePts(state, chunk.ptsSeconds);
      node.port.postMessage(chunk.samples, [chunk.samples.buffer]);
    },
    get clockSeconds() { return sinkClockSeconds(state); },
    starvedBy: (newestFramePts: number | null) => starvedBy(state, newestFramePts),
    setMuted(next: boolean) {
      muted = next;
      gain.gain.value = next ? 0 : 1;
    },
    get muted() { return muted; },
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
