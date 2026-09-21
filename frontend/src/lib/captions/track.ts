/**
 * Byte pairs in, cues out.
 *
 * EIA-608 is a command stream rather than a list of captions: the decoder
 * carries screen state across the whole broadcast, so what a viewer sees at
 * any moment depends on every pair that came before. That is why `reset`
 * exists and why a seek must call it — without it, captions resume mid
 * sentence from wherever playback used to be.
 */

import Cea608Parser, { type CaptionScreen, type CueSink } from "./cea608";
import type { CaptionCue, CcPair } from "./types";

/**
 * Records what the parser produces.
 *
 * The parser revises a cue in place as more of it arrives, calling `newCue`
 * repeatedly with the same start time and a longer end — so a repeat of a
 * start we are still holding replaces it rather than adding a second cue.
 * `dispatchCue` is left empty because by the time the parser calls it the cue
 * is already recorded; upstream's version exists to push into a hls.js
 * timeline controller, which we have none of.
 */
class CueCollector implements CueSink {
  readonly cues: CaptionCue[] = [];

  newCue(startSeconds: number, endSeconds: number, screen: CaptionScreen): void {
    const text = screen.getDisplayText().trim();
    // An empty screen is the parser saying a caption has been cleared, which
    // the overlay achieves by finding no cue rather than by drawing nothing.
    if (!text) return;

    const last = this.cues[this.cues.length - 1];
    if (last && last.startSeconds === startSeconds) {
      last.endSeconds = endSeconds;
      last.text = text;
      return;
    }
    this.cues.push({ startSeconds, endSeconds, text });
  }

  dispatchCue(): void {}

  reset(): void {
    this.cues.length = 0;
  }
}

/**
 * How far behind the newest picture the parser is fed from.
 *
 * The decoder hands packets over in decode order, a read round at a time, and
 * MPEG-2 reorders for B-frames — so a picture that belongs earlier in display
 * order routinely arrives in the *next* round. Sorting within a round is not
 * enough, and 608 is a command stream: bytes in the wrong order spell the
 * wrong words. Measured against a live broadcast, "[cheers, applause]" came
 * out as "[cheerpps, alause]".
 *
 * So pairs wait until a picture half a second newer has arrived, which is well
 * past any display reordering distance — a handful of frames — and costs
 * nothing visible, because the decoder already runs seconds ahead of the
 * playhead.
 */
export const REORDER_SECONDS = 0.5;

export interface CaptionTrack {
  /**
   * Offer one picture's pairs, at that picture's presentation time.
   *
   * Offered rather than fed: they are held until `drain` can be sure nothing
   * earlier is still to come.
   */
  add(seconds: number, pairs: readonly CcPair[]): void;
  /** Cues completed since the last call. Each is handed out once. */
  drain(): CaptionCue[];
  /**
   * Feed everything held, then drain. For end of stream, where there is no
   * later picture coming to settle the order.
   */
  flush(): CaptionCue[];
  /**
   * Whether this stream has ever carried captions.
   *
   * What the player's CC button is shown on, which is why it survives a
   * reset: a seek does not make a captioned channel uncaptioned.
   */
  readonly seen: boolean;
  /** Forget the screen. For a seek or a discontinuity. */
  reset(): void;
}

export function createCaptionTrack(): CaptionTrack {
  const cc1 = new CueCollector();
  const cc2 = new CueCollector();
  // Field 1, which carries CC1 and CC2. Field 2 is CC3, CC4 and XDS; the
  // extractor keeps its pairs because they cost nothing to read, but nothing
  // decodes them in this pass.
  const parser = new Cea608Parser(1, cc1, cc2);
  let seen = false;

  /** Pairs waiting for their order to be settled, in arrival order. */
  let pending: Array<{ seconds: number; pair: CcPair }> = [];
  /** The newest picture time offered, which is what the wait is measured from. */
  let newest = Number.NEGATIVE_INFINITY;

  /** Feed everything at or before `upTo`, oldest first, and keep the rest. */
  const feedThrough = (upTo: number) => {
    if (!pending.length) return;
    // Stable, so pairs from the same picture keep the order the encoder wrote
    // them in — within a picture the sequence is already correct.
    pending.sort((a, b) => a.seconds - b.seconds);
    let i = 0;
    while (i < pending.length && pending[i].seconds <= upTo) {
      const { seconds, pair } = pending[i];
      parser.addData(seconds, [pair.a, pair.b]);
      i++;
    }
    pending = i === pending.length ? [] : pending.slice(i);
  };

  return {
    add(seconds: number, pairs: readonly CcPair[]) {
      for (const pair of pairs) {
        if (pair.field !== 0) continue;
        // Set on arrival rather than on release: it is what the CC button is
        // shown on, and holding it back would delay the button for no reason.
        seen = true;
        pending.push({ seconds, pair });
        if (seconds > newest) newest = seconds;
      }
    },

    // CC1 only. CC2 is a second service on the same field — usually a second
    // language — and the parser needs somewhere to put it either way.
    drain() {
      feedThrough(newest - REORDER_SECONDS);
      return cc1.cues.splice(0);
    },

    flush() {
      feedThrough(Number.POSITIVE_INFINITY);
      return cc1.cues.splice(0);
    },

    get seen() { return seen; },

    reset() {
      pending = [];
      newest = Number.NEGATIVE_INFINITY;
      parser.reset();
      cc1.reset();
      cc2.reset();
    },
  };
}
