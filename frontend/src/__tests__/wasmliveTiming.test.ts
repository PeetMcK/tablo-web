import { describe, it, expect } from "vitest";

import { admit, selectFrame, MAX_QUEUED_FRAMES } from "../lib/wasmlive/frameQueue";
import { LOOKAHEAD_SECONDS } from "../lib/wasmlive/session";
import {
  audioClockSeconds, starvationSeconds, MAX_INTERPOLATION_SECONDS,
} from "../lib/wasmlive/audioClock";

const f = (ptsSeconds: number) => ({ ptsSeconds });

describe("selectFrame", () => {
  it("presents the newest entry that is due, and discards what it passed", () => {
    // This used to present the *oldest* due entry unless three had piled up,
    // to spend a late tick on lateness rather than on a discarded field. The
    // measurement behind that was real — 47 presentations a second out of the
    // 59.94 offered — but it was the main thread missing animation frames, and
    // showing a stale field on the next tick does not recover a missed one.
    //
    // ffplay's `video_refresh` drops a frame whenever its successor is also
    // due, so it never shows one that has been overtaken; jsmpeg shows the
    // newest outright.
    const queue = [f(1.0), f(1.017), f(1.033), f(1.05)];
    const { present, drop, keep } = selectFrame(queue, 1.034);
    expect(present).toEqual(f(1.033));
    expect(drop).toEqual([f(1.0), f(1.017)]);
    expect(keep).toEqual([f(1.05)]);
  });

  it("holds when the whole queue is still in the future", () => {
    const queue = [f(2.0), f(2.017)];
    expect(selectFrame(queue, 1.5)).toEqual({ present: null, drop: [], keep: queue });
  });

  it("goes straight to the present after a backlog", () => {
    // A tab that was hidden comes back with a queue from a second ago. The
    // viewer needs to see where the programme is now, not a second of history
    // replayed at high speed.
    const queue = [f(1.0), f(1.017), f(1.033), f(1.05), f(5.0)];
    const { present, drop, keep } = selectFrame(queue, 5.0);
    expect(present).toEqual(f(5.0));
    expect(drop).toEqual([f(1.0), f(1.017), f(1.033), f(1.05)]);
    expect(keep).toEqual([]);
  });

  it("draws exactly one field per tick while ticks keep up", () => {
    // The ordinary case, and the one the old rule was trying to protect: at
    // the field rate nothing is ever passed over, because only one entry is
    // due at a time.
    const queue = [f(1.0), f(1.017), f(1.033)];
    for (const [clock, expected] of [[1.0, 1.0], [1.018, 1.017], [1.034, 1.033]]) {
      const selection = selectFrame(queue, clock);
      expect(selection.present).toEqual(f(expected));
      expect(selection.drop).toEqual(queue.filter((e) => e.ptsSeconds < expected));
    }
  });

  it("has nothing to say about an empty queue", () => {
    expect(selectFrame([], 1)).toEqual({ present: null, drop: [], keep: [] });
  });
});

describe("admit", () => {
  it("appends while there is room", () => {
    expect(admit([f(1)], f(2))).toEqual({ queue: [f(1), f(2)], dropped: [] });
  });

  it("refuses the newest at the cap, so 1080p frames cannot pile up", () => {
    // Evicting the front was measured on the real device at three fields a
    // second reaching the screen out of sixty. The queue is time-ordered, so
    // its front is the next field due: dropping it to make room for one a
    // second and a half away throws away the picture that was about to be
    // drawn, every time, and does it while the decoder runs ahead. The entry
    // furthest from being needed is the one to lose.
    const full = Array.from({ length: MAX_QUEUED_FRAMES }, (_, i) => f(i));
    const { queue, dropped } = admit(full, f(99));
    expect(queue.length).toBe(MAX_QUEUED_FRAMES);
    expect(dropped).toEqual([f(99)]);
    expect(queue[0]).toEqual(f(0));
    expect(queue[queue.length - 1]).toEqual(f(MAX_QUEUED_FRAMES - 1));
  });

  it("holds more than the transport will feed ahead", () => {
    // The cap has to exceed the lookahead or it is not a backstop, it is the
    // policy: the session's two second lookahead is ~120 field presentations
    // at 59.94, and a queue smaller than that evicts continuously in normal
    // running.
    expect(MAX_QUEUED_FRAMES).toBeGreaterThan(LOOKAHEAD_SECONDS * 59.94);
  });
});

describe("audioClockSeconds", () => {
  it("is the first pts plus what has been played", () => {
    expect(audioClockSeconds({ firstPtsSeconds: 10, samplesPlayed: 48000, sampleRate: 48000, anchorContextTime: null }))
      .toBe(11);
  });

  it("is unknown before any audio has been played", () => {
    expect(audioClockSeconds({ firstPtsSeconds: null, samplesPlayed: 0, sampleRate: 48000, anchorContextTime: null }))
      .toBeNull();
  });

  it("runs on between reports rather than waiting in steps", () => {
    // The worklet reports every 4800 frames — a tenth of a second — so read
    // raw this is a staircase with ten steps a second, and video presented
    // against it can only be drawn ten times a second however many fields are
    // ready. Measured on the device: 60 animation frames a second, a clock
    // that moved on twelve of them, 8 field presentations out of 59.94.
    const state = {
      firstPtsSeconds: 10, samplesPlayed: 48000, sampleRate: 48000, anchorContextTime: 5,
    };
    expect(audioClockSeconds(state, 5)).toBeCloseTo(11);
    expect(audioClockSeconds(state, 5.016)).toBeCloseTo(11.016);
    expect(audioClockSeconds(state, 5.05)).toBeCloseTo(11.05);
  });

  it("stops running on when the audio does", () => {
    // An underrun renders silence and stops counting frames while the context
    // clock carries on. Video must freeze with the sound, not sail past it.
    const state = {
      firstPtsSeconds: 10, samplesPlayed: 48000, sampleRate: 48000, anchorContextTime: 5,
    };
    expect(audioClockSeconds(state, 5 + MAX_INTERPOLATION_SECONDS + 10))
      .toBeCloseTo(11 + MAX_INTERPOLATION_SECONDS);
  });

  it("never runs backwards across a report", () => {
    const before = audioClockSeconds(
      { firstPtsSeconds: 10, samplesPlayed: 48000, sampleRate: 48000, anchorContextTime: 5 },
      5.0999,
    )!;
    // The report lands: 4800 more frames played, and the anchor moves with it.
    const after = audioClockSeconds(
      { firstPtsSeconds: 10, samplesPlayed: 52800, sampleRate: 48000, anchorContextTime: 5.1 },
      5.1,
    )!;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe("starvationSeconds", () => {
  it("measures how far the clock has outrun the newest decoded frame", () => {
    const state = { firstPtsSeconds: 10, samplesPlayed: 96000, sampleRate: 48000, anchorContextTime: null };  // clock = 12
    expect(starvationSeconds(state, 11.5)).toBeCloseTo(0.5);
  });

  it("is zero while frames are ahead of the clock", () => {
    const state = { firstPtsSeconds: 10, samplesPlayed: 96000, sampleRate: 48000, anchorContextTime: null };
    expect(starvationSeconds(state, 12.5)).toBe(0);
  });

  it("is zero when there is no clock yet", () => {
    expect(starvationSeconds({ firstPtsSeconds: null, samplesPlayed: 0, sampleRate: 48000, anchorContextTime: null }, null))
      .toBe(0);
  });

  it("is zero when nothing has been decoded yet, rather than infinite", () => {
    // Startup is not starvation; the fallback machine has its own deadline
    // for a first frame and this must not pre-empt it.
    const state = { firstPtsSeconds: 10, samplesPlayed: 0, sampleRate: 48000, anchorContextTime: null };
    expect(starvationSeconds(state, null)).toBe(0);
  });
});
