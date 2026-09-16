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
  /**
   * Seconds of decoded audio waiting to be played.
   *
   * This is what the transport paces against. Pacing against the clock
   * deadlocks: the clock only advances while audio renders, audio only exists
   * if the transport fetched it, and the transport only fetches if the clock
   * moved. Buffer depth has no such cycle — it falls as audio plays and rises
   * as segments arrive.
   */
  readonly bufferedSeconds: number;
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
  /** For `tabloDebug()`: what the sink has been given and has played. */
  diagnostics(): Record<string, unknown>;
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
  let muted = false;
  let pushed = 0;
  let heartbeat: { calls: number; queued: number } | null = null;

  /** Frames handed to the worklet, so buffer depth can be derived. */
  let framesSent = 0;

  node.port.onmessage = (event: MessageEvent<number | { calls: number; queued: number }>) => {
    if (typeof event.data === "number") {
      onSamplesPlayed(state, event.data);
      return;
    }
    heartbeat = event.data;
  };

  return {
    push(chunk: DecodedAudioChunk) {
      notePts(state, chunk.ptsSeconds);
      pushed++;
      // Interleaved stereo: two samples per frame of audio.
      framesSent += chunk.samples.length / 2;
      node.port.postMessage(chunk.samples, [chunk.samples.buffer]);
    },
    get bufferedSeconds() {
      return Math.max(0, (framesSent - state.samplesPlayed) / state.sampleRate);
    },
    get clockSeconds() { return sinkClockSeconds(state); },
    starvedBy: (newestFramePts: number | null) => starvedBy(state, newestFramePts),
    setMuted(next: boolean) {
      muted = next;
      gain.gain.value = next ? 0 : 1;
    },
    get muted() { return muted; },
    flush() {
      // What was queued belonged to where playback was, not where it is going.
      framesSent = state.samplesPlayed;
      node.port.postMessage(null);
    },
    diagnostics: () => ({
      audioContext: context.state,
      chunksPushed: pushed,
      samplesPlayed: state.samplesPlayed,
      firstPts: state.firstPtsSeconds,
      workletCalls: heartbeat?.calls ?? 0,
      workletQueued: heartbeat?.queued ?? 0,
      framesSent,
      bufferedSeconds: Math.round(
        Math.max(0, (framesSent - state.samplesPlayed) / state.sampleRate) * 10,
      ) / 10,
      clockSeconds: sinkClockSeconds(state),
    }),
    resume: () => context.resume(),
    suspend: () => context.suspend(),
    async destroy() {
      node.port.onmessage = null;
      node.disconnect();
      await context.close();
    },
  };
}
