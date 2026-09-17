/**
 * What the decoder says about itself when it is not working.
 *
 * The one failure this path has never explained was silent: fed seconds of
 * media, it produced no frames, no audio and no error, and the only symptom
 * was the session's deadline expiring eight seconds later. These tests pin the
 * two ways that silence is now broken — a stream with no video in it, and an
 * open that never completes — and the counters that say which.
 *
 * @vitest-environment node
 *
 * Node, not jsdom: the libav loader resolves its wasm against the document's
 * own URL, which under jsdom is an http origin nothing is serving.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { createDecoder } from "../lib/wasmlive/libavClient";

const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin");
/** The same second of broadcast with the video PID stripped out. */
const AUDIO_ONLY = resolve("src/lib/wasmlive/__fixtures__/audio-only-1s.ts.bin");
const WASM = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.wasm"),
).href;
// libav.js imports its own emscripten runtime at this url. In the browser Vite
// emits it as an asset; node needs a file:// one it can import directly.
const GLUE = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.mjs"),
).href;

/** Bytes that are not a transport stream, in quantity. */
function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at++) bytes[at] = (at * 2654435761) & 0xff;
  return bytes;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("decoder diagnosis", () => {
  it("refuses a stream with no video in it, rather than decoding nothing", async () => {
    // A tuner that has not locked its video PID yet serves exactly this: a
    // well-formed transport stream carrying only sound. It used to build no
    // video decoder, read packets for ever, emit nothing, and say nothing —
    // which from the page is indistinguishable from a decoder that is slow.
    const decoder = await createDecoder({ wasmUrl: WASM, glueUrl: GLUE, openDeadlineMs: 20_000 });

    const bytes = new Uint8Array(readFileSync(AUDIO_ONLY));
    let thrown: unknown = null;
    try {
      for (let at = 0; at < bytes.length; at += 16 * 1024) {
        await decoder.push(bytes.subarray(at, Math.min(at + 16 * 1024, bytes.length)));
      }
      await settle(1000);
      await decoder.push(bytes.subarray(0, 1024));
    } catch (e) {
      thrown = e;
    }
    await decoder.close();

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/no video stream/i);
  }, 120_000);

  it("refuses bytes that are not a transport stream at all", async () => {
    const decoder = await createDecoder({ wasmUrl: WASM, glueUrl: GLUE, openDeadlineMs: 20_000 });

    const bytes = noise(1024 * 1024);
    let thrown: unknown = null;
    try {
      for (let at = 0; at < bytes.length; at += 256 * 1024) {
        await decoder.push(bytes.subarray(at, at + 256 * 1024));
      }
      await settle(500);
      await decoder.push(noise(1024));
    } catch (e) {
      thrown = e;
    }
    await decoder.close();

    // Whatever it says, it must say something: silence is the one outcome the
    // session upstairs cannot tell apart from working.
    expect(thrown).toBeInstanceOf(Error);
  }, 120_000);

  it("gives up on an open that never completes", async () => {
    // A trickle too thin to demux: the failure the deadline used to catch,
    // caught here by name and with the byte count that proves it.
    const decoder = await createDecoder({ wasmUrl: WASM, glueUrl: GLUE, openDeadlineMs: 300 });

    let thrown: unknown = null;
    try {
      await decoder.push(noise(188));
      await settle(1000);
      await decoder.push(noise(188));
    } catch (e) {
      thrown = e;
    }
    await decoder.close();

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/did not open/i);
  }, 120_000);

  it("counts what it was fed and what it got open on", async () => {
    const decoder = await createDecoder({ wasmUrl: WASM, glueUrl: GLUE });
    expect(decoder.stats().opened).toBe(false);
    expect(decoder.stats().bytesFed).toBe(0);

    const bytes = new Uint8Array(readFileSync(FIXTURE));
    for (let at = 0; at < bytes.length; at += 64 * 1024) {
      await decoder.push(bytes.subarray(at, Math.min(at + 64 * 1024, bytes.length)));
    }
    await settle(2000);

    const stats = decoder.stats();
    await decoder.close();

    expect(stats.opened).toBe(true);
    expect(stats.videoStream).toBe(true);
    expect(stats.audioStream).toBe(true);
    expect(stats.bytesFed).toBe(bytes.length);
    // What it actually took to name the streams, which is the number worth
    // knowing when a channel will not start.
    expect(stats.bytesAtOpen).toBeGreaterThan(0);
    expect(stats.bytesAtOpen!).toBeLessThanOrEqual(bytes.length);
    expect(stats.videoFrames).toBeGreaterThan(20);
    expect(stats.audioChunks).toBeGreaterThan(0);
  }, 120_000);

  it("opens on well under a second of this device's output", async () => {
    // The standing theory for the cold-channel failure was that the demuxer
    // probe needed more than a cold ring could give it. It does not: one
    // segment is ample, with no end of stream to help it along.
    const decoder = await createDecoder({ wasmUrl: WASM, glueUrl: GLUE });
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    for (let at = 0; at < bytes.length; at += 64 * 1024) {
      await decoder.push(bytes.subarray(at, Math.min(at + 64 * 1024, bytes.length)));
    }
    await settle(2000);
    const stats = decoder.stats();
    await decoder.close();

    expect(stats.opened).toBe(true);
    expect(stats.bytesAtOpen!).toBeLessThan(bytes.length);
  }, 120_000);
});
