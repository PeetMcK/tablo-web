/**
 * The diagnostic that draws both caption standards at once.
 *
 * Off unless asked for by `cc=compare` in the URL. Either side of the hash
 * works, because both are places a person would reasonably put it:
 *
 *   http://host/?cc=compare#/live/ch/S34654_008_01
 *   http://host/#/live/ch/S34654_008_01?cc=compare
 *
 * The app routes on the hash, so the second reads as the query of the page
 * being looked at and is the one that comes to hand - which is why looking
 * only at `location.search` meant the flag silently did nothing. A diagnostic
 * that has to be spelled exactly right to work is a diagnostic that gets
 * blamed for the bug it was meant to find.
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

/** The query string of a hash route, if it carries one. */
function hashQuery(hash: string): string {
  const at = hash.indexOf("?");
  return at < 0 ? "" : hash.slice(at + 1);
}

function asks(query: string): boolean {
  if (!query) return false;
  return new URLSearchParams(query).get(CAPTION_COMPARE_PARAM) === CAPTION_COMPARE_VALUE;
}

export function captionCompareRequested(
  search: string = typeof location === "undefined" ? "" : location.search,
  hash: string = typeof location === "undefined" ? "" : location.hash,
): boolean {
  return asks(search) || asks(hashQuery(hash));
}
