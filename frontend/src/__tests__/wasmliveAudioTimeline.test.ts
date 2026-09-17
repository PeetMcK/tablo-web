import { describe, it, expect } from "vitest";

import {
  createTimeline, noteDecoded, noteEmitted, nextOutputPts,
} from "../lib/wasmlive/audioTimeline";

/** One AC-3 frame at 48kHz: 1536 samples, 32ms. */
const AC3 = 1536;
const RATE = 48000;

describe("audio timeline", () => {
  it("begins where the decoder's first frame says it does", () => {
    const t = createTimeline();
    noteDecoded(t, 12.5, AC3, RATE);
    expect(nextOutputPts(t, RATE)).toBeCloseTo(12.5, 6);
  });

  it("advances by what it has emitted, not by what it was told", () => {
    // Sample counts are exact where timestamps are rounded, so in the ordinary
    // case the count is what the timeline runs on.
    const t = createTimeline();
    noteDecoded(t, 10, AC3, RATE);
    noteEmitted(t, 24000);
    expect(nextOutputPts(t, RATE)).toBeCloseTo(10.5, 6);
  });

  it("carries a dropped frame into the output timeline instead of closing the gap", () => {
    // The bug this exists for: one AC-3 frame lost to a CRC error on marginal
    // reception. Counting samples alone, every later timestamp is 32ms low and
    // stays that way — video presented 32ms late for the life of the session,
    // accumulating on a feed that drops a frame a minute.
    const t = createTimeline();
    noteDecoded(t, 10.000, AC3, RATE);
    noteDecoded(t, 10.064, AC3, RATE);          // 10.032 never arrived
    expect(t.drift).toBeCloseTo(0.032, 6);

    noteEmitted(t, AC3);
    expect(nextOutputPts(t, RATE)).toBeCloseTo(10.064, 6);
  });

  it("ignores jitter smaller than a frame", () => {
    // A 90kHz timebase does not divide 1536/48000 exactly, so consecutive
    // frames land a few microseconds from where they were expected. Treating
    // that as a gap would have the timeline chasing rounding for ever.
    const t = createTimeline();
    noteDecoded(t, 10, AC3, RATE);
    noteDecoded(t, 10.032 + 0.000011, AC3, RATE);
    noteDecoded(t, 10.064 - 0.000011, AC3, RATE);
    expect(t.drift).toBe(0);
  });

  it("follows a discontinuity rather than freezing on it", () => {
    // Resuming after a pause longer than the ring window feeds media an hour
    // from where the clock was. Counting on from the original origin, no frame
    // is ever due: the picture freezes and the watchdog calls it a decode
    // error. The timeline has to go where the media went.
    const t = createTimeline();
    noteDecoded(t, 10, AC3, RATE);
    noteEmitted(t, AC3);
    noteDecoded(t, 3610, AC3, RATE);

    expect(nextOutputPts(t, RATE)).toBeCloseTo(3610, 3);
  });

  it("corrects a stream that repeats rather than drops", () => {
    const t = createTimeline();
    noteDecoded(t, 10.000, AC3, RATE);
    noteDecoded(t, 10.000, AC3, RATE);          // the same frame twice
    expect(t.drift).toBeCloseTo(-0.032, 6);
  });

  it("holds its correction across everything that follows", () => {
    // A gap is a permanent offset, not a one-off adjustment: the media really
    // is 32ms further on than the sample count believes, and stays that way.
    const t = createTimeline();
    noteDecoded(t, 10.000, AC3, RATE);
    noteDecoded(t, 10.064, AC3, RATE);
    for (let i = 2; i < 100; i++) noteDecoded(t, 10.064 + (i - 1) * 0.032, AC3, RATE);
    noteEmitted(t, AC3 * 99);

    expect(t.drift).toBeCloseTo(0.032, 6);
    expect(nextOutputPts(t, RATE)).toBeCloseTo(10.064 + 98 * 0.032, 5);
  });
});
