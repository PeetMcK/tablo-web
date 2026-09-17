import { describe, it, expect } from "vitest";

import { isIncomplete, recordedSpan } from "../lib/recording";

/**
 * Every number here was measured against a real device on 2026-09-17, because
 * the cases that matter are the ones nobody would think to invent: a tuner that
 * started 63 minutes late, a recording stopped by hand, and three that captured
 * seconds of an hour while reporting no error at all.
 */

const SLOT_START = "2026-09-17T16:00:00Z";

/** Seconds after the scheduled start, as the ISO stamp the device would give. */
const began = (offsetSeconds: number) =>
  new Date(Date.parse(SLOT_START) + offsetSeconds * 1000).toISOString();

describe("recordedSpan", () => {
  it("starts the fill where recording actually began", () => {
    // Let's Make a Deal: started by hand 1259s into a 3600s slot, stopped at
    // 2106s captured. Flush left it would look like a complete recording.
    const s = recordedSpan({
      start: SLOT_START, duration: 3600,
      recording_started: began(1259), recorded_seconds: 2106,
    })!;

    expect(s.left).toBeCloseTo(34.97, 1);
    expect(s.left + s.width).toBeCloseTo(93.47, 1);
  });

  it("sits at the left edge when the tuner started early", () => {
    // Routine: several recordings began 15 seconds before their slot. A
    // negative offset must not push the fill off the strip.
    const s = recordedSpan({
      start: SLOT_START, duration: 3600,
      recording_started: began(-15), recorded_seconds: 600,
    })!;

    expect(s.left).toBeCloseTo(0, 1);
  });

  it("spans the union of the slot and what was captured", () => {
    // NFL pads by thirty minutes on purpose: a 10800s slot, 12615s captured
    // from -15. Clamping to the slot would hide that the padding exists.
    const s = recordedSpan({
      start: SLOT_START, duration: 10800,
      recording_started: began(-15), recorded_seconds: 12615,
    })!;

    expect(s.left).toBeCloseTo(0, 1);
    expect(s.width).toBeCloseTo(100, 1);
    expect(s.slotEnd).toBeCloseTo(85.6, 0);
  });

  it("marks no slot end when the overrun is not worth seeing", () => {
    // Good Morning America ran 59 seconds past a two-hour slot. A tick on the
    // final pixel reads as a rendering fault, not information.
    const s = recordedSpan({
      start: SLOT_START, duration: 7200,
      recording_started: began(3786), recorded_seconds: 3473,
    })!;

    expect(s.slotEnd).toBeNull();
  });

  it("shows a four-second recording as the sliver it is", () => {
    // First Civilizations: the tuner began 3401s into the hour and captured
    // eight seconds. The device reports no error, so this bar is the only
    // thing in the app that says the recording is broken.
    const s = recordedSpan({
      start: SLOT_START, duration: 3600,
      recording_started: began(3401), recorded_seconds: 8,
    })!;

    expect(s.left).toBeCloseTo(94.47, 1);
    expect(s.width).toBeLessThan(1);
    expect(s.width).toBeGreaterThan(0);
  });

  it("assumes a punctual start when the device did not say", () => {
    const s = recordedSpan({
      start: SLOT_START, duration: 3600,
      recording_started: null, recorded_seconds: 1800,
    })!;

    expect(s.left).toBe(0);
    expect(s.width).toBeCloseTo(50, 1);
  });

  it("draws nothing without a slot, a start, or a readable stamp", () => {
    const base = {
      start: SLOT_START, duration: 3600,
      recording_started: null, recorded_seconds: 600,
    };

    expect(recordedSpan({ ...base, duration: 0 })).toBeNull();
    expect(recordedSpan({ ...base, start: "" })).toBeNull();
    expect(recordedSpan({ ...base, start: "not a date" })).toBeNull();
    expect(recordedSpan({ ...base, recording_started: "not a date" })).toBeNull();
  });
});

describe("isIncomplete", () => {
  const of = (captured: number) => ({
    start: SLOT_START, duration: 3600,
    recording_started: began(0), recorded_seconds: captured,
  });

  it("flags a recording that captured seconds of an hour", () => {
    // The three measured failures: 4s, 8s and 222s of a 3600s slot. The device
    // called none of them an error.
    expect(isIncomplete(of(4))).toBe(true);
    expect(isIncomplete(of(8))).toBe(true);
    expect(isIncomplete(of(222))).toBe(true);
  });

  it("leaves alone a recording that was merely stopped early or started late", () => {
    // Deliberately stopped at 58.5% of its slot, and one that started fifteen
    // minutes late at 74.6%. Both are useful recordings, not broken ones.
    expect(isIncomplete(of(2106))).toBe(false);
    expect(isIncomplete(of(2684))).toBe(false);
  });

  it("says nothing when there is nothing to judge", () => {
    expect(isIncomplete({ ...of(0), recorded_seconds: null })).toBe(false);
    expect(isIncomplete({ ...of(600), duration: 0 })).toBe(false);
  });
});
