/**
 * Pairs in, cues out — and what survives a seek.
 *
 * The interesting cases are the two asymmetries: screen state must not cross a
 * reset, and the knowledge that a stream carries captions must, or the CC
 * button would vanish and return on every skip.
 */

import { describe, it, expect } from "vitest";

import { createCaptionTrack } from "../lib/captions/track";
import type { CcPair } from "../lib/captions/types";

function par(b: number): number {
  let ones = 0;
  for (let i = 0; i < 7; i++) if (b & (1 << i)) ones++;
  return ones % 2 === 0 ? b | 0x80 : b;
}

const pair = (a: number, b: number, field: 0 | 1 = 0): CcPair => ({ field, a: par(a), b: par(b) });

function chars(s: string): CcPair[] {
  const bytes = [...s].map((c) => c.charCodeAt(0));
  if (bytes.length % 2) bytes.push(0x00);
  const out: CcPair[] = [];
  for (let i = 0; i < bytes.length; i += 2) out.push(pair(bytes[i], bytes[i + 1]));
  return out;
}

describe("createCaptionTrack", () => {
  it("knows nothing has been seen before it is fed", () => {
    expect(createCaptionTrack().seen).toBe(false);
  });

  it("reports a stream as captioned as soon as one field-1 pair arrives", () => {
    const track = createCaptionTrack();
    track.add(0, [pair(0x80, 0x80)]);
    expect(track.seen).toBe(true);
  });

  it("ignores field 2, which carries CC3 and CC4", () => {
    const track = createCaptionTrack();
    track.add(0, [pair(0x41, 0x42, 1)]);
    expect(track.seen).toBe(false);
  });

  it("collects a roll-up caption as a cue", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };

    feed([pair(0x14, 0x25)]);   // RU2
    feed([pair(0x14, 0x2d)]);   // CR
    feed(chars("HELLO"));
    feed([pair(0x14, 0x2d)]);   // CR

    const cues = track.drain();
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.map((c) => c.text).join(" ")).toContain("HELLO");
    expect(cues[0].startSeconds).toBeGreaterThanOrEqual(0);
    expect(cues[0].endSeconds).toBeGreaterThan(cues[0].startSeconds);
  });

  it("hands each cue out once", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };
    feed([pair(0x14, 0x25)]);
    feed([pair(0x14, 0x2d)]);
    feed(chars("HELLO"));
    feed([pair(0x14, 0x2d)]);

    expect(track.drain().length).toBeGreaterThan(0);
    expect(track.drain()).toEqual([]);
  });

  it("drops screen state on reset but stays a captioned stream", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };
    feed([pair(0x14, 0x25)]);
    feed([pair(0x14, 0x2d)]);
    feed(chars("HELLO"));

    track.reset();
    expect(track.drain()).toEqual([]);
    // A seek does not make the channel uncaptioned, and letting the button
    // vanish and come back would flicker on every skip.
    expect(track.seen).toBe(true);

    feed([pair(0x14, 0x2d)]);
    expect(track.drain().every((c) => !c.text.includes("HELLO"))).toBe(true);
  });
});
