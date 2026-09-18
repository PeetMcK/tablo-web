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
  now(): number;
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
  /** Milliseconds between the last two ticks — the gap since a chance to draw. */
  readonly msSinceTick: number;
  readonly queued: number;
  destroy(): void;
}

export function createPresenter(deps: PresenterDeps): Presenter {
  let queue: FieldPresentation[] = [];
  let presented = 0;
  let dropped = 0;
  let lastTickMs: number | null = null;
  let sinceTick = 0;
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
      // The gap since the last tick, which is the gap since the last chance to
      // draw. Animation frames stop entirely in a hidden or fully occluded
      // window, and while they are stopped the queue fills and every further
      // field is refused — so the size of this gap is the difference between
      // "the decoder produced nothing" and "nobody was asking for anything".
      const at = deps.nowMs?.() ?? 0;
      sinceTick = lastTickMs === null ? 0 : at - lastTickMs;
      lastTickMs = at;

      const { present, keep } = selectFrame(queue, deps.now());
      queue = keep;
      if (!present) return;

      if (uploaded !== present.source) {
        deps.upload(present.source);
        uploaded = present.source;
      }
      deps.draw(present);
      presented++;
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

    /** Milliseconds between the last two ticks: how long since a chance to draw. */
    get msSinceTick() {
      return sinceTick;
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
