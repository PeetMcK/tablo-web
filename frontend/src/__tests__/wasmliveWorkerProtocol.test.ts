import { describe, it, expect, vi } from "vitest";

import { createWorkerHandler } from "../lib/wasmlive/workerProtocol";
import type { FromWorker } from "../lib/wasmlive/workerProtocol";
import type { LibavDecoder } from "../lib/wasmlive/libavClient";

const frame = {
  data: new Uint8Array(6), width: 2, height: 2,
  ptsSeconds: 1, durationSeconds: 0.03337, interlaced: true, topFieldFirst: true, sampleAspectRatio: 1,
};
const chunk = { samples: new Float32Array(4), sampleRate: 48000, ptsSeconds: 1 };

/** A decoder that emits one frame and one chunk when anything is pushed. */
function fakeDecoder(
  onOutput: (out: { video: typeof frame[]; audio: typeof chunk[] }) => void,
  overrides: Partial<LibavDecoder> = {},
): LibavDecoder {
  return {
    push: vi.fn(async () => { onOutput({ video: [frame], audio: [chunk] }); }),
    flush: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    stats: vi.fn(() => ({
      bytesFed: 0, bytesDelivered: 0, opened: true, bytesAtOpen: 0, msToOpen: 0,
      videoStream: true, audioStream: true, videoFrames: 0, audioChunks: 0,
      videoDropped: 0, audioDropped: 0,
    })),
    ...overrides,
  };
}

/** Everything but the stats heartbeat, which rides along with every segment. */
const media = (messages: FromWorker[]) => messages.filter((m) => m.type !== "stats");

describe("createWorkerHandler", () => {
  it("answers open with opened", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (m) => posted.push(m));
    await handle({ type: "open" });
    expect(posted).toEqual([{ type: "opened" }]);
  });

  it("posts decoded video and audio for a segment", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });
    expect(media(posted).map((m) => m.type)).toEqual(["opened", "video", "audio"]);
  });

  it("transfers frame buffers rather than copying them", async () => {
    // A 1080p frame is 3.1MB; copying one per frame at 60p is 186MB/s of
    // pointless memcpy between the worker and the page.
    const transfers: Transferable[][] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (_m, t) => transfers.push(t));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });
    expect(transfers[1]).toEqual([frame.data.buffer]);
    expect(transfers[2]).toEqual([chunk.samples.buffer]);
  });

  it("says nothing when a segment decoded to nothing yet", async () => {
    const posted: FromWorker[] = [];
    const decoder = fakeDecoder(() => {}, { push: vi.fn(async () => {}) });
    const handle = createWorkerHandler(async () => decoder, (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });
    expect(media(posted)).toEqual([{ type: "opened" }]);
  });

  it("reports a decode failure as an error message", async () => {
    const posted: FromWorker[] = [];
    const decoder = fakeDecoder(() => {}, {
      push: vi.fn(async () => { throw new Error("bad packet"); }),
    });
    const handle = createWorkerHandler(async () => decoder, (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });
    expect(posted[1]).toEqual({ type: "error", message: "bad packet" });
  });

  it("reports a failure to open", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(
      async () => { throw new Error("no wasm"); },
      (m) => posted.push(m),
    );
    await handle({ type: "open" });
    expect(posted).toEqual([{ type: "error", message: "no wasm" }]);
  });

  it("forwards reset and close to the decoder", async () => {
    const decoder = fakeDecoder(() => {});
    const handle = createWorkerHandler(async () => decoder, () => {});
    await handle({ type: "open" });
    await handle({ type: "reset", epoch: 1 });
    await handle({ type: "close" });
    expect(decoder.reset).toHaveBeenCalledOnce();
    expect(decoder.close).toHaveBeenCalledOnce();
  });

  it("reports a decoder failure when it happens, not on the next segment", async () => {
    // The read pump can die at a moment when no push is pending: pacing holds
    // segments back whenever the field queue is full or the viewer has paused.
    // Reported only on the next push, the failure surfaced six seconds later
    // as the frozen-picture watchdog's "nothing drawn for 6s" - the right
    // session ended, under the wrong stated cause, with the real error still
    // sitting in a variable.
    const posted: FromWorker[] = [];
    let fail!: (error: Error) => void;
    const handle = createWorkerHandler(
      async (onOutput, onError) => { fail = onError; return fakeDecoder(onOutput); },
      (m) => posted.push(m),
    );
    await handle({ type: "open" });
    posted.length = 0;

    fail(new Error("libav read failed: -22"));

    expect(posted).toEqual([{ type: "error", message: "libav read failed: -22" }]);
  });

  it("stamps decoded media with the epoch it belongs to", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "reset", epoch: 4 });
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 4 });

    expect(media(posted).filter((m) => m.type === "video" || m.type === "audio"))
      .toEqual([
        { type: "video", frames: [frame], epoch: 4 },
        { type: "audio", chunks: [chunk], epoch: 4 },
      ]);
  });

  it("keeps the old epoch on whatever drains out of the decoder being torn down", async () => {
    // The teardown decodes what is still queued, and that came from the old
    // position. Adopting the new epoch before the rebuild would stamp the very
    // frames the seek exists to discard with the epoch that means "keep me".
    const posted: FromWorker[] = [];
    let emit!: (out: { video: typeof frame[]; audio: typeof chunk[] }) => void;
    const decoder = fakeDecoder(() => {}, {
      reset: vi.fn(async () => { emit({ video: [frame], audio: [] }); }),
    });
    const handle = createWorkerHandler(
      async (onOutput) => { emit = onOutput; return decoder; },
      (m) => posted.push(m),
    );
    await handle({ type: "open" });
    await handle({ type: "reset", epoch: 1 });

    expect(posted.find((m) => m.type === "video")).toMatchObject({ epoch: 0 });
  });

  it("acknowledges a reset even when the reset itself fails", async () => {
    // Skipped on failure, the acknowledgement leaves the page waiting on a
    // watershed that will never arrive — and under the old gate that meant
    // every later message was dropped for the life of the session.
    const posted: FromWorker[] = [];
    const decoder = fakeDecoder(() => {}, {
      reset: vi.fn(async () => { throw new Error("teardown failed"); }),
    });
    const handle = createWorkerHandler(async () => decoder, (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "reset", epoch: 2 });

    expect(posted).toContainEqual({ type: "reset", epoch: 2 });
    expect(posted).toContainEqual({ type: "error", message: "teardown failed" });
  });

  it("holds segments sent while the decoder is still opening", async () => {
    // Opening loads 2.5MB of wasm, and the session posts its first segments
    // straight afterwards. Handled concurrently they all land before the
    // decoder exists and are dropped — a decoder that opens and then decodes
    // nothing at all.
    const posted: FromWorker[] = [];
    let release!: () => void;
    const opened = new Promise<void>((resolve) => { release = resolve; });

    const handle = createWorkerHandler(
      async (onOutput) => { await opened; return fakeDecoder(onOutput); },
      (m) => posted.push(m),
    );

    const first = handle({ type: "open" });
    const second = handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });
    release();
    await Promise.all([first, second]);

    expect(media(posted).map((m) => m.type)).toEqual(["opened", "video", "audio"]);
  });

  it("ignores a segment that arrives before open", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (m) => posted.push(m));
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });
    expect(posted).toEqual([]);
  });

  it("opens once, however many opens arrive", async () => {
    const make = vi.fn(async (onOutput: (out: never) => void) => fakeDecoder(onOutput as never));
    const handle = createWorkerHandler(make, () => {});
    await handle({ type: "open" });
    await handle({ type: "open" });
    expect(make).toHaveBeenCalledOnce();
  });

  it("reports the decoder's own counters with every segment", async () => {
    // Read synchronously by the page's diagnostics, so it has to be current
    // whenever it is read rather than fetched on request. The silence this
    // answers - no frames, no audio, no error - has four different causes.
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });

    const stats = posted.find((m) => m.type === "stats");
    expect(stats).toBeDefined();
    expect(stats).toMatchObject({ type: "stats", stats: { opened: true, videoStream: true } });
  });

  it("stops decoding after close", async () => {
    const decoder = fakeDecoder(() => {});
    const handle = createWorkerHandler(async () => decoder, () => {});
    await handle({ type: "open" });
    await handle({ type: "close" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8), epoch: 0 });
    expect(decoder.push).not.toHaveBeenCalled();
  });
});
