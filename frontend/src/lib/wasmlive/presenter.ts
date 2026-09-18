/**
 * Which field to draw, and when.
 *
 * An interlaced frame carries two moments in time, half a frame apart, so it
 * becomes two presentations: 1080i29.97 in, 59.94 field presentations out.
 * That cadence is what makes broadcast motion look right, and it is what the
 * current `<video>` path gets from `bwdif=send_field` on the server.
 *
 * Drawing is injected. The GL work lives in `deinterlace.ts`; keeping it
 * behind `upload` and `draw` means the scheduling — the part with decisions in
 * it — is testable without a GPU.
 */

import { admit, selectFrame } from "./frameQueue";
import type { DecodedVideoFrame, FieldParity } from "./types";

export interface FieldPresentation {
  ptsSeconds: number;
  parity: FieldParity;
  /** False for progressive frames, which the shader passes straight through. */
  interlaced: boolean;
  /** The frame these fields came from, so the renderer can find its planes. */
  source: DecodedVideoFrame;
}

export interface PresenterDeps {
  /** The audio clock, in media seconds. */
  /**
   * The audio clock, in media seconds, or null before it has started.
   *
   * Null is not zero. A suspended AudioContext renders no samples, so on a
   * page opened without a user gesture the clock has no value at all — and
   * collapsing that to zero made every decoded field look like the distant
   * future, so nothing was ever due and the viewer got a black frame.
   */
  now(): number | null;
  /** Put a frame's planes on the GPU. Called once per frame, not per field. */
  upload(frame: DecodedVideoFrame): void;
  /** Draw one field from whatever was last uploaded. */
  draw(entry: FieldPresentation): void;
  /** Wall clock, for measuring the gap between ticks. */
  nowMs?(): number;
}

export interface Presenter {
  offer(frame: DecodedVideoFrame): void;
  tick(): void;
  readonly newestPts: number | null;
  /** The oldest field still queued, which is the next one due. */
  readonly oldestPts: number | null;
  readonly presentedCount: number;
  /** Fields refused because the queue was full. Each one is a hole. */
  readonly droppedCount: number;
  /**
   * Fields passed over because a newer one was also due.
   *
   * Not a hole: the picture stayed on the clock, which is the whole point of
   * showing the newest due field rather than the oldest. But it is the
   * difference between `presentedCount` and the rate fields were offered at,
   * and without it `presentedCount` — which counts ticks that drew, not fields
   * consumed — reads as a field rate it was never measuring.
   */
  readonly skippedCount: number;
  /** Calls to `tick()`: how often there was a chance to draw at all. */
  readonly tickCount: number;
  /** Milliseconds between the last two ticks — the gap since a chance to draw. */
  readonly msSinceTick: number;
  /**
   * Milliseconds the picture has held while fields were still in hand.
   *
   * A hole in the middle of a segment does not empty the queue — it leaves it
   * full of fields whose moment has not come — so the session's stall edge,
   * which fires on an empty queue, never sees it. The clock runs, nothing is
   * due, the picture holds, and the only thing that eventually notices is the
   * six-second watchdog. That is the shape of a short stutter you can hear and
   * never find.
   *
   * Zero when the queue is empty: that is starvation, which already has a name.
   * Zero when the clock is stopped: that is a pause waiting on a tap.
   */
  readonly nothingDueMs: number;
  readonly queued: number;
  destroy(): void;
}

export function createPresenter(deps: PresenterDeps): Presenter {
  let queue: FieldPresentation[] = [];
  let presented = 0;
  let dropped = 0;
  let skipped = 0;
  let ticks = 0;
  let lastTickMs: number | null = null;
  let sinceTick = 0;
  /** The field drawn as a still while the clock is stopped, so it is drawn once. */
  let stillShown: FieldPresentation | null = null;
  /** Wall clock at the last draw, so a picture that stops moving can be timed. */
  let lastDrawMs: number | null = null;
  let heldMs = 0;
  /** What is currently on the GPU, so two fields of one frame upload once. */
  let uploaded: DecodedVideoFrame | null = null;

  const fieldsOf = (frame: DecodedVideoFrame): FieldPresentation[] => {
    if (!frame.interlaced) {
      return [{ ptsSeconds: frame.ptsSeconds, parity: "top", interlaced: false, source: frame }];
    }
    const [first, second]: FieldParity[] = frame.topFieldFirst
      ? ["top", "bottom"]
      : ["bottom", "top"];
    return [
      { ptsSeconds: frame.ptsSeconds, parity: first, interlaced: true, source: frame },
      {
        ptsSeconds: frame.ptsSeconds + frame.durationSeconds / 2,
        parity: second,
        interlaced: true,
        source: frame,
      },
    ];
  };

  return {
    offer(frame: DecodedVideoFrame) {
      for (const field of fieldsOf(frame)) {
        const { queue: next, dropped: lost } = admit(queue, field);
        queue = next;
        // Counted rather than discarded silently. A full queue refuses the
        // field being offered, and a refused field is a hole in the timeline
        // rather than merely a short queue — but nothing has ever counted
        // them, so a session that dropped thousands looked identical to one
        // that dropped none.
        dropped += lost.length;
      }
    },

    tick() {
      ticks++;

      // The gap since the last tick, which is the gap since the last chance to
      // draw. Animation frames stop entirely in a hidden or fully occluded
      // window, and while they are stopped the queue fills and every further
      // field is refused — so the size of this gap is the difference between
      // "the decoder produced nothing" and "nobody was asking for anything".
      const at = deps.nowMs?.() ?? 0;
      sinceTick = lastTickMs === null ? 0 : at - lastTickMs;
      lastTickMs = at;

      const clock = deps.now();

      // No clock yet: show the picture rather than nothing.
      //
      // Chrome will not start an AudioContext without user activation, so a
      // refreshed page waits with a stopped clock. The fields are decoded and
      // queued — they simply have timestamps the clock has not reached. Drawing
      // the oldest of them puts the frame at the resume point on screen, so the
      // player looks paused rather than broken, and leaves it queued so that
      // ordinary presentation still begins there once the sound starts.
      if (clock === null) {
        // A stopped clock is a pause, not a hole: the picture holds because
        // there is no time to be due at, and it is waiting on a tap rather than
        // on the decoder.
        heldMs = 0;
        lastDrawMs = at;
        const first = queue[0];
        if (!first || stillShown === first) return;
        if (uploaded !== first.source) {
          deps.upload(first.source);
          uploaded = first.source;
        }
        deps.draw(first);
        stillShown = first;
        return;
      }

      const { present, drop, keep } = selectFrame(queue, clock);
      queue = keep;
      // The third way a field leaves the queue, and the one nothing counted.
      // Drawn and refused each had a number; passed over did not, so the three
      // exits never added up to what was offered and no amount of arguing about
      // `presentedCount` could have settled what it meant.
      skipped += drop.length;
      if (!present) {
        // Held only when there is something in hand to draw. An empty queue is
        // starvation, and it is reported elsewhere under its own name.
        heldMs = queue.length > 0 && lastDrawMs !== null ? at - lastDrawMs : 0;
        return;
      }

      if (uploaded !== present.source) {
        deps.upload(present.source);
        uploaded = present.source;
      }
      deps.draw(present);
      presented++;
      lastDrawMs = at;
      heldMs = 0;
    },

    get newestPts() {
      return queue.length ? queue[queue.length - 1].ptsSeconds : null;
    },

    get oldestPts() {
      return queue.length ? queue[0].ptsSeconds : null;
    },

    get presentedCount() {
      return presented;
    },

    /** Fields refused because the queue was full. Each one is a hole. */
    get droppedCount() {
      return dropped;
    },

    /** Fields passed over because a newer one was also due. */
    get skippedCount() {
      return skipped;
    },

    /** Calls to `tick()`: how often there was a chance to draw at all. */
    get tickCount() {
      return ticks;
    },

    /** Milliseconds between the last two ticks: how long since a chance to draw. */
    get msSinceTick() {
      return sinceTick;
    },

    /** How long the picture has held with fields still queued. */
    get nothingDueMs() {
      return heldMs;
    },

    get queued() {
      return queue.length;
    },

    destroy() {
      queue = [];
      uploaded = null;
    },
  };
}
