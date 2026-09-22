/**
 * CEA-708, decoded from the broadcast this app actually receives.
 *
 * This is the test the vendored decoder is here for. The synthetic cases in
 * `cea708Vendor.test.ts` prove the conversion loads; this one proves it
 * decodes, against the same three seconds of ABC 720p the 608 path is pinned
 * to — so the two can be compared word for word.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createCea708Track } from "../lib/captions/cea708";
import { extractCcData } from "../lib/captions/extract";
import type { CcPair } from "../lib/captions/types";

const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/720p-captions-3s.ts.bin");

/** The GA94 user-data marker each captioned picture carries. */
const MARKER = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34];

/**
 * Walk the fixture picture by picture, yielding each one's DTVCC pairs.
 *
 * The times are fabricated from file position, which is *decode* order - the
 * order pictures are coded in, not the order they are shown. Real
 * presentation timestamps only exist downstream of the demuxer, so nothing
 * here can exercise the reorder buffer, and the text this produces is
 * transposed exactly as the 608 path was before that buffer existed.
 *
 * That is why the sentence is asserted in `captionsEndToEnd.test.ts` instead,
 * where libav supplies real timestamps. What is checked here is everything
 * that does not depend on order: that packets reassemble, that service 1 is
 * found, and that window positions come through.
 */
function dtvccFromFixture(): Array<{ seconds: number; pairs: CcPair[] }> {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const out: Array<{ seconds: number; pairs: CcPair[] }> = [];

  let picture = 0;
  outer: for (let i = 0; i + MARKER.length < bytes.length; i++) {
    for (let k = 0; k < MARKER.length; k++) if (bytes[i + k] !== MARKER[k]) continue outer;
    const { dtvcc } = extractCcData(bytes.subarray(i));
    if (dtvcc.length) {
      // The capture is 29.97fps; exact times do not matter here, only order.
      out.push({ seconds: picture / 29.97, pairs: dtvcc });
    }
    picture++;
  }
  return out;
}

describe("createCea708Track", () => {
  it("finds DTVCC to decode in the fixture", () => {
    const pictures = dtvccFromFixture();
    expect(pictures.length).toBeGreaterThan(0);
  });

  it("knows nothing has been seen before it is fed", () => {
    expect(createCea708Track().seen).toBe(false);
  });

  it("ignores 608 pairs, which belong to the other track", () => {
    const track = createCea708Track();
    track.add(0, [{ field: 0, a: 0x41, b: 0x42 }]);
    expect(track.flush()).toEqual([]);
    expect(track.seen).toBe(false);
  });

  it("decodes service 1 out of real broadcast bytes", () => {
    const track = createCea708Track();
    for (const { seconds, pairs } of dtvccFromFixture()) track.add(seconds, pairs);
    const cues = track.flush();

    expect(cues.length).toBeGreaterThan(0);
    expect(track.seen).toBe(true);

    // Words, not punctuation noise. The sentence itself is asserted end to
    // end, for the ordering reason above; what matters here is that the
    // service was found and the packets reassembled into text at all.
    const text = cues.map((c) => c.text).join(" ");
    expect(text).toMatch(/[A-Za-z]{3,}/);
    // The same characters the 608 path reads, whatever order they arrive in.
    // Order is what this input cannot establish; content is.
    const counts = (t: string) => {
      const m = new Map<string, number>();
      for (const c of t.toLowerCase().replace(/[^a-z]/g, "")) {
        m.set(c, (m.get(c) ?? 0) + 1);
      }
      return m;
    };
    const decoded = counts(text);
    for (const [char, n] of counts("findlightinthedarkness")) {
      expect(decoded.get(char) ?? 0).toBeGreaterThanOrEqual(n);
    }
  });

  it("carries the window position the broadcaster set", () => {
    const track = createCea708Track();
    for (const { seconds, pairs } of dtvccFromFixture()) track.add(seconds, pairs);
    const cues = track.flush();

    const positioned = cues.filter((c) => c.region);
    expect(positioned.length).toBeGreaterThan(0);

    for (const cue of positioned) {
      expect(cue.region!.xPercent).toBeGreaterThanOrEqual(0);
      expect(cue.region!.xPercent).toBeLessThanOrEqual(100);
      expect(cue.region!.anchor).toMatch(/^(top|middle|bottom)-(left|center|right)$/);
    }
  });
});
