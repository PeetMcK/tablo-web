/**
 * The one test that proves the WASM build actually decodes this device's
 * output. It is slow by the standards of this suite, and that is the point: it
 * is what fails if a libav.js upgrade changes the variant out from under us.
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
import type { DecodedAudioChunk, DecodedVideoFrame } from "../lib/wasmlive/types";

// Paths from the package root, which is where vitest runs. The wasm binary is
// bundled as an asset in the browser; node needs to be told where it is.
const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin");
const WASM = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.wasm"),
).href;
// libav.js imports its own emscripten runtime at this url. In the browser Vite
// emits it as an asset; node needs a file:// one it can import directly.
const GLUE = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.mjs"),
).href;

async function decodeFixture() {
  // Output arrives through the callback as it is decoded, not as a return
  // value: frames must reach the screen when they exist, not when the next
  // segment happens to arrive.
  const video: DecodedVideoFrame[] = [];
  const audio: DecodedAudioChunk[] = [];
  const decoder = await createDecoder({
    wasmUrl: WASM, glueUrl: GLUE,
    onOutput: (out) => { video.push(...out.video); audio.push(...out.audio); },
  });

  const bytes = new Uint8Array(readFileSync(FIXTURE));
  for (let at = 0; at < bytes.length; at += 64 * 1024) {
    await decoder.push(bytes.subarray(at, Math.min(at + 64 * 1024, bytes.length)));
  }
  await decoder.flush();
  await decoder.close();
  return { video, audio };
}

describe("libavClient", () => {
  it("decodes 1080i MPEG-2 out of MPEG-TS", { timeout: 120_000 }, async () => {
    const { video } = await decodeFixture();

    // ~1s at 29.97, allowing for a partial GOP at each end of the cut.
    expect(video.length).toBeGreaterThan(20);

    const first = video[0];
    expect(first.width).toBe(1920);
    expect(first.height).toBe(1080);
    // Packed I420: a full luma plane plus two quarter-size chroma planes.
    expect(first.data.length).toBe((1920 * 1080 * 3) / 2);

    const pts = video.map((f) => f.ptsSeconds);
    expect(pts.every((t, i) => i === 0 || t > pts[i - 1])).toBe(true);
  });

  it("reports the field order the shader needs", { timeout: 120_000 }, async () => {
    // The fixture is field_order=tt, so every frame must come back interlaced
    // and top-field-first. Getting this wrong swaps the fields and makes
    // motion judder without looking obviously broken.
    const { video } = await decodeFixture();

    expect(video[0].interlaced).toBe(true);
    expect(video[0].topFieldFirst).toBe(true);
    expect(video.every((f) => f.interlaced)).toBe(true);
  });

  it("times each frame so its second field can be placed", { timeout: 120_000 }, async () => {
    const { video } = await decodeFixture();

    // 1001/30000 = 0.03337s per frame.
    expect(video[0].durationSeconds).toBeCloseTo(0.03337, 4);
    const gap = video[1].ptsSeconds - video[0].ptsSeconds;
    expect(gap).toBeCloseTo(video[0].durationSeconds, 3);
  });

  it("downmixes AC-3 5.1 to interleaved stereo", { timeout: 120_000 }, async () => {
    const { audio } = await decodeFixture();

    expect(audio.length).toBeGreaterThan(0);
    expect(audio[0].sampleRate).toBe(48000);
    // Interleaved stereo: an even length, and 1536 frames per AC-3 block.
    expect(audio[0].samples.length % 2).toBe(0);
    expect(audio[0].samples.length).toBe(1536 * 2);
    expect(audio.every((c) => Number.isFinite(c.ptsSeconds))).toBe(true);
    // Not silence: a downmix that dropped every channel would still be stereo.
    expect(audio.some((c) => c.samples.some((s) => s !== 0))).toBe(true);
  });

  it("can be reset mid-stream and decode again", { timeout: 120_000 }, async () => {
    // What a seek does: part of a stream, then start over somewhere else.
    let video: DecodedVideoFrame[] = [];
    const decoder = await createDecoder({
      wasmUrl: WASM, glueUrl: GLUE,
      onOutput: (out) => { video.push(...out.video); },
    });

    const bytes = new Uint8Array(readFileSync(FIXTURE));
    await decoder.push(bytes.subarray(0, 256 * 1024));
    await decoder.reset();
    video = [];

    for (let at = 0; at < bytes.length; at += 64 * 1024) {
      await decoder.push(bytes.subarray(at, Math.min(at + 64 * 1024, bytes.length)));
    }
    await decoder.flush();
    await decoder.close();

    expect(video.length).toBeGreaterThan(20);
    // Timestamps restart from the stream, not from where the old one stopped.
    expect(video[0].ptsSeconds).toBeCloseTo(1.533, 1);
  });
});
