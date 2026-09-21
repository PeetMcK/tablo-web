/**
 * That the vendored 608 parser still parses.
 *
 * Two tests, not a suite: the logic is upstream's and exercised by every
 * hls.js user. What these pin is that the four edits vendoring required — the
 * imports, the enum, the lookup-table annotations and one cast — left it
 * working, and that `reset` really does forget the screen, which is the
 * property a seek depends on.
 */

import { describe, it, expect } from "vitest";

import Cea608Parser, { type CaptionScreen, type CueSink } from "../lib/captions/cea608";

/**
 * 608 bytes carry odd parity in bit 7 and the parser rejects a byte without
 * it. Confirmed against the real fixture: 'O' (0x4f) has five set bits and
 * arrives bare, 'D' (0x44) has two and arrives as 0xc4.
 */
function par(b: number): number {
  let ones = 0;
  for (let i = 0; i < 7; i++) if (b & (1 << i)) ones++;
  return ones % 2 === 0 ? b | 0x80 : b;
}

function text(s: string): number[][] {
  const bytes = [...s].map((c) => par(c.charCodeAt(0)));
  if (bytes.length % 2) bytes.push(par(0x00));
  const pairs: number[][] = [];
  for (let i = 0; i < bytes.length; i += 2) pairs.push([bytes[i], bytes[i + 1]]);
  return pairs;
}

function collector(): CueSink & { cues: Array<{ start: number; end: number; text: string }> } {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  return {
    cues,
    newCue(start: number, end: number, screen: CaptionScreen) {
      cues.push({ start, end, text: screen.getDisplayText().trim() });
    },
    reset() { cues.length = 0; },
  };
}

describe("the vendored 608 parser", () => {
  it("turns a roll-up sequence into a cue", () => {
    const cc1 = collector();
    const cc2 = collector();
    const parser = new Cea608Parser(1, cc1, cc2);

    let t = 0;
    const feed = (pair: number[]) => { parser.addData(t, pair); t += 0.034; };

    feed([par(0x14), par(0x25)]);  // RU2 — roll up, two rows
    feed([par(0x14), par(0x2d)]);  // CR  — carriage return
    for (const pair of text("HELLO")) feed(pair);
    feed([par(0x14), par(0x2d)]);  // CR, which pushes the row out

    expect(cc1.cues.length).toBeGreaterThan(0);
    expect(cc1.cues.map((c) => c.text).join(" ")).toContain("HELLO");
  });

  it("forgets the screen on reset, so a seek does not resume mid-sentence", () => {
    const cc1 = collector();
    const parser = new Cea608Parser(1, cc1, collector());

    let t = 0;
    const feed = (pair: number[]) => { parser.addData(t, pair); t += 0.034; };
    feed([par(0x14), par(0x25)]);
    feed([par(0x14), par(0x2d)]);
    for (const pair of text("HELLO")) feed(pair);

    parser.reset();
    cc1.reset();

    feed([par(0x14), par(0x2d)]);
    expect(cc1.cues.every((c) => !c.text.includes("HELLO"))).toBe(true);
  });
});
