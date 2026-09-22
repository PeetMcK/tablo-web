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

function source(cues: PositionedCue[], other: PositionedCue[] = []) {
  let now = 0;
  const covering = (from: PositionedCue[]) =>
    from.filter((c) => now >= c.startSeconds && now < c.endSeconds);
  const src: CaptionSource = {
    available: true,
    at: () => covering(cues)[0] ?? null,
    allAt: () => covering(cues),
    // The second list stands in for the standard not in play, which only
    // compare mode ever asks about.
    compareAt: () => ({ cea608: covering(other), cea708: covering(cues) }),
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
      region: { anchor: "top-left", xPercent: 0, yPercent: 0, rows: 4, columns: 32, gridColumns: 42, align: "center" },
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
      region: { anchor: "top-left", xPercent: 400, yPercent: -50, rows: 4, columns: 32, gridColumns: 42, align: "center" },
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
      region: { anchor: "bottom-left", xPercent: 10, yPercent: 99, rows: 4, columns: 32, gridColumns: 42, align: "center" },
    }]);
    const high = source([{
      startSeconds: 0, endSeconds: 9, text: "HIGH",
      region: { anchor: "top-left", xPercent: 10, yPercent: 10, rows: 4, columns: 32, gridColumns: 42, align: "center" },
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

  it("gives a window the width the broadcaster declared", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source([{
      startSeconds: 0, endSeconds: 9, text: "A LINE THE BROADCASTER SIZED",
      region: { anchor: "top-left", xPercent: 0, yPercent: 0, rows: 2, columns: 32, gridColumns: 42, align: "left" },
    }]);

    const { container } = render(
      <CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    // 32 character cells of the 42 a 16:9 window can hold, across the
    // title-safe 80% of the stage. Divided into the 210-cell *anchor* grid
    // instead, the plate came out five times too narrow. Sized to its text
    // broadcaster had already broken, and puts its anchor in the wrong place -
    // which is what "708 renders off-centre and too narrow" was.
    const box = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(box.style.width).toBe(`${(32 / 42) * 80}%`);
    expect(box.style.justifyContent).toBe("flex-start");
  });

  it("draws every window that is up, not just one of them", () => {
    const { frames, step } = manualFrames();
    // Two windows at once is ordinary 708: a speaker's line low down and a
    // title higher up. Answering with one of them is how information went
    // missing.
    const { src, seek } = source([
      {
        startSeconds: 0, endSeconds: 9, text: "SPEAKER",
        region: { anchor: "bottom-left", xPercent: 10, yPercent: 90, rows: 2, columns: 32, gridColumns: 42, align: "left" },
      },
      {
        startSeconds: 0, endSeconds: 9, text: "TITLE",
        region: { anchor: "top-right", xPercent: 90, yPercent: 10, rows: 1, columns: 16, gridColumns: 42, align: "right" },
      },
    ]);

    render(<CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />);
    seek(1);
    step();

    expect(screen.getByText("SPEAKER")).toBeTruthy();
    expect(screen.getByText("TITLE")).toBeTruthy();
  });

  it("draws both standards, labelled, when comparing", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source(
      [{
        startSeconds: 0, endSeconds: 9, text: "FROM 708",
        region: { anchor: "top-left", xPercent: 0, yPercent: 0, rows: 1, columns: 32, gridColumns: 42, align: "center" },
      }],
      [{ startSeconds: 0, endSeconds: 9, text: "FROM 608" }],
    );

    const { container } = render(
      <CaptionOverlay source={() => src} enabled compare currentTime={() => 0} frames={frames} />,
    );
    seek(1);
    step();

    expect(screen.getByText("FROM 708")).toBeTruthy();
    expect(screen.getByText("FROM 608")).toBeTruthy();
    expect(container.querySelector('[data-caption-badge="708"]')).toBeTruthy();
    expect(container.querySelector('[data-caption-badge="608"]')).toBeTruthy();
  });

  it("shows only the latched standard when not comparing", () => {
    const { frames, step } = manualFrames();
    const { src, seek } = source(
      [{ startSeconds: 0, endSeconds: 9, text: "FROM 708" }],
      [{ startSeconds: 0, endSeconds: 9, text: "FROM 608" }],
    );

    render(<CaptionOverlay source={() => src} enabled currentTime={() => 0} frames={frames} />);
    seek(1);
    step();

    expect(screen.getByText("FROM 708")).toBeTruthy();
    expect(screen.queryByText("FROM 608")).toBeNull();
  });
});
