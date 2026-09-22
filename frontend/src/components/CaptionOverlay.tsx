/**
 * Captions, over the picture.
 *
 * Drawn in the DOM rather than into the canvas: text stays crisp at any window
 * size, a screen reader can read it, and a test can assert on it without a
 * GPU. The cost is that `captureStream` does not carry it, so captions do not
 * appear in the picture-in-picture pop-out — the pop-out is fed a mirror of
 * canvas pixels, and this is not one of them.
 *
 * It steps on animation frames rather than on the player's `timeupdate`, which
 * fires about four times a second — enough for a scrubber, visibly late for
 * roll-up captions that advance a word at a time.
 *
 * Two layouts, one component. A cue from CEA-608 has only the bottom rows to
 * work with and is drawn where captions have always been drawn; a cue from
 * CEA-708 carries the window the broadcaster placed, and is drawn there.
 */

import { useEffect, useState } from "react";

import { placeInSafeArea } from "../lib/captions/safeArea";
import type { PositionedCue } from "../lib/captions";
import { DOCUMENT_FRAMES, startFrameLoop } from "../lib/playbackSurface";
import type { CaptionSource, FrameSource } from "../lib/playbackSurface";
import { CHROME_BOTTOM_BAND_PX } from "../lib/playerChrome";

/** Where captions sit when nothing is in their way — a television's height. */
const RESTING_BOTTOM = "12%";

/** A little air between the caption box and the top of the transport band. */
const CLEARANCE_PX = 8;

/**
 * How far up the frame a positioned window has to be before the transport
 * stops being its problem.
 *
 * Below this, a broadcaster's window is in the same territory as the scrubber
 * and gets the same treatment as an unpositioned caption; above it, the
 * controls are nowhere near and moving the caption would be the surprising
 * thing.
 */
const NEAR_BOTTOM_PERCENT = 75;

const boxClasses =
  "max-w-[80%] rounded px-3 py-1 text-white text-base sm:text-lg md:text-xl " +
  "font-medium leading-snug text-center";

export function CaptionOverlay({
  source, enabled, currentTime, raised = false, frames = DOCUMENT_FRAMES,
}: {
  /**
   * The current surface's captions, read fresh each frame.
   *
   * A getter rather than the source itself, for the same reason `currentTime`
   * is one: the player replaces its surface — a rebuild, a fallback, a
   * different recording — and a source captured at mount is then answering
   * about a session the clock has left behind. Held as a value once, this
   * silently drew nothing at all: the cue lookup was correct and was being
   * asked of the wrong session.
   */
  source: () => CaptionSource | null;
  enabled: boolean;
  /** Media seconds, read fresh each frame rather than passed as a value. */
  currentTime: () => number;
  /**
   * Whether the player's chrome is showing, which the captions must clear.
   *
   * The transport sits in a band of fixed pixel height along the bottom, while
   * captions rest at a percentage of the stage — so how much of the two
   * overlap depends entirely on how tall the window is, and at most sizes they
   * already half clear each other. Lifting by the whole band therefore throws
   * the captions into the middle of the picture. What is wanted is the floor:
   * stay where you are, unless that is inside the band.
   */
  raised?: boolean;
  /** Injected so a test can step the loop by hand. */
  frames?: FrameSource;
}) {
  const [cue, setCue] = useState<PositionedCue | null>(null);

  useEffect(() => {
    if (!enabled) { setCue(null); return; }
    const loop = startFrameLoop(() => {
      const next = source()?.at(currentTime()) ?? null;
      // Compared inside the setter rather than against a captured value: an
      // unchanged caption must not re-render sixty times a second, and the
      // effect does not re-run to give us a fresh one to compare against.
      setCue((was) => (was?.text === next?.text && was?.region === next?.region ? was : next));
      return true;
    }, frames);
    return () => loop.stop();
  }, [source, enabled, currentTime, frames]);

  if (!enabled || !cue?.text) return null;

  /*
   * Colour, under a readability floor.
   *
   * A window the broadcaster marks transparent is drawn on the overlay's own
   * background instead. Captions are tuned for a living-room television and
   * are routinely unreadable over a bright browser page, and an unreadable
   * caption is worse than a plainly-styled one.
   */
  const style = cue.style;
  const background = style?.background && style.background !== "transparent"
    ? style.background
    : undefined;
  const textStyle: React.CSSProperties = {
    color: style?.foreground || undefined,
    fontStyle: style?.italic ? "italic" : undefined,
    textDecoration: style?.underline ? "underline" : undefined,
  };

  const box = (
    <div
      className={`${boxClasses} ${background ? "" : "bg-black/75"}`}
      style={{ ...textStyle, backgroundColor: background }}
    >
      {cue.text.split("\n").map((row, i) => (
        <p key={i}>{row}</p>
      ))}
    </div>
  );

  if (cue.region) {
    const placement = placeInSafeArea(
      cue.region.anchor, cue.region.xPercent, cue.region.yPercent,
    );
    // A window the broadcaster put down by the scrubber gets the same lift an
    // unpositioned caption does; one higher up is left where it was asked to
    // be, because the controls are nowhere near it.
    const nearBottom = cue.region.yPercent >= NEAR_BOTTOM_PERCENT;
    const lift = raised && nearBottom ? ` translateY(-${CHROME_BOTTOM_BAND_PX}px)` : "";

    return (
      <div
        className="absolute flex justify-center pointer-events-none px-4
                   transition-transform duration-300"
        style={{
          left: placement.left,
          top: placement.top,
          transform: `${placement.transform}${lift}`,
        }}
        data-raised={raised && nearBottom ? "true" : "false"}
        data-positioned="true"
        aria-live="polite"
      >
        {box}
      </div>
    );
  }

  return (
    <div
      className="absolute inset-x-0 flex justify-center pointer-events-none px-4
                 transition-[bottom] duration-300"
      style={{
        // `max` rather than a lift: on a short window the resting height sits
        // inside the transport band and the captions move up to its top edge;
        // on a tall one they are already above it and do not move at all. Both
        // are the same rule, and neither needs to know the window's height.
        bottom: raised
          ? `max(${RESTING_BOTTOM}, ${CHROME_BOTTOM_BAND_PX + CLEARANCE_PX}px)`
          : RESTING_BOTTOM,
      }}
      /* The decision, not the pixels: `max()` is the presentation of it, and
         jsdom's CSS parser drops the value outright, so this is also what a
         test can hold on to. */
      data-raised={raised ? "true" : "false"}
      data-positioned="false"
      aria-live="polite"
    >
      {box}
    </div>
  );
}
