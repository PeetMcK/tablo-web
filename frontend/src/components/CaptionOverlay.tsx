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
 */

import { useEffect, useState } from "react";

import { DOCUMENT_FRAMES, startFrameLoop } from "../lib/playbackSurface";
import { CHROME_BOTTOM_BAND_PX } from "../lib/playerChrome";

/** Where captions sit when nothing is in their way — a television's height. */
const RESTING_BOTTOM = "12%";

/** A little air between the caption box and the top of the transport band. */
const CLEARANCE_PX = 8;
import type { CaptionSource, FrameSource } from "../lib/playbackSurface";

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
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) { setText(null); return; }
    const loop = startFrameLoop(() => {
      const next = source()?.at(currentTime())?.text ?? null;
      // Compared inside the setter rather than against a captured value: an
      // unchanged caption must not re-render sixty times a second, and the
      // effect does not re-run to give us a fresh one to compare against.
      setText((was) => (was === next ? was : next));
      return true;
    }, frames);
    return () => loop.stop();
  }, [source, enabled, currentTime, frames]);

  if (!enabled || !text) return null;

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
      aria-live="polite"
    >
      {/* Black box behind white text, which is what 608 specifies and what a
          television draws. Sized against the viewport rather than fixed: the
          player runs from a phone to a fullscreen desktop. */}
      <div className="max-w-[80%] rounded px-3 py-1 bg-black/75 text-white
                      text-base sm:text-lg md:text-xl font-medium leading-snug text-center">
        {text.split("\n").map((row, i) => (
          <p key={i}>{row}</p>
        ))}
      </div>
    </div>
  );
}
