/**
 * The diagnostic that draws both caption standards at once.
 *
 * Off unless asked for by `?cc=compare` in the URL - before the hash, since
 * the app routes on the hash: `http://host/?cc=compare#/library/rec/123`.
 *
 * It exists because the two standards fail differently and the difference is
 * easier to see than to argue about. 708 carries the broadcaster's windows
 * and 608 carries a single screen, so where 708 drops or misplaces something
 * the 608 rendering of the same moment is sitting underneath it to compare
 * against. Not a viewer feature: it double-draws the picture's captions on
 * purpose and says so on screen.
 */

export const CAPTION_COMPARE_PARAM = "cc";
export const CAPTION_COMPARE_VALUE = "compare";

export function captionCompareRequested(
  search: string = typeof location === "undefined" ? "" : location.search,
): boolean {
  return new URLSearchParams(search).get(CAPTION_COMPARE_PARAM) === CAPTION_COMPARE_VALUE;
}
