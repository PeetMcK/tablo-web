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

    // `flush`, not `drain`: nothing newer is coming to settle the order.
    const cues = track.flush();
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.map((c) => c.text).join(" ")).toContain("HELLO");
    expect(cues[0].startSeconds).toBeGreaterThanOrEqual(0);
    expect(cues[0].endSeconds).toBeGreaterThan(cues[0].startSeconds);
  });

  it("repeats a caption that is still up, and stops once it comes down", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };
    feed([pair(0x14, 0x25)]);
    feed([pair(0x14, 0x2d)]);
    feed(chars("HELLO"));
    feed([pair(0x14, 0x2d)]);

    const first = track.flush();
    expect(first.length).toBeGreaterThan(0);

    // The words are still on screen, so they come again. That is the point:
    // a caption is reported while it is up rather than once it is gone, which
    // is the only way the overlay can draw it from the moment it appears.
    // The repeat carries the same start, and the session folds it into the
    // one it already holds rather than stacking a second caption.
    // Only the one still up comes again - the row that scrolled away before
    // it is finished, and finished cues are handed out once.
    const again = track.flush();
    expect(again.length).toBeGreaterThan(0);
    const starts = new Set(first.map((c) => c.startSeconds));
    expect(again.every((c) => starts.has(c.startSeconds))).toBe(true);

    // EDM, which erases the displayed memory. Nothing is up any more, so
    // there is nothing left to report.
    feed([pair(0x14, 0x2c)]);
    track.flush();
    expect(track.flush()).toEqual([]);
  });

  it("drops screen state on reset but stays a captioned stream", () => {
    const track = createCaptionTrack();
    let t = 0;
    const feed = (pairs: CcPair[]) => { for (const p of pairs) { track.add(t, [p]); t += 0.034; } };
    feed([pair(0x14, 0x25)]);
    feed([pair(0x14, 0x2d)]);
    feed(chars("HELLO"));

    track.reset();
    expect(track.flush()).toEqual([]);
    // A seek does not make the channel uncaptioned, and letting the button
    // vanish and come back would flicker on every skip.
    expect(track.seen).toBe(true);

    feed([pair(0x14, 0x2d)]);
    expect(track.flush().every((c) => !c.text.includes("HELLO"))).toBe(true);
  });
});

describe("display order", () => {
  /**
   * The decoder hands packets over in decode order, a read round at a time.
   * MPEG-2 reorders for B-frames, and a picture that belongs earlier in
   * display order routinely arrives in the *next* round — so sorting within a
   * round is not enough. 608 is a command stream, and bytes in the wrong order
   * spell the wrong words: "[cheers, applause]" came out as
   * "[cheerpps, alause]" against a live broadcast.
   */
  it("feeds pairs in PTS order even when they arrive out of it", () => {
    const track = createCaptionTrack();
    const step = 0.034;

    // Build the whole sequence with its true times, then hand it over shuffled
    // the way read-round boundaries shuffle it.
    const seq: Array<{ t: number; p: CcPair }> = [];
    let t = 0;
    const plan = (pairs: CcPair[]) => { for (const p of pairs) { seq.push({ t, p }); t += step; } };
    plan([pair(0x14, 0x25)]);   // RU2
    plan([pair(0x14, 0x2d)]);   // CR
    plan(chars("HELLO WORLD"));
    plan([pair(0x14, 0x2d)]);   // CR

    // Swap each adjacent pair of entries: a small, local reordering, which is
    // exactly what a round boundary produces.
    const shuffled = [...seq];
    for (let i = 0; i + 1 < shuffled.length; i += 2) {
      [shuffled[i], shuffled[i + 1]] = [shuffled[i + 1], shuffled[i]];
    }
    for (const { t: at, p } of shuffled) track.add(at, [p]);

    const text = track.flush().map((c) => c.text).join(" ");
    expect(text).toContain("HELLO WORLD");
  });

  it("holds a pair back until later pictures prove nothing earlier is coming", () => {
    const track = createCaptionTrack();
    track.add(10, [pair(0x14, 0x25)]);
    // Nothing has arrived from far enough ahead to settle the order yet.
    expect(track.drain()).toEqual([]);
  });
});
