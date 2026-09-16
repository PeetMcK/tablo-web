import { describe, it, expect, vi } from "vitest";

import { createPresenter } from "../lib/wasmlive/presenter";
import { MAX_QUEUED_FRAMES } from "../lib/wasmlive/frameQueue";
import type { DecodedVideoFrame } from "../lib/wasmlive/types";

const FRAME = 0.03337;

function decoded(ptsSeconds: number, overrides: Partial<DecodedVideoFrame> = {}): DecodedVideoFrame {
  return {
    data: new Uint8Array(6), width: 2, height: 2,
    ptsSeconds, durationSeconds: FRAME, interlaced: true, topFieldFirst: true,
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
  return { presenter, drawn, uploaded, setClock: (t: number) => { clock = t; } };
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

  it("draws the newest due field, skipping what it passed", () => {
    const { presenter, drawn, setClock } = harness(0);
    presenter.offer(decoded(1));
    presenter.offer(decoded(1 + FRAME));
    setClock(1 + FRAME);
    presenter.tick();
    expect(drawn).toHaveLength(1);
    expect(drawn[0].pts).toBeCloseTo(1 + FRAME, 5);
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
