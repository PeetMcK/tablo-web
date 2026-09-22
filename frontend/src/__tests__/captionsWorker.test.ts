/**
 * Cues cross the worker boundary the way media does.
 *
 * Which means stamped with an epoch and dropped by the page when it is stale.
 * A caption from before a seek is the same mistake as a frame from before one,
 * and it is cheaper to rule out here than to explain later.
 */

import { describe, it, expect } from "vitest";

import { createWorkerHandler } from "../lib/wasmlive/workerProtocol";
import type { FromWorker } from "../lib/wasmlive/workerProtocol";
import type { DecodeOutput, LibavDecoder } from "../lib/wasmlive/libavClient";

function harness() {
  const posted: FromWorker[] = [];
  let emit: (out: DecodeOutput) => void = () => {};

  const decoder: LibavDecoder = {
    push: async () => {},
    flush: async () => {},
    reset: async () => {},
    close: async () => {},
    stats: () => ({
      bytesFed: 0, bytesDelivered: 0, opened: true, bytesAtOpen: null, msToOpen: null,
      videoStream: true, audioStream: true, videoFrames: 0, audioChunks: 0,
      videoDropped: 0, audioDropped: 0, captionPairs: 0, captionCues: 0,
    }),
  };

  const handle = createWorkerHandler(
    async (onOutput) => { emit = onOutput; return decoder; },
    (message) => { posted.push(message); },
  );

  return { posted, handle, emitOutput: (out: DecodeOutput) => emit(out) };
}

const cue = { startSeconds: 1, endSeconds: 3, text: "HELLO" };

describe("the worker's caption messages", () => {
  it("posts cues stamped with the current epoch", async () => {
    const { posted, handle, emitOutput } = harness();
    await handle({ type: "open" });
    emitOutput({ video: [], audio: [], captions: [cue], captions708: [] });

    expect(posted).toContainEqual(
      { type: "captions", cues: [cue], epoch: 0, source: "cea608" },
    );
  });

  it("says nothing when a read round produced no captions", async () => {
    const { posted, handle, emitOutput } = harness();
    await handle({ type: "open" });
    emitOutput({ video: [], audio: [], captions: [], captions708: [] });

    expect(posted.some((m) => m.type === "captions")).toBe(false);
  });

  it("stamps cues with the epoch adopted at the last reset", async () => {
    const { posted, handle, emitOutput } = harness();
    await handle({ type: "open" });
    await handle({ type: "reset", epoch: 4 });
    emitOutput({ video: [], audio: [], captions: [cue], captions708: [] });

    expect(posted).toContainEqual(
      { type: "captions", cues: [cue], epoch: 4, source: "cea608" },
    );
  });
});
