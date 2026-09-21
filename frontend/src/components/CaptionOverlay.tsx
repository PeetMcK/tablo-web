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
import type { CaptionSource, FrameSource } from "../lib/playbackSurface";

export function CaptionOverlay({
  source, enabled, currentTime, frames = DOCUMENT_FRAMES,
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
      className="absolute inset-x-0 bottom-[12%] flex justify-center pointer-events-none px-4"
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
