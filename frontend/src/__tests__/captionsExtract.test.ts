/**
 * Where the caption bytes are in an MPEG-2 picture.
 *
 * The synthetic cases pin the shape of an ATSC user-data block; the last two
 * run over a real capture, because a bitstream reader that only ever sees
 * bytes a test wrote is a reader of its own assumptions.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractCcData } from "../lib/captions/extract";

const FIXTURE = resolve("src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin");

/**
 * One ATSC user-data block, shaped the way a broadcast encoder writes it.
 *
 * `0xc0 | count` sets process_em_data_flag and process_cc_data_flag and puts
 * the entry count in the low five bits, which is what the real fixture carries
 * (0xd4 there, for twenty entries). A marker byte is five set bits, then
 * cc_valid, then a two-bit cc_type.
 */
function userData(entries: Array<[valid: boolean, type: number, a: number, b: number]>): number[] {
  const out = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34, 0x03, 0xc0 | entries.length, 0xff];
  for (const [valid, type, a, b] of entries) {
    out.push(0xf8 | (valid ? 0x04 : 0x00) | type, a, b);
  }
  return out;
}

/** A slice start code, which is where a picture's payload begins. */
const SLICE = [0x00, 0x00, 0x01, 0x01];

describe("extractCcData", () => {
  it("returns the valid 608 pairs and skips the rest", () => {
    const bytes = new Uint8Array(userData([
      [true, 0, 0x4f, 0xc4],   // field 1
      [true, 1, 0x80, 0x80],   // field 2
      [true, 3, 0xc2, 0x22],   // DTVCC, not this pass
      [true, 2, 0x4f, 0x44],   // DTVCC, not this pass
      [false, 0, 0xfa, 0x00],  // padding
    ]));

    const out = extractCcData(bytes);
    expect(out.cea608).toEqual([
      { field: 0, a: 0x4f, b: 0xc4 },
      { field: 1, a: 0x80, b: 0x80 },
    ]);
    // DTVCC is kept now rather than dropped: it is how CEA-708 travels.
    expect(out.dtvcc).toEqual([
      { field: 3, a: 0xc2, b: 0x22 },
      { field: 2, a: 0x4f, b: 0x44 },
    ]);
  });

  it("stops at the first slice, which is where user data can no longer appear", () => {
    const bytes = new Uint8Array([
      ...SLICE,
      ...userData([[true, 0, 0x41, 0x42]]),
    ]);
    expect(extractCcData(bytes)).toEqual({ cea608: [], dtvcc: [] });
  });

  it("ignores user data that is not ATSC A/53 captions", () => {
    const notGa94 = [0x00, 0x00, 0x01, 0xb2, 0x44, 0x54, 0x47, 0x31, 0x03, 0xc1, 0xff, 0xfc, 0x41, 0x42];
    const wrongTypeCode = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34, 0x06, 0xc1, 0xff, 0xfc, 0x41, 0x42];
    expect(extractCcData(new Uint8Array(notGa94))).toEqual({ cea608: [], dtvcc: [] });
    expect(extractCcData(new Uint8Array(wrongTypeCode))).toEqual({ cea608: [], dtvcc: [] });
  });

  it("refuses a block that claims more entries than it carries", () => {
    // Says four entries, carries one. Trusting the count would read past the
    // end and invent captions out of whatever followed.
    const truncated = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34, 0x03, 0xc4, 0xff, 0xfc, 0x41, 0x42];
    expect(extractCcData(new Uint8Array(truncated))).toEqual({ cea608: [], dtvcc: [] });
  });

  it("honours a cleared process_cc_data_flag", () => {
    const body = userData([[true, 0, 0x41, 0x42]]);
    body[9] = 0x80 | 0x01;  // process_em_data set, process_cc_data clear
    expect(extractCcData(new Uint8Array(body))).toEqual({ cea608: [], dtvcc: [] });
  });

  it("reads real broadcast bytes out of the 1080i fixture", () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    // The first user-data block in this capture. Verified by hand against the
    // file: 000001B2 "GA94" 03, twenty entries, four of them valid.
    const out = extractCcData(bytes.subarray(708));
    expect(out.cea608).toEqual([
      { field: 0, a: 0x4f, b: 0xc4 },
      { field: 1, a: 0x80, b: 0x80 },
    ]);
    // And the DTVCC entries alongside them, which is what CEA-708 is
    // assembled from. Three in this picture: a packet start, its data, and
    // the start of the next - one picture's worth of user data is free to
    // carry the end of one packet and the beginning of another.
    expect(out.dtvcc).toEqual([
      { field: 3, a: 0xc2, b: 0x22 },
      { field: 2, a: 0x4f, b: 0x44 },
      { field: 3, a: 0x01, b: 0x00 },
    ]);
  });

  it("finds a caption block on every picture of the fixture", () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const marker = [0x00, 0x00, 0x01, 0xb2, 0x47, 0x41, 0x39, 0x34];
    const starts: number[] = [];
    outer: for (let i = 0; i + marker.length < bytes.length; i++) {
      for (let k = 0; k < marker.length; k++) if (bytes[i + k] !== marker[k]) continue outer;
      starts.push(i);
    }
    // One second of 29.97fps broadcast, captioned on every picture.
    expect(starts.length).toBe(31);
    let dtvccSeen = 0;
    for (const start of starts) {
      const pairs = extractCcData(bytes.subarray(start));
      expect(pairs.cea608.some((p) => p.field === 0)).toBe(true);
      dtvccSeen += pairs.dtvcc.length;
    }
    // 708 rides alongside 608 here, though not on every single picture -
    // DTVCC packets span pictures, so some carry only continuation and some
    // carry none at all.
    expect(dtvccSeen).toBeGreaterThan(0);
  });
});
