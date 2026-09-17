import { describe, it, expect } from "vitest";

import {
  createSinkState, flushState, notePts, onSamplesPlayed, sinkClockSeconds, starvedBy,
} from "../lib/wasmlive/audioSink";

describe("audio sink accounting", () => {
  it("has no clock before any audio arrives", () => {
    expect(sinkClockSeconds(createSinkState(48000))).toBeNull();
  });

  it("starts the clock at the first chunk's pts", () => {
    const state = createSinkState(48000);
    notePts(state, 12.5);
    expect(sinkClockSeconds(state)).toBe(12.5);
  });

  it("keeps the first pts, not the latest", () => {
    // The clock is an origin plus what has been played. Moving the origin with
    // every chunk would make it jump backwards whenever audio ran ahead.
    const state = createSinkState(48000);
    notePts(state, 12.5);
    notePts(state, 13.0);
    expect(sinkClockSeconds(state)).toBe(12.5);
  });

  it("advances by the frames the worklet says it rendered", () => {
    const state = createSinkState(48000);
    notePts(state, 10);
    onSamplesPlayed(state, 24000);
    expect(sinkClockSeconds(state)).toBe(10.5);
  });

  it("accumulates across reports", () => {
    const state = createSinkState(48000);
    notePts(state, 0);
    onSamplesPlayed(state, 48000);
    onSamplesPlayed(state, 48000);
    expect(sinkClockSeconds(state)).toBe(2);
  });

  it("restarts cleanly after a seek", () => {
    const state = createSinkState(48000);
    notePts(state, 10);
    onSamplesPlayed(state, 48000);
    createSinkState(48000);           // a seek makes a new state
    const seeked = createSinkState(48000);
    notePts(seeked, 900);
    expect(sinkClockSeconds(seeked)).toBe(900);
  });
});

describe("starvedBy", () => {
  it("measures how far the clock has outrun the newest decoded frame", () => {
    const state = createSinkState(48000);
    notePts(state, 10);
    onSamplesPlayed(state, 96000);    // clock = 12
    expect(starvedBy(state, 11.5)).toBeCloseTo(0.5);
  });

  it("is zero while frames are ahead of the clock", () => {
    const state = createSinkState(48000);
    notePts(state, 10);
    onSamplesPlayed(state, 96000);
    expect(starvedBy(state, 12.5)).toBe(0);
  });

  it("is zero before anything has decoded, so startup is not starvation", () => {
    const state = createSinkState(48000);
    notePts(state, 10);
    expect(starvedBy(state, null)).toBe(0);
  });

  it("discards a worklet report that was posted before the flush", () => {
    // The worklet reports every 4800 frames and the flush is a message going
    // the other way, so one report is routinely already in flight when a seek
    // happens. Added to counters the seek has just zeroed, it puts the clock
    // ahead of the sound by up to a tenth of a second — for the rest of the
    // session, because nothing ever corrects it, and the buffer depth the
    // transport paces against is wrong by the same amount.
    const state = createSinkState(48000);
    notePts(state, 100);
    onSamplesPlayed(state, 48000, 1.0, 0);
    flushState(state);

    onSamplesPlayed(state, 2400, 1.1, 0);        // in flight, from before
    notePts(state, 90);

    expect(sinkClockSeconds(state)).toBeCloseTo(90, 6);
  });

  it("takes a report from the epoch it is now in", () => {
    const state = createSinkState(48000);
    notePts(state, 100);
    flushState(state);
    notePts(state, 90);
    onSamplesPlayed(state, 24000, 1.1, state.epoch);
    expect(sinkClockSeconds(state)).toBeCloseTo(90.5, 6);
  });

  it("reads what is audible, not what has been written to the output", () => {
    // Video is presented against this clock, so anything it does not subtract
    // is a lip-sync error: 10-50ms wired, 150ms and more over Bluetooth.
    // ffplay subtracts its hardware buffer for the same reason.
    const state = createSinkState(48000);
    notePts(state, 10);
    onSamplesPlayed(state, 48000);
    expect(sinkClockSeconds(state, undefined, 0.05)).toBeCloseTo(10.95, 6);
  });

  it("a seek clears the clock, so it anchors again where playback lands", () => {
    // The clock belongs to where playback was. Left counting from the original
    // first timestamp while the decoder emits the new position's, a rewind puts
    // the playhead ten seconds ahead of every frame arriving: `starvedBy`
    // reports the size of the seek, the starvation rule fires twice, and the
    // channel goes back to the transcode on the first press of Back 10s.
    const state = createSinkState(48000);
    notePts(state, 100);
    onSamplesPlayed(state, 96000);            // clock = 102
    expect(sinkClockSeconds(state)).toBeCloseTo(102);

    // What flush does to the accounting.
    state.firstPtsSeconds = null;
    state.samplesPlayed = 0;
    expect(sinkClockSeconds(state)).toBeNull();

    // Rewound ten seconds: the next chunk anchors there, not at 102.
    notePts(state, 92);
    expect(sinkClockSeconds(state)).toBeCloseTo(92);
    expect(starvedBy(state, 92)).toBe(0);
  });
});
