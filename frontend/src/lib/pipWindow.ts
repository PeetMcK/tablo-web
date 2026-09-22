/**
 * How big a pop-out window to ask for.
 *
 * Document Picture-in-Picture hands back whatever box it likes when asked
 * with no size: the one the viewer last dragged, whatever was playing then.
 * A 16:9 box remembered from a football game puts black bands above and
 * below a 4:3 programme, and the reverse pillarboxes it — the window has to
 * take its *shape* from the picture that is going into it, every time.
 *
 * Size is the part worth remembering, so it is kept as an area rather than a
 * box and spread back over the new shape. A viewer who dragged the last
 * pop-out large gets a large one again; it just arrives 4:3 instead of 16:9
 * when that is what is playing, which is the whole point.
 */
export const PIP_AREA_STORAGE_KEY = "tablo:pipArea";

/** 640×360 — the size a fresh pop-out opens at, before anyone drags one. */
export const PIP_AREA_DEFAULT = 640 * 360;

/**
 * Chrome refuses a pop-out below roughly a couple of hundred pixels wide and
 * clamps one that would cover the screen. Clamping here instead keeps the
 * *shape*: the browser clamps a single dimension and leaves the other, which
 * is letterboxing again by another route.
 */
const MIN_AREA = 240 * 135;
const MAX_SCREEN_FRACTION = 0.8;

function clampArea(area: number): number {
  if (!Number.isFinite(area) || area < MIN_AREA) return PIP_AREA_DEFAULT;
  return area;
}

/**
 * The box to request for a picture of this shape, or `null` when the picture
 * has no shape yet — nothing has decoded, so there is nothing to match and
 * the browser's own guess is the best available.
 *
 * `picture` is display size, not coded size: both sources hand that over
 * already (the canvas is sized by the deinterlacer with the sample aspect
 * applied, and `videoWidth` is aspect-corrected by definition), so no pixel
 * ratio survives to be applied here.
 */
export function fitPipWindow(
  picture: { width: number; height: number },
  limit: { width: number; height: number },
  area: number,
): { width: number; height: number } | null {
  const { width: pw, height: ph } = picture;
  if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) return null;

  const ratio = pw / ph;
  let width = Math.sqrt(clampArea(area) * ratio);
  let height = width / ratio;

  // One scale factor across both sides, so a window that will not fit the
  // screen shrinks rather than changing shape. A screen that reports nothing
  // — jsdom does, and a headless browser can — is no limit at all rather
  // than a limit of zero, which would ask for a window of no size.
  const room = Math.min(
    limit.width > 0 ? (limit.width * MAX_SCREEN_FRACTION) / width : 1,
    limit.height > 0 ? (limit.height * MAX_SCREEN_FRACTION) / height : 1,
    1,
  );
  if (room < 1) { width *= room; height *= room; }

  return { width: Math.round(width), height: Math.round(height) };
}

export function loadPipArea(): number {
  if (typeof window === "undefined") return PIP_AREA_DEFAULT;
  try {
    const stored = window.localStorage.getItem(PIP_AREA_STORAGE_KEY);
    if (stored === null) return PIP_AREA_DEFAULT;
    return clampArea(Number.parseFloat(stored));
  } catch {
    // Private mode and locked-down storage both throw on access.
    return PIP_AREA_DEFAULT;
  }
}

/**
 * Remember how large the viewer left the pop-out.
 *
 * Called with the window's inner size as it goes away, which is the content
 * box we asked for plus whatever dragging did to it — the browser's own title
 * bar is outside it and never accumulates into the stored figure.
 */
export function savePipArea(width: number, height: number): void {
  if (typeof window === "undefined") return;
  const area = width * height;
  if (!Number.isFinite(area) || area < MIN_AREA) return;
  try {
    window.localStorage.setItem(PIP_AREA_STORAGE_KEY, String(Math.round(area)));
  } catch {
    // Nothing to do — the size still holds for this session.
  }
}
