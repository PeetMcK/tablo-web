/**
 * A scrap of text that outlives a reload, in this browser.
 *
 * For choices that belong to where one pair of eyes is looking right now,
 * rather than to how a person reads a page. Those belong on the server (see
 * `usePref`) so they follow the viewer between machines; this does not — a
 * filter typed here has nothing to say to the same library opened elsewhere.
 *
 * Every access is guarded: private mode and browsers set to block site data
 * throw on both `getItem` and `setItem`, and losing a filter box is not worth
 * a blank page. An empty value is removed rather than stored, so the key does
 * not outlive its usefulness.
 */
import { useCallback, useState } from "react";

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function useStoredText(key: string): [string, (next: string) => void] {
  // Read once, at mount: this is the only moment the stored value is news.
  // Reading on every render would also fight the field a viewer is typing in.
  const [value, setValue] = useState(() => read(key));

  const set = useCallback((next: string) => {
    setValue(next);
    try {
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
    } catch {
      // The filter still works for this visit; it just will not be here on
      // the next one.
    }
  }, [key]);

  return [value, set];
}
