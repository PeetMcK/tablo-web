export type Tab = "live" | "grid" | "library";

export interface Route {
  tab: Tab;
  /** What is playing, if anything. */
  watch: { kind: "live"; id: string } | { kind: "recording"; id: number } | null;
}

const TABS: Tab[] = ["live", "grid", "library"];

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
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const tab = (TABS as string[]).includes(parts[0]) ? (parts[0] as Tab) : "live";

  if (parts[1] === "ch" && parts[2]) {
    return { tab, watch: { kind: "live", id: decodeURIComponent(parts[2]) } };
  }
  if (parts[1] === "rec" && parts[2] && /^\d+$/.test(parts[2])) {
    return { tab, watch: { kind: "recording", id: Number(parts[2]) } };
  }
  return { tab, watch: null };
}

export function writeRoute(route: Route): void {
  let hash = `#/${route.tab}`;
  if (route.watch?.kind === "live") {
    hash += `/ch/${encodeURIComponent(route.watch.id)}`;
  } else if (route.watch?.kind === "recording") {
    hash += `/rec/${route.watch.id}`;
  }
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash);
  }
}
