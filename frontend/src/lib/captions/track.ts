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
import { createReorderBuffer, REORDER_SECONDS } from "./reorder";
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
    // A cue with no length is never on screen, and one with no start is the
    // parser having been asked about a screen it has not begun timing. Both
    // become possible once we ask it what it is showing rather than waiting
    // to be told what it showed.
    if (!Number.isFinite(startSeconds) || !(endSeconds > startSeconds)) return;

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

  const pending = createReorderBuffer<CcPair>();

  const feed = (held: Array<{ seconds: number; item: CcPair }>) => {
    for (const { seconds, item } of held) {
      parser.addData(seconds, [item.a, item.b]);
    }
  };

  /**
   * Ask the parser what is on screen, rather than waiting to be told what was.
   *
   * The parser reports a caption when the displayed memory next changes,
   * handing over the screen that has just been replaced. The cue is correctly
   * dated but does not exist until the words have gone, which for a player
   * decoding a couple of seconds ahead of its own playhead is too late to
   * draw them: measured on a live CBS capture, cues arrived between two and
   * five seconds after the words went up.
   *
   * `cueSplitAtTime` emits exactly what is wanted - the displayed memory,
   * spanning its real start to now - because it exists to cut a long roll-up
   * in two. Cutting is the part we do not want, so the start it moves is put
   * straight back. Called every round the cue lengthens under an unchanged
   * start, and `CueCollector` folds it into the one already held.
   */
  const snapshot = (seconds: number | null) => {
    if (seconds === null) return;
    const starts = parser.channels.map((channel) => channel?.cueStartTime ?? null);
    parser.cueSplitAtTime(seconds);
    parser.channels.forEach((channel, i) => {
      if (channel) channel.cueStartTime = starts[i];
    });
  };

  return {
    add(seconds: number, pairs: readonly CcPair[]) {
      // Every picture, carrying pairs or not — see the 708 track, which has
      // the same arrangement for the same reason.
      pending.advance(seconds);
      for (const pair of pairs) {
        if (pair.field !== 0) continue;
        // Set on arrival rather than on release: it is what the CC button is
        // shown on, and holding it back would delay the button for no reason.
        seen = true;
        pending.add(seconds, pair);
      }
    },

    // CC1 only. CC2 is a second service on the same field — usually a second
    // language — and the parser needs somewhere to put it either way.
    drain() {
      feed(pending.take());
      snapshot(pending.settledThrough);
      return cc1.cues.splice(0);
    },

    flush() {
      const through = pending.settledThrough;
      feed(pending.takeAll());
      snapshot(through === null ? null : through + REORDER_SECONDS);
      return cc1.cues.splice(0);
    },

    get seen() { return seen; },

    reset() {
      pending.reset();
      parser.reset();
      cc1.reset();
      cc2.reset();
    },
  };
}
