import { describe, it, expect, vi } from "vitest";

import { createWorkerHandler } from "../lib/wasmlive/workerProtocol";
import type { FromWorker } from "../lib/wasmlive/workerProtocol";
import type { LibavDecoder } from "../lib/wasmlive/libavClient";

const frame = {
  data: new Uint8Array(6), width: 2, height: 2,
  ptsSeconds: 1, durationSeconds: 0.03337, interlaced: true, topFieldFirst: true,
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
    ...overrides,
  };
}

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
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(posted.map((m) => m.type)).toEqual(["opened", "video", "audio"]);
  });

  it("transfers frame buffers rather than copying them", async () => {
    // A 1080p frame is 3.1MB; copying one per frame at 60p is 186MB/s of
    // pointless memcpy between the worker and the page.
    const transfers: Transferable[][] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (_m, t) => transfers.push(t));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(transfers[1]).toEqual([frame.data.buffer]);
    expect(transfers[2]).toEqual([chunk.samples.buffer]);
  });

  it("says nothing when a segment decoded to nothing yet", async () => {
    const posted: FromWorker[] = [];
    const decoder = fakeDecoder(() => {}, { push: vi.fn(async () => {}) });
    const handle = createWorkerHandler(async () => decoder, (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(posted).toEqual([{ type: "opened" }]);
  });

  it("reports a decode failure as an error message", async () => {
    const posted: FromWorker[] = [];
    const decoder = fakeDecoder(() => {}, {
      push: vi.fn(async () => { throw new Error("bad packet"); }),
    });
    const handle = createWorkerHandler(async () => decoder, (m) => posted.push(m));
    await handle({ type: "open" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
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
    await handle({ type: "reset" });
    await handle({ type: "close" });
    expect(decoder.reset).toHaveBeenCalledOnce();
    expect(decoder.close).toHaveBeenCalledOnce();
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
    const second = handle({ type: "segment", bytes: new ArrayBuffer(8) });
    release();
    await Promise.all([first, second]);

    expect(posted.map((m) => m.type)).toEqual(["opened", "video", "audio"]);
  });

  it("ignores a segment that arrives before open", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async (onOutput) => fakeDecoder(onOutput), (m) => posted.push(m));
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(posted).toEqual([]);
  });

  it("opens once, however many opens arrive", async () => {
    const make = vi.fn(async (onOutput: (out: never) => void) => fakeDecoder(onOutput as never));
    const handle = createWorkerHandler(make, () => {});
    await handle({ type: "open" });
    await handle({ type: "open" });
    expect(make).toHaveBeenCalledOnce();
  });

  it("stops decoding after close", async () => {
    const decoder = fakeDecoder(() => {});
    const handle = createWorkerHandler(async () => decoder, () => {});
    await handle({ type: "open" });
    await handle({ type: "close" });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(decoder.push).not.toHaveBeenCalled();
  });
});
