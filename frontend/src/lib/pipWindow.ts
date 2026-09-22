/**
 * Putting a pop-out back to the default size, on request.
 *
 * Three facts about the API, each of them measured here rather than assumed,
 * and between them they leave exactly one thing that works.
 *
 * Position is not ours at all: `requestWindow` takes no coordinates and
 * `moveTo` is refused.
 *
 * The size passed to `requestWindow` is a suggestion. The default
 * `preferInitialWindowPlacement: false` reopens the window at the position
 * *and size* it was last closed at, so those numbers are used only when the
 * browser has nothing remembered. Passing `true` does honour them — and
 * throws the remembered position away to do it, which pinned the pop-out to
 * the bottom-right corner every time and is why it is never passed.
 *
 * `resizeTo` works, but only from a gesture inside the pop-out itself:
 * "NotAllowedError: Failed to execute 'resizeTo': requires user activation in
 * document picture-in-picture". Not the click that opened the window — that
 * activation belongs to the tab, and the new window has none of its own.
 *
 * So the browser places and sizes every pop-out from its own memory, and the
 * one lever left is a right-click on the close button *in the pop-out*, which
 * resizes it to the default box in place. A resize holds the top-left corner,
 * so the window does not move; and the box it is left at is what the browser
 * remembers for next time, which makes one correction permanent.
 *
 * What is deliberately not here: correcting the shape automatically. It was
 * built and taken out again — the only activation available is the viewer's
 * first click in the window, and a picture that resizes itself under the hand
 * of someone reaching for pause is worse than the letterboxing it fixes.
 */

/** The box asked for when the browser has no window remembered at all. */
export const PIP_BOX_DEFAULT = { width: 480, height: 270 };

const MAX_SCREEN_FRACTION = 0.8;

export interface Box { width: number; height: number }

/** The default box at this picture's shape — what Reset PiP resizes to. */
export function defaultBoxFor(picture: Box, limit: Box): Box {
  const ratio = picture.width / picture.height;
  const area = PIP_BOX_DEFAULT.width * PIP_BOX_DEFAULT.height;
  if (!Number.isFinite(ratio) || ratio <= 0) return fit(PIP_BOX_DEFAULT, limit);
  const width = Math.sqrt(area * ratio);
  return fit({ width, height: width / ratio }, limit);
}

/** Shrink to fit the screen with one factor, so the shape is untouched. */
function fit(box: Box, limit: Box): Box {
  // A screen that reports nothing — jsdom does, and a headless browser can —
  // is no limit at all rather than a limit of zero, which would resize a
  // window to nothing.
  const room = Math.min(
    limit.width > 0 ? (limit.width * MAX_SCREEN_FRACTION) / box.width : 1,
    limit.height > 0 ? (limit.height * MAX_SCREEN_FRACTION) / box.height : 1,
    1,
  );
  return { width: Math.round(box.width * room), height: Math.round(box.height * room) };
}

/**
 * Resize a pop-out to a content box of this size, in place.
 *
 * `resizeTo` speaks in outer size, and the window it is given has a title bar
 * of the browser's own above the content — so the difference the window
 * itself reports is added back, rather than a guess at how tall that bar is.
 *
 * Returns whether it appears to have taken. It can legitimately fail: the
 * method needs a user activation, and a browser is free to clamp the result
 * or refuse outright, which is why nothing downstream depends on it.
 */
export function resizePipWindow(w: Window, box: Box): { ok: boolean; why?: string } {
  try {
    const chromeWidth = Math.max(0, w.outerWidth - w.innerWidth);
    const chromeHeight = Math.max(0, w.outerHeight - w.innerHeight);
    w.resizeTo(box.width + chromeWidth, box.height + chromeHeight);
    // Taking the call is not the same as taking the size: a browser is free
    // to clamp it, and one that clamps to its own minimum leaves the window
    // the wrong shape while having thrown nothing at all.
    const got = { width: w.innerWidth, height: w.innerHeight };
    const near = Math.abs(got.width - box.width) <= 2 && Math.abs(got.height - box.height) <= 2;
    return near ? { ok: true } : { ok: false, why: `clamped to ${got.width}x${got.height}` };
  } catch (e) {
    // Refused — `resizeTo` wants a user activation, and the click that opened
    // the window spent it. The window keeps the shape the browser gave it.
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}
