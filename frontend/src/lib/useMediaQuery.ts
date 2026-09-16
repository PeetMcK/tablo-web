import { useEffect, useState } from "react";

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
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    // Re-read on subscribe: the query can have flipped between the first
    // render and this effect, and the listener only fires on later changes.
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

function read(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}
