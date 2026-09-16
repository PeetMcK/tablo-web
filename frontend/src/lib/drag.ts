/**
 * The arithmetic behind dragging the guide, kept apart from the component.
 *
 * All of it is decisions about a list of pointer positions, so it can be
 * tested directly — which matters here, because the alternative is asserting
 * scroll offsets under jsdom, where there is no layout and every element
 * measures zero. The prototype these rules came from is at
 * `docs/prototypes/2026-09-16-guide-scroll-bench.html`.
 */

export interface DragSample {
  /** `performance.now()` when the pointer was here. */
  t: number;
  x: number;
  y: number;
}

/**
 * How much of the recent past decides a throw, in ms.
 *
 * Measuring the whole gesture reads a slow reposition ending in a flick as
 * barely moving. It also breaks whenever pointer events arrive sparsely — on
 * a busy main thread the samples spread out, and an average over all of them
 * collapses toward zero, so every throw dies silently.
 */
export const THROW_WINDOW_MS = 90;

/** Below this (px/ms) a release is a placement, not a throw. */
export const MIN_THROW = 0.05;

/** Velocity retained per millisecond of glide: 0.995^600 leaves about 5%. */
export const GLIDE_DECAY = 0.995;

/** Glide ends once it is slower than this, in px/ms. */
export const GLIDE_STOP = 0.02;

/** Travel that separates a click on a programme from a drag of the guide. */
export const DRAG_SLOP = 4;

/**
 * How much further the date band moves the guide than the hour row.
 *
 * A band is a whole day, so a throw across it should cover days; the hour row
 * is for nudging around an evening and stays one-to-one.
 */
export const DATE_GAIN = 4;

/**
 * Speed of a throw in px/ms, or null when the release was not one.
 *
 * `now` is passed rather than read so the "did the pointer rest before
 * letting go" test can be exercised. That test is separate from the sample
 * window on purpose: the gap between the last two moves says nothing about
 * the pause that followed them, and a drag that ended in a pause is a
 * placement — flinging it would move the guide away from where it was just
 * carefully put.
 */
export function throwVelocity(
  samples: DragSample[],
  now: number,
): { x: number; y: number } | null {
  if (samples.length < 2) return null;

  const last = samples[samples.length - 1];
  if (now - last.t > THROW_WINDOW_MS) return null;

  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > THROW_WINDOW_MS) break;
    first = samples[i];
  }

  const span = last.t - first.t;
  if (span <= 0) return null;

  return { x: (last.x - first.x) / span, y: (last.y - first.y) / span };
}

/**
 * Which way a drag committed, from the travel at the moment it began.
 *
 * Settled once and held for the whole gesture. Re-deciding per move would
 * flip the lock under the hand on any stroke that wandered, which is worse
 * than either axis. Ties go to time, the axis the guide is mostly about.
 */
export function dominantAxis(dx: number, dy: number): "x" | "y" {
  return Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
}

/** Whether the viewer has asked for less movement. Read live, not at import. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
