/**
 * The handful of questions every view of a recording asks.
 *
 * They used to live inside `LibraryView`, which was fine while the Library was
 * one layout. A row and a card have to answer them identically, and two copies
 * of "is this still recording" is how they stop being identical.
 */
import { describe, it, expect } from "vitest";

import { coverageOf, isPlayable, isRecording, resumeFor } from "../lib/recording";

describe("whether a recording is still being written", () => {
  it("is the device's own word for it", () => {
    expect(isRecording({ state: "recording" })).toBe(true);
    expect(isRecording({ state: "finished" })).toBe(false);
  });
});

describe("whether there is something to play", () => {
  it("plays an offline copy whatever the device reports", () => {
    // The device may not have the recording at all any more.
    expect(isPlayable({ offline_only: true, error: "object_not_found" })).toBe(true);
  });

  it("refuses one the device reported an error for", () => {
    expect(isPlayable({ offline_only: false, error: "tuner_conflict" })).toBe(false);
    expect(isPlayable({ offline_only: false, error: null })).toBe(true);
  });
});

describe("what the coverage bar is shown", () => {
  it("counts the captured part while recording, and the whole once finished", () => {
    const live = coverageOf({
      state: "recording", start: "2026-09-21T22:00:00Z", slot_seconds: 3600,
      recording_started: "2026-09-21T22:00:10Z", recorded_seconds: 480, duration: 0,
    });
    expect(live.recorded_seconds).toBe(480);
    // Finished: `duration` IS the captured length — the device replaces the
    // slot with the real one, which is why `slot_seconds` exists separately.
    const done = coverageOf({
      state: "finished", start: "2026-09-21T22:00:00Z", slot_seconds: 3600,
      recording_started: null, recorded_seconds: null, duration: 1875,
    });
    expect(done.recorded_seconds).toBe(1875);
    expect(done.duration).toBe(3600);
  });
});

describe("where a recording opens", () => {
  const base = {
    object_id: 4242, state: "finished", recorded_seconds: null, duration: 1875,
  };

  it("takes the device's position when it is further in than ours", () => {
    expect(resumeFor({ ...base, position: 937 })).toBe(937);
  });

  it("treats the un-watch sentinel as no position at all", () => {
    // `position: 1` is what we write to clear watched without the device
    // dropping the recording back to New. One second is nothing to resume to.
    expect(resumeFor({ ...base, position: 1 })).toBe(0);
  });

  it("never offers a position past what exists", () => {
    // A position captured while the programme was still recording outruns the
    // media once the device cuts it short.
    expect(resumeFor({ ...base, position: 9999 })).toBe(1875);
  });
});
