import { describe, it, expect } from "vitest";

import {
  createSinkState, flushState, notePts, onSamplesPlayed, silentWavBytes,
  sinkClockSeconds, starvedBy,
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

describe("silent anchor wav", () => {
  // The bytes a real `<audio src>` plays so the OS media hub adopts the page.
  // Chrome treats a MediaStream-fed element as a one-shot player and never
  // offers it to Now Playing; a file-backed element is the ordinary kind.
  const ascii = (b: Uint8Array, at: number, n: number) =>
    String.fromCharCode(...b.subarray(at, at + n));
  const u32 = (b: Uint8Array, at: number) =>
    new DataView(b.buffer, b.byteOffset).getUint32(at, true);
  const u16 = (b: Uint8Array, at: number) =>
    new DataView(b.buffer, b.byteOffset).getUint16(at, true);

  it("is a well-formed 8-bit mono PCM RIFF/WAVE of the asked length", () => {
    const rate = 8000;
    const seconds = 10;
    const bytes = silentWavBytes(seconds, rate);
    const samples = rate * seconds;
    expect(bytes.length).toBe(44 + samples);
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(u32(bytes, 4)).toBe(36 + samples);
    expect(ascii(bytes, 8, 4)).toBe("WAVE");
    expect(ascii(bytes, 12, 4)).toBe("fmt ");
    expect(u32(bytes, 16)).toBe(16);        // PCM fmt chunk size
    expect(u16(bytes, 20)).toBe(1);         // PCM
    expect(u16(bytes, 22)).toBe(1);         // mono
    expect(u32(bytes, 24)).toBe(rate);
    expect(u32(bytes, 28)).toBe(rate);      // byte rate: 1 byte per frame
    expect(u16(bytes, 32)).toBe(1);         // block align
    expect(u16(bytes, 34)).toBe(8);         // bits per sample
    expect(ascii(bytes, 36, 4)).toBe("data");
    expect(u32(bytes, 40)).toBe(samples);
  });

  it("is silence, which for 8-bit PCM is the unsigned midpoint", () => {
    const bytes = silentWavBytes(1, 8000);
    expect(bytes.subarray(44).every((v) => v === 128)).toBe(true);
  });

  it("outlasts the five seconds Chrome needs to treat media as persistent", () => {
    // Shorter media gets transient audio focus, which the OS hub does not
    // surface. The default must clear that bar with room.
    const bytes = silentWavBytes();
    const rate = u32(bytes, 24);
    expect(u32(bytes, 40) / rate).toBeGreaterThan(5);
  });
});
