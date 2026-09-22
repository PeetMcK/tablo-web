import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query from JS.
 *
 * Most responsive work here is done in CSS, with `sm:` classes and a pair of
 * elements that take turns being hidden — see the filter row. This hook is for
 * the cases where the two shapes cannot both be in the DOM at once: the topbar
 * search is one input, and rendering a second copy of it behind a breakpoint
 * would give the page two fields with the same placeholder and the same value
 * to keep in step.
 *
 * Guarded the way `theme.ts` guards its own `matchMedia` call: jsdom has no
 * implementation unless the test setup installs one, and the fallback of
 * `false` is the wide layout — which is what the existing tests render, and
 * what a browser too old for `matchMedia` should get.
 *
 * `useSyncExternalStore` rather than state plus an effect. The awkward part of
 * the hand-rolled version was that the query can flip between the first render
 * and the effect that subscribes, while the listener only fires on *later*
 * changes — so the effect had to re-read and set state, which is a render
 * caused by a render. Re-reading the snapshot around subscribing is what this
 * hook is for, and it does it without the extra pass.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return () => {};
    }
    const mql = window.matchMedia(query);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  // The third argument is the server snapshot, which is also what a browser
  // with no `matchMedia` gets: the wide layout.
  return useSyncExternalStore(subscribe, () => read(query), () => false);
}

function read(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}
