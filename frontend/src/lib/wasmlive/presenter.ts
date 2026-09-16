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
}

export interface Presenter {
  offer(frame: DecodedVideoFrame): void;
  tick(): void;
  readonly newestPts: number | null;
  readonly presentedCount: number;
  readonly queued: number;
  destroy(): void;
}

export function createPresenter(deps: PresenterDeps): Presenter {
  let queue: FieldPresentation[] = [];
  let presented = 0;
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
        queue = admit(queue, field).queue;
      }
    },

    tick() {
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

    get presentedCount() {
      return presented;
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
