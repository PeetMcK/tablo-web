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
import type { PositionedCue } from "../lib/captions";

/** A frame source a test steps by hand, so no clock is involved. */
function manualFrames() {
  let pending: FrameRequestCallback | null = null;
  const frames: FrameSource = {
    request(callback) { pending = callback; return 1; },
    cancel() { pending = null; },
  };
  return { frames, step: () => act(() => { const p = pending; pending = null; p?.(0); }) };
}

function source(cues: PositionedCue[]) {
  let now = 0;
  const src: CaptionSource = {
    available: true,
    at: () => cues.find((c) => now >= c.startSeconds && now < c.endSeconds) ?? null,
    on: () => () => {},
  };
  return { src, seek: (t: number) => { now = t; } };
}

const HELLO: PositionedCue = { startSeconds: 1, endSeconds: 3, text: "HELLO" };

describe("CaptionOverlay", () => {
  it("draws the cue covering the current time", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    render(<CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />);
    seek(2);
    step();

    expect(screen.getByText("HELLO")).toBeTruthy();
  });

  it("draws nothing when no cue covers the time", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    render(<CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />);
    seek(5);
    step();

    expect(screen.queryByText("HELLO")).toBeNull();
  });

  it("clears a caption once its cue has passed", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    render(<CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />);
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

    render(<CaptionOverlay source={() => src} enabled={false} currentTime={() => 0} frames={frames} />);
    seek(2);
    step();

    expect(screen.queryByText("HELLO")).toBeNull();
  });

  it("puts each row on its own line", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 0, endSeconds: 9, text: "FIRST\nSECOND" }]);

    render(<CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />);
    seek(1);
    step();

    expect(screen.getByText("FIRST")).toBeTruthy();
    expect(screen.getByText("SECOND")).toBeTruthy();
  });

  it("is announced to a screen reader", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{ startSeconds: 0, endSeconds: 9, text: "HELLO" }]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it("rests low while the chrome is hidden", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(2);
    step();

    const box = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(box.getAttribute("data-raised")).toBe("false");
  });

  it("lifts clear of the transport when the chrome is showing", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled raised currentTime={() => 0} frames={frames} />,
    );
    seek(2);
    step();

    // The floor, not a lift: captions hold their resting height unless that
    // would put them inside the transport band, and only then rise to its top
    // edge. Which of the two applies is the window's business, not ours.
    const box = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(box.getAttribute("data-raised")).toBe("true");
  });

  it("places a positioned cue where the broadcaster put it", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{
      startSeconds: 0, endSeconds: 9, text: "OVER HERE",
      region: { anchor: "top-left", xPercent: 0, yPercent: 0, rows: 4, columns: 32 },
    }]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    const box = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(box.getAttribute("data-positioned")).toBe("true");
    // 0% of the title-safe area is 10% of the stage, not its edge.
    expect(box.style.left).toBe("10%");
    expect(box.style.top).toBe("10%");
  });

  it("bottom-centres a cue with no region, as 608 has always been drawn", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([HELLO]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(2);
    step();

    const box = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(box.getAttribute("data-positioned")).toBe("false");
  });

  it("clamps a window the broadcaster put outside the frame", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{
      startSeconds: 0, endSeconds: 9, text: "OFF SCREEN",
      region: { anchor: "top-left", xPercent: 400, yPercent: -50, rows: 4, columns: 32 },
    }]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    // Clamped to the safe area's own edges rather than trusted.
    const box = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(box.style.left).toBe("90%");
    expect(box.style.top).toBe("10%");
  });

  it("draws a solid background when the broadcaster asked for transparent", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{
      startSeconds: 0, endSeconds: 9, text: "READ ME",
      style: { background: "transparent", foreground: "white" },
    }]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    // The overlay's own plate, not the broadcaster's nothing.
    const inner = container.querySelector("p")!.parentElement as HTMLElement;
    expect(inner.style.backgroundColor).toBe("");
    expect(inner.className).toContain("bg-black/75");
  });

  it("applies the styling a broadcaster does send", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{
      startSeconds: 0, endSeconds: 9, text: "SPEAKER",
      style: { foreground: "yellow", background: "black", italic: true, underline: true },
    }]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    const inner = container.querySelector("p")!.parentElement as HTMLElement;
    expect(inner.style.color).toBe("yellow");
    expect(inner.style.backgroundColor).toBe("black");
    expect(inner.style.fontStyle).toBe("italic");
    expect(inner.style.textDecoration).toBe("underline");
  });

  it("lifts a window placed down by the transport, and leaves a high one alone", () => {
    const low = source([{
      startSeconds: 0, endSeconds: 9, text: "LOW",
      region: { anchor: "bottom-left", xPercent: 10, yPercent: 99, rows: 4, columns: 32 },
    }]);
    const high = source([{
      startSeconds: 0, endSeconds: 9, text: "HIGH",
      region: { anchor: "top-left", xPercent: 10, yPercent: 10, rows: 4, columns: 32 },
    }]);

    const a = manualFrames();
    const lowRender = render(
      <CaptionOverlay source={() => low.src} enabled raised currentTime={() => 0} frames={a.frames} />,
    );
    low.seek(1);
    a.step();
    expect(
      (lowRender.container.querySelector('[aria-live="polite"]') as HTMLElement)
        .getAttribute("data-raised"),
    ).toBe("true");

    const b = manualFrames();
    const highRender = render(
      <CaptionOverlay source={() => high.src} enabled raised currentTime={() => 0} frames={b.frames} />,
    );
    high.seek(1);
    b.step();
    expect(
      (highRender.container.querySelector('[data-positioned="true"][data-raised="false"]')),
    ).toBeTruthy();
  });
});
