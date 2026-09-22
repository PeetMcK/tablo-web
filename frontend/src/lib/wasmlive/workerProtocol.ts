/**
 * What the worker and the page say to each other.
 *
 * Kept apart from the worker entry point so the message handling is ordinary
 * testable code rather than something that needs a real Worker to exercise.
 */

import type { PositionedCue } from "../captions";
import type { DecodeOutput, DecoderStats, LibavDecoder } from "./libavClient";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

/**
 * Which side of a seek a message belongs to.
 *
 * The page bumps it on every seek and stamps it on what it sends; the worker
 * adopts it from the reset and stamps it on the media it sends back. Anything
 * carrying a stale epoch came from where playback *was*, and the page discards
 * it without having to reason about ordering.
 *
 * ffplay does the same thing under the name `serial`: every packet and frame
 * carries one, `video_refresh` drops frames whose serial is stale, and
 * `get_clock` returns NAN rather than a time from the old position.
 */
/** Which standard a batch of cues was decoded from. */
export type CaptionStandard = "cea608" | "cea708";

export type ToWorker =
  | { type: "open" }
  | { type: "segment"; bytes: ArrayBuffer; epoch: number }
  | { type: "reset"; epoch: number }
  | { type: "close" };

export type FromWorker =
  /**
   * Posted the instant the worker's module body runs, before anything is
   * asked of it.
   *
   * It separates the two silences that look identical from the page: a worker
   * whose script never executed, and a worker that executed and then hung
   * loading the decoder. Without it the only way to tell them apart is to
   * reproduce the failure by hand in the console.
   */
  | { type: "booted" }
  | { type: "opened" }
  /**
   * The decoder has been torn down and rebuilt at this epoch.
   *
   * No longer load-bearing for correctness — the epoch on the media itself is
   * what the page filters on — but it is the only confirmation that the
   * rebuild happened at all, and it is posted from a `finally` so that a reset
   * which throws still says so. An ack that is skipped on failure is worse
   * than no ack: it leaves the page waiting on a watershed that will never
   * come.
   */
  | { type: "reset"; epoch: number }
  /**
   * Decoded media, stamped with the epoch it was decoded under.
   *
   * Audio especially: it anchors the clock, so one chunk from before a seek
   * landing after the flush puts the playhead back at the old position while
   * frames arrive from the new one.
   */
  | { type: "video"; frames: DecodedVideoFrame[]; epoch: number }
  | { type: "audio"; chunks: DecodedAudioChunk[]; epoch: number }
  /**
   * Caption cues, stamped like the media they belong beside.
   *
   * Small enough to copy rather than transfer — a cue is two numbers and a
   * line of text — and epoch-filtered on the page for the same reason frames
   * are: one decoded before a seek describes what the viewer just left.
   */
  | { type: "captions"; cues: PositionedCue[]; epoch: number; source: CaptionStandard }
  | { type: "stats"; stats: DecoderStats }
  /**
   * The decoder has been freed and the worker may be terminated.
   *
   * The page used to post `close` and call `terminate()` in the same breath,
   * which kills the thread before it dequeues the message - so `close` never
   * ran, and the frees inside it were dead code that had never executed in
   * production.
   */
  | { type: "closed" }
  | { type: "error"; message: string };

export function createWorkerHandler(
  /**
   * Makes a decoder that emits through the callbacks it is given.
   *
   * `onError` matters as much as `onOutput`: the read pump can die at a moment
   * when no `push` is pending - pacing holds segments back whenever the field
   * queue is full or the viewer has paused - and a failure reported only on
   * the next push surfaced six seconds later as the frozen-picture watchdog,
   * naming the wrong cause.
   */
  make: (
    onOutput: (out: DecodeOutput) => void,
    onError: (error: Error) => void,
  ) => Promise<LibavDecoder>,
  post: (message: FromWorker, transfer: Transferable[]) => void,
): (message: ToWorker) => Promise<void> {
  let decoder: LibavDecoder | null = null;
  let opening: Promise<LibavDecoder> | null = null;
  /** Which side of the last seek this decoder's output belongs to. */
  let epoch = 0;

  const emit = (out: DecodeOutput) => {
    // Buffers are transferred, not copied: a 1080p frame is 3.1MB, and at 60p
    // copying them would cost more than the decode does.
    if (out.video.length) {
      post({ type: "video", frames: out.video, epoch }, out.video.map((f) => f.data.buffer));
    }
    if (out.audio.length) {
      post({ type: "audio", chunks: out.audio, epoch }, out.audio.map((c) => c.samples.buffer));
    }
    if (out.captions.length) {
      post({ type: "captions", cues: out.captions, epoch, source: "cea608" }, []);
    }
    if (out.captions708.length) {
      post({ type: "captions", cues: out.captions708, epoch, source: "cea708" }, []);
    }
  };

  /**
   * Messages are handled one at a time, in order.
   *
   * Opening the decoder means loading and instantiating 2.5MB of wasm, and the
   * session posts its first segments immediately afterwards. Handled
   * concurrently, every one of those arrives while `decoder` is still null and
   * is dropped — which is exactly what happened: a decoder that opened
   * successfully and then produced nothing at all.
   */
  let chain: Promise<void> = Promise.resolve();

  const handle = async (message: ToWorker) => {
    try {
      switch (message.type) {
        case "open":
          if (opening) return;  // a second open is a no-op, not a second decoder
          opening = make(emit, (error) => post({ type: "error", message: error.message }, []));
          decoder = await opening;
          post({ type: "opened" }, []);
          return;

        case "segment":
          // A segment that beat `open`, or arrived after `close`, is simply
          // dropped: there is nothing to decode it with.
          if (!decoder) return;
          await decoder.push(new Uint8Array(message.bytes));
          // Sent with every segment rather than on request, so that whatever
          // the page reports is current at the moment it is read. What it
          // costs is nine numbers; what it buys is the difference between "the
          // decoder produced nothing" and knowing which of the four reasons.
          post({ type: "stats", stats: decoder.stats() }, []);
          return;

        case "reset":
          try {
            // Tearing down drains the decoder, and what drains out of it came
            // from the old position — so the epoch moves *after* the rebuild,
            // not before. Adopting it first would stamp the very frames this
            // exists to discard with the epoch that means "keep me".
            await decoder?.reset();
          } finally {
            epoch = message.epoch;
            // In a `finally`, so a reset that throws still reports the
            // watershed, and the outer catch's `error` follows it. An ack
            // skipped on failure is worse than no ack at all.
            post({ type: "reset", epoch }, []);
          }
          return;

        case "close":
          try {
            await decoder?.close();
          } finally {
            decoder = null;
            opening = null;
            // In a `finally`: a close that throws must still release the page,
            // or it waits out the grace period for nothing.
            post({ type: "closed" }, []);
          }
          return;
      }
    } catch (e) {
      post({ type: "error", message: e instanceof Error ? e.message : String(e) }, []);
    }
  };

  return (message: ToWorker) => {
    chain = chain.then(() => handle(message));
    return chain;
  };
}
