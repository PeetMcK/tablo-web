export type Tab = "live" | "grid" | "library" | "schedule" | "search";

export interface Route {
  tab: Tab;
  /** What is playing, if anything. */
  watch: { kind: "live"; id: string } | { kind: "recording"; id: number } | null;
  /** The search text, when the search tab is showing. */
  q?: string;
}

const TABS: Tab[] = ["live", "grid", "library", "schedule", "search"];

/**
 * Names the UI uses that the route does not.
 *
 * The Guide tab is called "Guide" in the topbar, the menu and every
 * conversation about it, while its route segment is `grid`. Typing or
 * bookmarking the obvious `#/guide` landed silently on Live TV. Accepted on
 * the way in only - `writeRoute` still normalises to `grid`, so the address
 * bar self-corrects on the next write and there is still one canonical URL.
 */
const TAB_ALIASES: Record<string, Tab> = { guide: "grid" };

/**
 * Hash-based routing so a refresh lands where you were.
 *
 * The URL carries identity only — what is playing, not where the playhead is.
 * Resume positions live in localStorage (see lib/resume), so the address stays
 * stable and shareable instead of rewriting itself once a second.
 *
 * Written with `replaceState`, which deliberately does not fire `hashchange` —
 * that keeps a write from feeding back into a read and looping. The hash is
 * therefore read once on mount and only written thereafter.
 *
 *   #/live                 #/guide                #/library
 *   #/live/ch/S79600_007_01                       #/library/rec/80888
 */
export function parseRoute(hash: string = window.location.hash): Route {
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const named = parts[0];
  const tab = (TABS as string[]).includes(named)
    ? (named as Tab)
    : TAB_ALIASES[named] ?? "live";
  const q = queryPart
    ? new URLSearchParams(queryPart).get("q") ?? undefined
    : undefined;

  if (parts[1] === "ch" && parts[2]) {
    return { tab, watch: { kind: "live", id: decodeURIComponent(parts[2]) }, q };
  }
  if (parts[1] === "rec" && parts[2] && /^\d+$/.test(parts[2])) {
    return { tab, watch: { kind: "recording", id: Number(parts[2]) }, q };
  }
  return { tab, watch: null, q };
}

export function writeRoute(route: Route): void {
  let hash = `#/${route.tab}`;
  if (route.watch?.kind === "live") {
    hash += `/ch/${encodeURIComponent(route.watch.id)}`;
  } else if (route.watch?.kind === "recording") {
    hash += `/rec/${route.watch.id}`;
  }
  if (route.tab === "search" && route.q) {
    hash += `?q=${encodeURIComponent(route.q)}`;
  }
  if (window.location.hash === hash) return;

  // Opening a player is the one transition that earns a history entry. Without
  // it the browser's Back left the site entirely from a fullscreen video —
  // the gesture every viewer reaches for to get out of one. With it, Back pops
  // to the tab underneath and the player closes, which is what Escape does.
  //
  // Only on the way in. Closing, switching tabs and changing channel all keep
  // replacing, so Back stays a single step out of the video rather than a
  // walk back through everything that has been watched.
  const opening = parseRoute().watch === null && route.watch !== null;
  if (opening) window.history.pushState(null, "", hash);
  else window.history.replaceState(null, "", hash);
}

/**
 * Run `onBack` when a history entry is popped that has nothing playing.
 *
 * Paired with the push above: the entry Back lands on is the tab the player
 * was opened from, so seeing no `watch` in it is the signal to close.
 */
export function onRoutePop(onBack: (route: Route) => void): () => void {
  const handler = () => onBack(parseRoute());
  window.addEventListener("popstate", handler);
  return () => window.removeEventListener("popstate", handler);
}
