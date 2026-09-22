/**
 * What the topbar's one box remembers between visits: which job it is doing,
 * and what is typed in it.
 *
 * Both in this browser rather than on the server, and for the same reason the
 * Library's filter was: a preference for how a page is laid out should follow
 * a viewer between machines, where the thing they are looking for this minute
 * should not. See `lib/usePref` for the other half of that split.
 *
 * One string for both modes, not one each. Flipping the switch is meant to
 * reinterpret what is already typed — that IS the switch — and a mode that
 * swapped in something typed an hour ago and forgotten would be a different,
 * worse control.
 *
 * Every access is guarded: private mode and browsers set to block site data
 * throw on both `getItem` and `setItem`, and a filter box is not worth a blank
 * page. An empty value is removed rather than stored, so the key does not
 * outlive its usefulness.
 */
import { useCallback, useState } from "react";

export type TopbarMode = "filter" | "search";

const MODE_KEY = "tablo:topbar.mode";
const QUERY_KEY = "tablo:topbar.query";
/** The Library's own box, back when there were two. Read once, then dropped. */
const LEGACY_QUERY_KEY = "tablo:library.filter";

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // The box still works for this visit; it just will not be here on the next.
  }
}

/**
 * The stored text, adopting the Library's old key if that is all there is.
 *
 * Unconditional rather than a fallback, so the dead key goes even on a visit
 * whose text came from a deep link — the same one-shot migration `lib/resume`
 * does for its own legacy key.
 */
function readQuery(): string {
  const current = read(QUERY_KEY);
  const legacy = read(LEGACY_QUERY_KEY);
  if (legacy) {
    try {
      localStorage.removeItem(LEGACY_QUERY_KEY);
    } catch {
      // Then it stays, and is read again next time. Harmless either way.
    }
  }
  return current || legacy;
}

export function useTopbarMode(): [TopbarMode, (next: TopbarMode) => void] {
  // Guarded rather than trusted: a key left by an older build would otherwise
  // put the box in a mode this one has no behaviour for.
  const [mode, setStored] = useState<TopbarMode>(
    () => (read(MODE_KEY) === "search" ? "search" : "filter"),
  );

  const set = useCallback((next: TopbarMode) => {
    setStored(next);
    write(MODE_KEY, next);
  }, []);

  return [mode, set];
}

export function useTopbarQuery(seed: string): [string, (next: string) => void] {
  // Read once, at mount: this is the only moment the stored value is news, and
  // reading on every render would fight the field a viewer is typing in.
  const [query, setStored] = useState(() => {
    // Always read, even when the seed wins, because reading is what retires
    // the legacy key.
    const stored = readQuery();
    return seed || stored;
  });

  const set = useCallback((next: string) => {
    setStored(next);
    write(QUERY_KEY, next);
  }, []);

  return [query, set];
}
