/**
 * A caption has to exist before the moment it is meant to be on screen.
 *
 * Both vendored decoders report a caption only when it is taken down: 608
 * hands over `lastOutputScreen` when the displayed memory next changes, and
 * 708 calls `forceEmit` when a window hides, clears or carriage-returns. The
 * cue that comes out is correctly dated - it carries the interval the words
 * really were on screen - but it does not exist until that interval has
 * ended, and by then the playhead is inside it or past it.
 *
 * Measured against a live CBS capture before this was fixed:
 *
 *   608  born@1874.248  span[1869.777..1873.748]  "♪♪♪"
 *   708  born@1875.149  span[1869.777..1873.748]  "♪♪♪"
 *
 * - four and five seconds after the words went up, half a second and a second
 * after they came down. The decoder runs at most `LOOKAHEAD_SECONDS` (2)
 * plus a segment ahead of the playhead, so a cue that late can only ever have
 * its tail drawn, and once the lead is shorter than the lateness, nothing is
 * drawn at all. That is the whole of "captions flash briefly and then stop".
 *
 * What this test pins is the property the overlay depends on: a cue is in
 * hand by the time the playhead reaches its start. It is stated as a budget
 * rather than an exactness because the reorder buffer deliberately holds
 * bytes back, and because a caption already on screen when the capture opens
 * cannot be seen to start any earlier than the first picture.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { createDecoder } from "../lib/wasmlive/libavClient";
import { REORDER_SECONDS } from "../lib/captions/reorder";

const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/720p-captions-3s.ts.bin");
const WASM = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.wasm"),
).href;
const GLUE = pathToFileURL(
  resolve("src/lib/wasmlive/vendor/libav-6.10.9.0-tablo-mpeg2.wasm.mjs"),
).href;

/**
 * How late a cue may be, measured from its own start.
 *
 * The reorder buffer is the floor - nothing can be decoded before it lets the
 * bytes through - and a quarter second on top covers the read round the bytes
 * happen to land in.
 */
const BUDGET_SECONDS = REORDER_SECONDS + 0.25;

describe("caption latency", () => {
  it("has each cue in hand before the playhead reaches its start", async () => {
    /**
     * How late each caption first appeared, keyed by standard and start.
     *
     * Keyed, because a caption is handed over again every round it is still
     * on screen, under the same start and a later end - that is how it
     * lengthens. Only the first hand-over decides whether the words can be
     * drawn from the moment they went up; the later ones are necessarily
     * later, and counting them would condemn the fix along with the bug.
     */
    const firstSeen = new Map<string, { by: number; text: string; standard: string }>();
    let decodePos = Number.NEGATIVE_INFINITY;

    const note = (standard: string, startSeconds: number, by: number, text: string) => {
      const key = `${standard}@${startSeconds.toFixed(3)}`;
      if (!firstSeen.has(key)) firstSeen.set(key, { by, text, standard });
    };

    const decoder = await createDecoder({
      wasmUrl: WASM, glueUrl: GLUE, openDeadlineMs: 20_000,
      onOutput: (out) => {
        for (const frame of out.video) {
          if (frame.ptsSeconds > decodePos) decodePos = frame.ptsSeconds;
        }
        // The decode position is where the playhead would be if it were not
        // running behind at all, so lateness measured against it is the
        // best case - the real playhead is a lookahead further back still.
        const born = decodePos;
        for (const cue of out.captions) {
          note("608", cue.startSeconds, born - cue.startSeconds, cue.text);
        }
        for (const cue of out.captions708) {
          note("708", cue.startSeconds, born - cue.startSeconds, cue.text);
        }
      },
    });

    // Fed a piece at a time, because the whole point is what is known part
    // way through. The session hands the decoder one segment as it arrives;
    // handing it three seconds at once produces a single read round in which
    // everything is already over, and a cue that arrives after the words have
    // gone is indistinguishable from one that arrives before them.
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const CHUNK = 188 * 400;
    for (let at = 0; at < bytes.length; at += CHUNK) {
      await decoder.push(bytes.subarray(at, Math.min(at + CHUNK, bytes.length)));
    }
    await decoder.flush();
    await decoder.close();

    // Both decoders have to be seen, or a regression in one hides behind the
    // other having nothing to say.
    const seen = [...firstSeen.values()];
    expect(seen.some((c) => c.standard === "608")).toBe(true);
    expect(seen.some((c) => c.standard === "708")).toBe(true);

    const overBudget = seen
      .filter((c) => c.by > BUDGET_SECONDS)
      .map((c) => `${c.standard} late by ${c.by.toFixed(3)}s: ${JSON.stringify(c.text)}`);
    expect(overBudget).toEqual([]);
  }, 120_000);
});
