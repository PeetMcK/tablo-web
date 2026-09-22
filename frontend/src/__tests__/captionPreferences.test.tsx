/**
 * The two things a viewer can say about captions beyond on and off.
 *
 * Placement is the one people disagree about: following the broadcaster's
 * window dodges a news banner and a speaker's face, and it also means the
 * captions move whenever the broadcaster moves them. Standard is mostly ours
 * - both decoders run on every stream, so being able to force one is how you
 * find out which is at fault without leaving the picture.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

import { CaptionOverlay } from "../components/CaptionOverlay";
import type { CaptionSource, FrameSource } from "../lib/playbackSurface";
import type { PositionedCue } from "../lib/captions";
import {
  loadCaptionPreferences, saveCaptionPreferences, DEFAULT_CAPTION_PREFERENCES,
} from "../lib/captions/preferences";

function manualFrames() {
  let pending: FrameRequestCallback | null = null;
  const frames: FrameSource = {
    request(callback) { pending = callback; return 1; },
    cancel() { pending = null; },
  };
  return { frames, step: () => act(() => { const p = pending; pending = null; p?.(0); }) };
}

/** A source holding a different caption in each standard, so they are told apart. */
function twoStandards() {
  const region = (x: number, y: number) => ({
    anchor: "top-left" as const, xPercent: x, yPercent: y,
    rows: 2, columns: 32, gridColumns: 42, align: "center" as const,
  });
  const cea608: PositionedCue[] = [
    { startSeconds: 0, endSeconds: 9, text: "FROM 608", region: region(0, 90) },
  ];
  const cea708: PositionedCue[] = [
    { startSeconds: 0, endSeconds: 9, text: "FROM 708", region: region(10, 20) },
    { startSeconds: 0, endSeconds: 9, text: "SECOND WINDOW", region: region(60, 80) },
  ];
  const src: CaptionSource = {
    available: true,
    // The latch, which is what `auto` follows.
    at: () => cea708[0],
    allAt: () => cea708,
    compareAt: () => ({ cea608, cea708 }),
    on: () => () => {},
  };
  return src;
}

function draw(props: Partial<Parameters<typeof CaptionOverlay>[0]> = {}) {
  const { frames, step } = manualFrames();
  const src = twoStandards();
  const view = render(
    <CaptionOverlay
      source={() => src} enabled currentTime={() => 1} frames={frames} {...props}
    />,
  );
  step();
  return view;
}

describe("caption preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the broadcaster's placement and whichever standard is latched", () => {
    draw();
    expect(screen.getByText("FROM 708")).toBeTruthy();
    expect(screen.queryByText("FROM 608")).toBeNull();
  });

  it("shows 608 when asked for it, on a stream that latched onto 708", () => {
    draw({ standard: "cea608" });
    expect(screen.getByText("FROM 608")).toBeTruthy();
    expect(screen.queryByText("FROM 708")).toBeNull();
  });

  it("shows 708 when asked for it", () => {
    draw({ standard: "cea708" });
    expect(screen.getByText("FROM 708")).toBeTruthy();
    expect(screen.queryByText("FROM 608")).toBeNull();
  });

  it("keeps windows where the broadcaster put them by default", () => {
    const { container } = draw();
    const boxes = container.querySelectorAll('[data-positioned="true"]');
    // Both 708 windows, each at its own place.
    expect(boxes.length).toBe(2);
  });

  it("puts everything in one fixed place when asked to", () => {
    const { container } = draw({ placement: "bottom" });

    // One box, unpositioned — several windows at once would otherwise land on
    // top of each other, there being only one place to put them.
    const boxes = container.querySelectorAll('[aria-live="polite"]');
    expect(boxes.length).toBe(1);
    expect(boxes[0].getAttribute("data-positioned")).toBe("false");

    // And nothing is lost: the windows are read top to bottom.
    const text = (boxes[0] as HTMLElement).innerText ?? boxes[0].textContent ?? "";
    expect(text).toContain("FROM 708");
    expect(text).toContain("SECOND WINDOW");
  });

  it("carries both settings across sessions", () => {
    saveCaptionPreferences({ placement: "bottom", standard: "cea608" });
    expect(loadCaptionPreferences()).toEqual({ placement: "bottom", standard: "cea608" });
  });

  it("ignores a stored value it does not recognize", () => {
    localStorage.setItem("tablo.cc.placement", "sideways");
    localStorage.setItem("tablo.cc.standard", "cea999");
    // A person can edit this store, and a typo should not put the player in a
    // state with no name.
    expect(loadCaptionPreferences()).toEqual(DEFAULT_CAPTION_PREFERENCES);
  });
});
