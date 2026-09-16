/**
 * What the worker and the page say to each other.
 *
 * Kept apart from the worker entry point so the message handling is ordinary
 * testable code rather than something that needs a real Worker to exercise.
 */

import type { LibavDecoder } from "./libavClient";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

export type ToWorker =
  | { type: "open" }
  | { type: "segment"; bytes: ArrayBuffer }
  | { type: "reset" }
  | { type: "close" };

export type FromWorker =
  | { type: "opened" }
  | { type: "video"; frames: DecodedVideoFrame[] }
  | { type: "audio"; chunks: DecodedAudioChunk[] }
  | { type: "error"; message: string };

export function createWorkerHandler(
  make: () => Promise<LibavDecoder>,
  post: (message: FromWorker, transfer: Transferable[]) => void,
): (message: ToWorker) => Promise<void> {
  let decoder: LibavDecoder | null = null;
  let opening: Promise<LibavDecoder> | null = null;

  const emit = (out: { video: DecodedVideoFrame[]; audio: DecodedAudioChunk[] }) => {
    // Buffers are transferred, not copied: a 1080p frame is 3.1MB, and at 60p
    // copying them would cost more than the decode does.
    if (out.video.length) {
      post({ type: "video", frames: out.video }, out.video.map((f) => f.data.buffer));
    }
    if (out.audio.length) {
      post({ type: "audio", chunks: out.audio }, out.audio.map((c) => c.samples.buffer));
    }
  };

  return async (message: ToWorker) => {
    try {
      switch (message.type) {
        case "open":
          if (opening) return;  // a second open is a no-op, not a second decoder
          opening = make();
          decoder = await opening;
          post({ type: "opened" }, []);
          return;

        case "segment":
          // A segment that beat `open`, or arrived after `close`, is simply
          // dropped: there is nothing to decode it with.
          if (!decoder) return;
          emit(await decoder.push(new Uint8Array(message.bytes)));
          return;

        case "reset":
          await decoder?.reset();
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
}
