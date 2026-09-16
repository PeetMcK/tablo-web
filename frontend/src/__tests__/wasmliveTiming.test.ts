import { describe, it, expect } from "vitest";

import { admit, selectFrame, MAX_QUEUED_FRAMES } from "../lib/wasmlive/frameQueue";
import { audioClockSeconds, starvationSeconds } from "../lib/wasmlive/audioClock";

const f = (ptsSeconds: number) => ({ ptsSeconds });

describe("selectFrame", () => {
  it("presents the newest entry that is due", () => {
    const queue = [f(1.0), f(1.017), f(1.033), f(1.05)];
    const { present, drop, keep } = selectFrame(queue, 1.034);
    expect(present).toEqual(f(1.033));
    // Everything older than what was shown is spent.
    expect(drop).toEqual([f(1.0), f(1.017)]);
    expect(keep).toEqual([f(1.05)]);
  });

  it("holds when the whole queue is still in the future", () => {
    const queue = [f(2.0), f(2.017)];
    expect(selectFrame(queue, 1.5)).toEqual({ present: null, drop: [], keep: queue });
  });

  it("still shows a late entry rather than showing nothing", () => {
    // A tab that was hidden comes back with a queue from a second ago. The
    // newest due entry is the right one to draw, however late it is.
    const queue = [f(1.0), f(1.017), f(5.0)];
    const { present, drop } = selectFrame(queue, 5.0);
    expect(present).toEqual(f(5.0));
    expect(drop).toEqual([f(1.0), f(1.017)]);
  });

  it("has nothing to say about an empty queue", () => {
    expect(selectFrame([], 1)).toEqual({ present: null, drop: [], keep: [] });
  });
});

describe("admit", () => {
  it("appends while there is room", () => {
    expect(admit([f(1)], f(2))).toEqual({ queue: [f(1), f(2)], dropped: [] });
  });

  it("evicts the oldest at the cap, so 1080p frames cannot pile up", () => {
    const full = Array.from({ length: MAX_QUEUED_FRAMES }, (_, i) => f(i));
    const { queue, dropped } = admit(full, f(99));
    expect(queue.length).toBe(MAX_QUEUED_FRAMES);
    expect(dropped).toEqual([f(0)]);
    expect(queue[queue.length - 1]).toEqual(f(99));
  });
});

describe("audioClockSeconds", () => {
  it("is the first pts plus what has been played", () => {
    expect(audioClockSeconds({ firstPtsSeconds: 10, samplesPlayed: 48000, sampleRate: 48000 }))
      .toBe(11);
  });

  it("is unknown before any audio has been played", () => {
    expect(audioClockSeconds({ firstPtsSeconds: null, samplesPlayed: 0, sampleRate: 48000 }))
      .toBeNull();
  });
});

describe("starvationSeconds", () => {
  it("measures how far the clock has outrun the newest decoded frame", () => {
    const state = { firstPtsSeconds: 10, samplesPlayed: 96000, sampleRate: 48000 };  // clock = 12
    expect(starvationSeconds(state, 11.5)).toBeCloseTo(0.5);
  });

  it("is zero while frames are ahead of the clock", () => {
    const state = { firstPtsSeconds: 10, samplesPlayed: 96000, sampleRate: 48000 };
    expect(starvationSeconds(state, 12.5)).toBe(0);
  });

  it("is zero when there is no clock yet", () => {
    expect(starvationSeconds({ firstPtsSeconds: null, samplesPlayed: 0, sampleRate: 48000 }, null))
      .toBe(0);
  });

  it("is zero when nothing has been decoded yet, rather than infinite", () => {
    // Startup is not starvation; the fallback machine has its own deadline
    // for a first frame and this must not pre-empt it.
    const state = { firstPtsSeconds: 10, samplesPlayed: 0, sampleRate: 48000 };
    expect(starvationSeconds(state, null)).toBe(0);
  });
});
