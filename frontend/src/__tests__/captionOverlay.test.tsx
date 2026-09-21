/**
 * What is drawn, and when nothing is.
 *
 * The frame source is injected, so these step the loop by hand rather than
 * waiting on a clock — the same seam the presenter tests use.
 */

import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";

import { CaptionOverlay } from "../components/CaptionOverlay";
import type { CaptionSource, FrameSource } from "../lib/playbackSurface";
import type { CaptionCue } from "../lib/captions";

/** A frame source a test steps by hand, so no clock is involved. */
function manualFrames() {
  let pending: FrameRequestCallback | null = null;
  const frames: FrameSource = {
    request(callback) { pending = callback; return 1; },
    cancel() { pending = null; },
  };
  return { frames, step: () => act(() => { const p = pending; pending = null; p?.(0); }) };
}

function source(cues: CaptionCue[]) {
  let now = 0;
  const src: CaptionSource = {
    available: true,
    at: () => cues.find((c) => now >= c.startSeconds && now < c.endSeconds) ?? null,
    on: () => () => {},
  };
  return { src, seek: (t: number) => { now = t; } };
}

const HELLO: CaptionCue = { startSeconds: 1, endSeconds: 3, text: "HELLO" };

describe("CaptionOverlay", () => {
  it("draws the cue covering the current time", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    render(<CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />);
    seek(2);
    step();

    expect(screen.getByText("HELLO")).toBeTruthy();
  });

  it("draws nothing when no cue covers the time", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    render(<CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />);
    seek(5);
    step();

    expect(screen.queryByText("HELLO")).toBeNull();
  });

  it("clears a caption once its cue has passed", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    render(<CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />);
    seek(2);
    step();
    expect(screen.getByText("HELLO")).toBeTruthy();

    seek(4);
    step();
    expect(screen.queryByText("HELLO")).toBeNull();
  });

  it("draws nothing when captions are switched off", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    render(<CaptionOverlay source={src} enabled={false} currentTime={() => 0} frames={frames} />);
    seek(2);
    step();

    expect(screen.queryByText("HELLO")).toBeNull();
  });

  it("puts each row on its own line", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 0, endSeconds: 9, text: "FIRST\nSECOND" }]);

    render(<CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />);
    seek(1);
    step();

    expect(screen.getByText("FIRST")).toBeTruthy();
    expect(screen.getByText("SECOND")).toBeTruthy();
  });

  it("is announced to a screen reader", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 0, endSeconds: 9, text: "HELLO" }]);

    const { container } = render(
      <CaptionOverlay source={src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });
});
