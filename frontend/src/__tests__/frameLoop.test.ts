import { describe, it, expect, vi } from "vitest";

import { startFrameLoop, type FrameSource } from "../lib/playbackSurface";

/**
 * A frame source driven by hand.
 *
 * No display, no clock, no jsdom: `flush` runs whatever the loop last asked
 * for, one frame at a time, which is the only way the swap is observable —
 * jsdom's own `requestAnimationFrame` would run both sources and hide exactly
 * the bug this exists to catch.
 */
function fakeFrames() {
  let next = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    ticks: 0,
    source: {
      request(callback: FrameRequestCallback) {
        const handle = next++;
        pending.set(handle, callback);
        return handle;
      },
      cancel(handle: number) { pending.delete(handle); },
    } as FrameSource,
    /** Run up to `n` frames, stopping early if nothing is outstanding. */
    flush(this: { ticks: number }, n: number) {
      for (let i = 0; i < n; i++) {
        const [handle, callback] = pending.entries().next().value ?? [];
        if (callback === undefined) return;
        pending.delete(handle!);
        this.ticks++;
        callback(0);
      }
    },
    get outstanding() { return pending.size; },
  };
}

describe("startFrameLoop", () => {
  it("steps once per frame on the source it was given", () => {
    const frames = fakeFrames();
    const step = vi.fn(() => true);
    startFrameLoop(step, frames.source);

    frames.flush(3);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("moves to a new source and lets the old one go", () => {
    // The reason the swap cannot just assign: a handle belongs to the source
    // that issued it, and an uncancelled request from the old one would go on
    // stepping the same loop in parallel with the new.
    const home = fakeFrames();
    const away = fakeFrames();
    const step = vi.fn(() => true);
    const loop = startFrameLoop(step, home.source);

    home.flush(3);
    loop.setFrameSource(away.source);

    expect(home.outstanding).toBe(0);
    home.flush(5);
    away.flush(2);
    expect(step).toHaveBeenCalledTimes(5);
  });

  it("comes back to the source it started on", () => {
    const home = fakeFrames();
    const away = fakeFrames();
    const loop = startFrameLoop(() => true, home.source);

    loop.setFrameSource(away.source);
    away.flush(1);
    loop.setFrameSource(home.source);

    expect(away.outstanding).toBe(0);
    expect(home.outstanding).toBe(1);
  });

  it("stops when the step says so, asking for no further frames", () => {
    const frames = fakeFrames();
    const step = vi.fn(() => false);
    startFrameLoop(step, frames.source);

    frames.flush(3);
    expect(step).toHaveBeenCalledTimes(1);
    expect(frames.outstanding).toBe(0);
  });

  it("cancels on the source that is current when it is stopped", () => {
    // Destroying while popped out cancels against the pop-out window, not the
    // document the session was opened from.
    const home = fakeFrames();
    const away = fakeFrames();
    const loop = startFrameLoop(() => true, home.source);

    loop.setFrameSource(away.source);
    loop.stop();

    expect(away.outstanding).toBe(0);
    expect(home.outstanding).toBe(0);
  });

  it("does not restart a loop that has already finished", () => {
    // The pop-out closing after the session gave up is an ordinary sequence:
    // the failure tears the player down, and the window's `pagehide` arrives
    // afterwards asking for the document's frames back.
    const frames = fakeFrames();
    const away = fakeFrames();
    const step = vi.fn(() => false);
    const loop = startFrameLoop(step, frames.source);

    frames.flush(1);
    loop.setFrameSource(away.source);
    away.flush(3);

    expect(step).toHaveBeenCalledTimes(1);
    expect(away.outstanding).toBe(0);
  });
});
