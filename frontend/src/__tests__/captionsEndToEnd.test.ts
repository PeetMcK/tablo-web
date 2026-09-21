/**
 * Captions, from broadcast bytes to words.
 *
 * The unit tests pin each stage against input a test wrote. This one runs the
 * real decoder over real MPEG-2 off the device and asserts that English comes
 * out — the only test here that would catch a correct extractor wired to a
 * correct parser in the wrong order, or a PTS read from the wrong field.
 *
 * The fixture is three seconds of ABC 720p, captured through the raw path on
 * 2026-09-21. FFmpeg's own `subcc` decoder reads one cue from it:
 *
 *   00:01.568 --> 00:04.738  "Elliot had shown them how / to find light in
 *                             the darkness."
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { createDecoder } from "../lib/wasmlive/libavClient";
import type { CaptionCue } from "../lib/captions";

const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/720p-captions-3s.ts.bin");
const WASM = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.wasm"),
).href;
// libav.js imports its own emscripten runtime at this url. In the browser Vite
// emits it as an asset; node needs a file:// one it can import directly.
const GLUE = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.mjs"),
).href;

describe("captions end to end", () => {
  it("produces caption text from real broadcast bytes", async () => {
    const collected: CaptionCue[] = [];
    const decoder = await createDecoder({
      wasmUrl: WASM, glueUrl: GLUE, openDeadlineMs: 20_000,
      onOutput: (out) => { collected.push(...out.captions); },
    });

    await decoder.push(new Uint8Array(readFileSync(FIXTURE)));
    await decoder.flush();

    const stats = decoder.stats();
    await decoder.close();

    // The bytes are there at all — this separates "uncaptioned broadcast"
    // from "captions we failed to decode", which is exactly what the counters
    // exist for.
    expect(stats.captionPairs).toBeGreaterThan(0);

    expect(collected.length).toBeGreaterThan(0);
    // Real captions are words, not punctuation noise.
    const text = collected.map((c) => c.text).join(" ");
    expect(text).toMatch(/[A-Za-z]{3,}/);

    // The exact sentence, not just a word from it. A loose match was what let
    // a real ordering bug through: the pairs were being fed to the 608 state
    // machine out of display order, so the words came out with their letters
    // transposed - "[cheers, applause]" as "[cheerpps, alause]" - and any
    // assertion looking for a single keyword still passed.
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("Elliot had shown them how to find light in the darkness.");

    for (const cue of collected) {
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
    }

    // Times are in the device's PTS domain, which starts wherever the
    // broadcast happened to be — around 1269s for this capture, not zero.
    // Converting to media time is the session's job, so what is checked here
    // is the property that survives the offset: three seconds of video cannot
    // produce cues spanning more than three seconds. A PTS read from the
    // wrong field, or the high word dropped, shows up as a spread of hours.
    const starts = collected.map((c) => c.startSeconds);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(10);
  }, 120_000);
});
