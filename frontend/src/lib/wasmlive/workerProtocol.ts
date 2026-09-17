/**
 * What the worker and the page say to each other.
 *
 * Kept apart from the worker entry point so the message handling is ordinary
 * testable code rather than something that needs a real Worker to exercise.
 */

import type { DecodeOutput, DecoderStats, LibavDecoder } from "./libavClient";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

export type ToWorker =
  | { type: "open" }
  | { type: "segment"; bytes: ArrayBuffer }
  | { type: "reset" }
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
   * The decoder has been torn down and rebuilt, and everything the page was
   * sent before this belongs to where playback was.
   *
   * Messages are handled in order, so this is a watershed: frames and audio
   * posted before it came from the old position. Without it the page cannot
   * tell them apart, and a seek re-anchors its clock on whatever stale audio
   * happens to land after the flush.
   */
  | { type: "reset" }
  | { type: "video"; frames: DecodedVideoFrame[] }
  | { type: "audio"; chunks: DecodedAudioChunk[] }
  | { type: "stats"; stats: DecoderStats }
  | { type: "error"; message: string };

export function createWorkerHandler(
  /** Makes a decoder that emits through the callback it is given. */
  make: (onOutput: (out: DecodeOutput) => void) => Promise<LibavDecoder>,
  post: (message: FromWorker, transfer: Transferable[]) => void,
): (message: ToWorker) => Promise<void> {
  let decoder: LibavDecoder | null = null;
  let opening: Promise<LibavDecoder> | null = null;

  const emit = (out: DecodeOutput) => {
    // Buffers are transferred, not copied: a 1080p frame is 3.1MB, and at 60p
    // copying them would cost more than the decode does.
    if (out.video.length) {
      post({ type: "video", frames: out.video }, out.video.map((f) => f.data.buffer));
    }
    if (out.audio.length) {
      post({ type: "audio", chunks: out.audio }, out.audio.map((c) => c.samples.buffer));
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
          opening = make(emit);
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
          await decoder?.reset();
          post({ type: "reset" }, []);
          return;

        case "close":
          await decoder?.close();
          decoder = null;
          opening = null;
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
