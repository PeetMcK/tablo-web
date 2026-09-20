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
  return {
    firstPtsSeconds: null, samplesPlayed: 0, sampleRate,
    anchorContextTime: null, epoch: 0,
  };
}

/** The first chunk sets where the clock begins; later ones do not move it. */
export function notePts(state: SinkState, ptsSeconds: number): void {
  if (state.firstPtsSeconds === null) state.firstPtsSeconds = ptsSeconds;
}

export function onSamplesPlayed(
  state: SinkState,
  framesPlayed: number,
  contextTime?: number,
  epoch?: number,
): void {
  // A report the worklet posted before it was told to flush describes the old
  // position. Added to counters the seek has just zeroed, it moves the clock
  // ahead of the sound by up to a tenth of a second — permanently, because
  // nothing ever corrects it.
  if (epoch !== undefined && epoch !== state.epoch) return;
  state.samplesPlayed += framesPlayed;
  // Re-anchored on every report, so interpolation between them corrects
  // rather than accumulates.
  if (contextTime !== undefined) state.anchorContextTime = contextTime;
}

/**
 * What a seek does to the accounting.
 *
 * Cleared rather than re-based: the next chunk to arrive anchors the clock,
 * which is the same path a fresh session takes.
 */
export function flushState(state: SinkState): void {
  state.firstPtsSeconds = null;
  state.samplesPlayed = 0;
  state.anchorContextTime = null;
  state.epoch += 1;
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
  /**
   * Seconds the clock is ahead of the newest decoded frame.
   *
   * Diagnostic only. It was the fallback's starvation detector and was no good
   * at it — the presenter is ticked before this is read, so an empty queue
   * reports zero — but as a description of a stall found some other way it
   * still says something useful.
   */
  starvedBy(newestFramePts: number | null): number;
  /**
   * Whether the context is actually rendering.
   *
   * A suspended context renders no samples, so the clock does not advance and
   * no field is ever due — which looks exactly like a decoder producing
   * nothing, and used to be failed as one before the viewer had a chance to
   * click.
   */
  readonly contextState: AudioContextState;
  /**
   * Silence the output without stopping it.
   *
   * Muting must not touch the clock: the worklet keeps rendering, so time
   * keeps advancing and video keeps playing. Suspending the context instead
   * would freeze the picture along with the sound.
   */
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  /**
   * The level, 0..1, held apart from mute.
   *
   * Both ride the same gain node, so the node's value is the product of the
   * two rather than either one of them. Setting a level while muted must not
   * un-silence the output, and unmuting must give back the level that was
   * set — which the node cannot remember on its own.
   */
  setVolume(volume: number): void;
  readonly volume: number;
  /** Drop what is queued — for a seek. */
  flush(): void;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  destroy(): Promise<void>;
  /** For `tabloDebug()`: what the sink has been given and has played. */
  diagnostics(): Record<string, unknown>;
}

/**
 * A WAV of silence: 8-bit unsigned mono PCM, whose rest value is 128.
 *
 * Bytes rather than a Blob so the shape is testable without a DOM. Ten
 * seconds at 8kHz is 80KB, which nothing will notice; the length is what
 * matters, see the anchor element in `createAudioSink`.
 */
export function silentWavBytes(
  seconds = 10, sampleRate = 8000,
): Uint8Array<ArrayBuffer> {
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM fmt chunk
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);  // bytes per second: one per frame
  view.setUint16(32, 1, true);           // block align
  view.setUint16(34, 8, true);           // bits per sample
  tag(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return bytes;
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

  // The OS media hub (macOS Now Playing, the hardware play/pause and seek
  // keys) binds to a page only through a playing HTMLMediaElement that Chrome
  // counts as an ordinary player. The WASM path draws to a canvas and sounds
  // through Web Audio, so it has none; a hidden <audio> is kept playing
  // alongside so that the page has one.
  //
  // It plays a file of silence, not the sound. Feeding it the mix through a
  // MediaStreamAudioDestinationNode was tried first, and that is exactly the
  // shape Chrome refuses: an element on a MediaStream is a one-shot player
  // (WebMediaPlayerMS reports MediaContentType::kOneShot and an infinite
  // duration), and MediaSessionImpl::IsControllable() is false for a session
  // with only those — before the Media Session API's metadata or
  // playbackState is even consulted. Measured 2026-09-20 in
  // chrome://media-internals › Audio Focus: the MediaStream anchor produced
  // no session at all; a file-backed one reads
  // "Gain Active Playing { HasAudio } Controllable".
  //
  // So the sound stays on `context.destination`, and the anchor loops ten
  // seconds of 8-bit silence at full volume. Full volume and unmuted matter:
  // Chrome treats a muted element as having no audio, and a player without
  // audio gets no session. Ten seconds matters too: under five, focus is
  // transient and the hub does not show it. The viewer's volume and mute
  // still ride the gain node. VideoPlayer's Media Session wiring puts the
  // real title, position and duration over this element's own.
  const anchor = document.createElement("audio");
  const silence = URL.createObjectURL(
    new Blob([silentWavBytes()], { type: "audio/wav" }),
  );
  anchor.src = silence;
  anchor.loop = true;
  anchor.autoplay = true;
  anchor.volume = 1;
  try {
    anchor.style.display = "none";
    document.body.append(anchor);
  } catch {
    // No DOM (non-browser context): the element still plays detached.
  }
  void anchor.play().catch(() => {
    // Blocked without a gesture; `resume()` retries once the viewer acts.
  });

  const state = createSinkState(context.sampleRate);
  let muted = false;
  // Full until told otherwise, matching the gain node's own starting value.
  let volume = 1;
  let pushed = 0;
  let rateWarned = false;
  let heartbeat: { calls: number; queued: number } | null = null;

  /** Frames handed to the worklet, so buffer depth can be derived. */
  let framesSent = 0;

  /**
   * Audio written to the output but not yet audible.
   *
   * Read once per message rather than per clock read: it is a property of the
   * device, and reading it sixty times a second on the main thread buys
   * nothing. `outputLatency` is the whole path where the browser reports it;
   * `baseLatency` is the part it always knows.
   */
  const latency = () =>
    (context as AudioContext & { outputLatency?: number }).outputLatency
    ?? context.baseLatency ?? 0;

  type Report = { rendered: number; at: number; epoch: number };
  node.port.onmessage = (
    event: MessageEvent<number | Report | { calls: number; queued: number }>,
  ) => {
    // A bare number is the old shape; kept because the worklet is a separate
    // file that a stale service worker can serve for a while after a deploy.
    if (typeof event.data === "number") {
      onSamplesPlayed(state, event.data, context.currentTime);
      return;
    }
    if ("rendered" in event.data) {
      const report = event.data;
      onSamplesPlayed(state, report.rendered, report.at, report.epoch);
      return;
    }
    heartbeat = event.data;
  };

  return {
    push(chunk: DecodedAudioChunk) {
      // The clock counts at the context's rate, and the resample graph emits at
      // the stream's. ATSC A/52 mandates 48kHz and the context is created at
      // 48kHz, so these agree — but the assumption is load-bearing rather than
      // incidental: a mismatch plays pitch-shifted *and* runs the clock at the
      // wrong speed, which would look like drift rather than like a wrong
      // sample rate. Said out loud once, so it is diagnosable if it ever
      // happens.
      if (chunk.sampleRate !== state.sampleRate && !rateWarned) {
        rateWarned = true;
        console.warn(
          `[wasmlive] audio is ${chunk.sampleRate}Hz but the output is` +
          ` ${state.sampleRate}Hz: playback will be pitch-shifted and the clock` +
          ` will run at the wrong rate`,
        );
      }
      notePts(state, chunk.ptsSeconds);
      pushed++;
      // Interleaved stereo: two samples per frame of audio.
      framesSent += chunk.samples.length / 2;
      node.port.postMessage(chunk.samples, [chunk.samples.buffer]);
    },
    get bufferedSeconds() {
      return Math.max(0, (framesSent - state.samplesPlayed) / state.sampleRate);
    },
    get clockSeconds() { return sinkClockSeconds(state, context.currentTime, latency()); },
    get contextState() { return context.state; },
    starvedBy: (newestFramePts: number | null) =>
      starvedBy(state, newestFramePts, context.currentTime, latency()),
    setMuted(next: boolean) {
      muted = next;
      gain.gain.value = next ? 0 : volume;
    },
    get muted() { return muted; },
    setVolume(next: number) {
      volume = Math.min(1, Math.max(0, next));
      // Held, not applied, while muted: unmuting reads it back.
      if (!muted) gain.gain.value = volume;
    },
    get volume() { return volume; },
    flush() {
      // What was queued belonged to where playback was, not where it is going —
      // and so did the clock. Dropping the audio without clearing the clock
      // leaves it counting from the original first timestamp while the decoder
      // emits the new position's, so after a rewind the playhead reads ten
      // seconds ahead of every frame arriving. Measured: `starvedBy` reporting
      // the size of the seek, the starvation rule firing twice, and the channel
      // handed back to the transcode on the first press of Back 10s.
      flushState(state);
      framesSent = 0;
      // The epoch goes with it, so a report the worklet posted a moment ago —
      // already on its way here — is discarded rather than added to counters
      // that have just been zeroed.
      node.port.postMessage({ flush: true, epoch: state.epoch });
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
      clockSeconds: sinkClockSeconds(state, context.currentTime, latency()),
      outputLatency: Number(latency().toFixed(4)),
    }),
    async resume() {
      await context.resume();
      // The anchor may have been blocked at creation (no gesture yet); the
      // viewer pressing play is that gesture, so try again here.
      try { await anchor.play(); } catch { /* stays paused; retried next time */ }
    },
    suspend: () => context.suspend(),
    async destroy() {
      node.port.onmessage = null;
      node.disconnect();
      try {
        anchor.pause();
        anchor.removeAttribute("src");
        anchor.load();
        anchor.remove();
        URL.revokeObjectURL(silence);
      } catch { /* already gone */ }
      await context.close();
    },
  };
}
