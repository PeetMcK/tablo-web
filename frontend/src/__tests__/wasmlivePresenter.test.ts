import { describe, it, expect } from "vitest";

import { createPresenter } from "../lib/wasmlive/presenter";
import { MAX_QUEUED_FRAMES } from "../lib/wasmlive/frameQueue";
import type { DecodedVideoFrame } from "../lib/wasmlive/types";

const FRAME = 0.03337;

function decoded(ptsSeconds: number, overrides: Partial<DecodedVideoFrame> = {}): DecodedVideoFrame {
  return {
    data: new Uint8Array(6), width: 2, height: 2,
    ptsSeconds, durationSeconds: FRAME, interlaced: true, topFieldFirst: true,
    sampleAspectRatio: 1,
    ...overrides,
  };
}

function harness(startClock = 0) {
  const drawn: { pts: number; parity: string; interlaced: boolean }[] = [];
  const uploaded: number[] = [];
  let clock = startClock;
  const presenter = createPresenter({
    now: () => clock,
    upload: (frame) => { uploaded.push(frame.ptsSeconds); },
    draw: (entry) => drawn.push({
      pts: entry.ptsSeconds, parity: entry.parity, interlaced: entry.interlaced,
    }),
  });
  return {
    presenter, drawn, uploaded,
    setClock: (t: number | null) => { clock = t as number; },
  };
}

describe("createPresenter", () => {
  it("splits an interlaced frame into two fields, half a frame apart", () => {
    const { presenter } = harness();
    presenter.offer(decoded(1));
    // 1080i29.97 in, 59.94 field presentations out.
    expect(presenter.queued).toBe(2);
    expect(presenter.newestPts).toBeCloseTo(1 + FRAME / 2, 5);
  });

  it("shows the top field first when the frame says so", () => {
    const { presenter, drawn, setClock } = harness();
    presenter.offer(decoded(1));
    setClock(1);
    presenter.tick();
    expect(drawn[0].parity).toBe("top");
    setClock(1 + FRAME / 2);
    presenter.tick();
    expect(drawn[1].parity).toBe("bottom");
  });

  it("shows the bottom field first when the frame says so", () => {
    const { presenter, drawn, setClock } = harness();
    presenter.offer(decoded(1, { topFieldFirst: false }));
    setClock(1);
    presenter.tick();
    expect(drawn[0].parity).toBe("bottom");
  });

  it("draws a progressive frame once, untouched", () => {
    // Commercials and some subchannels arrive progressive; interpolating them
    // would soften a picture that needs nothing done to it.
    const { presenter, drawn, setClock } = harness();
    presenter.offer(decoded(1, { interlaced: false }));
    expect(presenter.queued).toBe(1);
    setClock(1);
    presenter.tick();
    expect(drawn).toEqual([{ pts: 1, parity: "top", interlaced: false }]);
  });

  it("draws nothing while the queue is ahead of the clock", () => {
    const { presenter, drawn } = harness(0);
    presenter.offer(decoded(1));
    presenter.tick();
    expect(drawn).toEqual([]);
  });

  it("draws the newest field whose moment has come", () => {
    // Two frames are four field presentations, and by the clock below the
    // first three are due. The viewer must see where the programme is now.
    //
    // This drew the *oldest* due field until three had piled up, on the theory
    // that a late tick should cost lateness rather than a discarded field. The
    // measurement behind it was real — 47 presentations a second out of 59.94
    // — but it was the main thread missing animation frames, and drawing a
    // stale field on the next tick does not recover a missed one. At any tick
    // rate below the field rate the picture slid up to 66ms behind the sound
    // and then snapped back, three times a second.
    //
    // ffplay never shows a frame whose successor is already due; jsmpeg shows
    // the newest.
    const { presenter, drawn, setClock } = harness(0);
    presenter.offer(decoded(1));
    presenter.offer(decoded(1 + FRAME));
    setClock(1 + FRAME);
    presenter.tick();

    expect(drawn).toHaveLength(1);
    expect(drawn[0].pts).toBeCloseTo(1 + FRAME, 5);

    // And what it passed is gone rather than waiting to be drawn late.
    presenter.tick();
    expect(drawn).toHaveLength(1);
  });

  it("stays on the clock when ticks are slower than fields", () => {
    // Battery saver, an occluded window, a main thread under load: half the
    // animation frames arrive. Every one of them must draw the field for
    // *now*, not the oldest of the ones that piled up since the last.
    const { presenter, drawn, setClock } = harness(0);
    for (let i = 0; i < 10; i++) presenter.offer(decoded(1 + i * FRAME));

    for (let tick = 1; tick <= 5; tick++) {
      const now = 1 + tick * FRAME;      // one tick per frame, two fields due
      setClock(now);
      presenter.tick();
      expect(drawn[drawn.length - 1].pts).toBeCloseTo(now, 5);
    }
  });

  it("uploads a frame's planes once, not once per field", () => {
    const { presenter, uploaded, setClock } = harness(0);
    presenter.offer(decoded(1));
    setClock(1 + FRAME);
    presenter.tick();
    expect(uploaded).toEqual([1]);
  });

  it("evicts at the queue cap rather than growing", () => {
    const { presenter } = harness(0);
    for (let i = 0; i < MAX_QUEUED_FRAMES; i++) presenter.offer(decoded(10 + i));
    expect(presenter.queued).toBe(MAX_QUEUED_FRAMES);
  });

  it("knows the newest pts it holds, for starvation detection", () => {
    const { presenter } = harness(0);
    expect(presenter.newestPts).toBeNull();
    presenter.offer(decoded(4));
    expect(presenter.newestPts).toBeCloseTo(4 + FRAME / 2, 5);
  });

  it("counts what it has presented", () => {
    const { presenter, setClock } = harness(0);
    presenter.offer(decoded(1));
    setClock(1);
    presenter.tick();
    expect(presenter.presentedCount).toBe(1);
  });

  it("empties on destroy", () => {
    const { presenter } = harness(0);
    presenter.offer(decoded(8));
    presenter.destroy();
    expect(presenter.queued).toBe(0);
  });
});

describe("before the clock has started", () => {
  it("draws the oldest field so the viewer sees a picture, not black", () => {
    // Chrome will not start an AudioContext without user activation, so a
    // refreshed page waits with no clock at all. The fields are decoded and
    // queued — they simply carry timestamps nothing has reached yet. Zero is
    // not a valid answer for "what time is it": every field then looks like
    // the distant future and none is ever due.
    const h = harness();
    h.setClock(null);
    h.presenter.offer(decoded(100));

    h.presenter.tick();

    expect(h.drawn).toHaveLength(1);
    expect(h.drawn[0].pts).toBe(100);
  });

  it("draws that still once, not on every frame", () => {
    const h = harness();
    h.setClock(null);
    h.presenter.offer(decoded(100));

    h.presenter.tick();
    h.presenter.tick();
    h.presenter.tick();

    expect(h.drawn).toHaveLength(1);
  });

  it("keeps the field queued, so playback still begins there", () => {
    // The still is a look at what is waiting, not a consumption of it.
    const h = harness();
    h.setClock(null);
    h.presenter.offer(decoded(100));
    h.presenter.tick();
    h.drawn.length = 0;

    // Just past the first field and short of the second, so exactly the field
    // that was shown as a still is the one now due.
    h.setClock(100.005);
    h.presenter.tick();

    expect(h.drawn.length).toBeGreaterThan(0);
    expect(h.drawn[0].pts).toBe(100);
  });

  it("draws nothing when there is nothing decoded yet", () => {
    const h = harness();
    h.setClock(null);

    h.presenter.tick();

    expect(h.drawn).toEqual([]);
  });

  it("counts the fields it skipped past, so no field leaves the queue uncounted", () => {
    const h = harness();
    // Three frames, six fields, spanning about a tenth of a second.
    h.presenter.offer(decoded(1));
    h.presenter.offer(decoded(1 + FRAME));
    h.presenter.offer(decoded(1 + FRAME * 2));
    expect(h.presenter.queued).toBe(6);

    // One tick, arriving after every one of them is due: the newest is drawn
    // and the other five are passed over. Those five used to vanish without a
    // number attached to them, which is why `presentedCount` could never be
    // compared against the field rate.
    h.setClock(1 + FRAME * 3);
    h.presenter.tick();

    expect(h.drawn).toHaveLength(1);
    expect(h.presenter.presentedCount).toBe(1);
    expect(h.presenter.skippedCount).toBe(5);
    expect(h.presenter.queued).toBe(0);
  });

  it("accounts for every field offered: drawn, skipped, refused, or still queued", () => {
    const h = harness();
    // Twice the cap offered, so admission refuses as well, and all three exits
    // are exercised at once.
    const frames = MAX_QUEUED_FRAMES;
    for (let i = 0; i < frames; i++) h.presenter.offer(decoded(1 + FRAME * i));
    const offered = frames * 2;

    h.setClock(1 + FRAME * 10);
    h.presenter.tick();
    h.setClock(1 + FRAME * 20);
    h.presenter.tick();

    expect(
      h.presenter.presentedCount + h.presenter.skippedCount
        + h.presenter.droppedCount + h.presenter.queued,
    ).toBe(offered);
  });

  it("counts every tick, including the ones with nothing due", () => {
    const h = harness();
    h.presenter.offer(decoded(1));
    // The clock is behind the fields, so nothing is due and nothing is drawn —
    // but the animation frame still happened, and that is the quantity being
    // measured. A tick rate below the field rate is the difference between
    // "the decoder produced nothing" and "nobody asked to draw".
    h.setClock(0.5);
    h.presenter.tick();
    h.presenter.tick();

    expect(h.presenter.presentedCount).toBe(0);
    expect(h.presenter.tickCount).toBe(2);
  });
});
