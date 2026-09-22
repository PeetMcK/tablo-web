/**
 * A layout choice that outlives the visit.
 *
 * Reads the stored preferences once — one request for all of them, held in the
 * query cache — and writes back whichever this hook owns. Server-side rather
 * than `localStorage` because a preference tied to one browser's site data is
 * gone on the next machine and cleared with the cookies.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/tablo";

const KEY = ["prefs"];

export function usePref<T extends string>(
  name: string, fallback: T, allowed: readonly T[],
): [T, (next: T) => void] {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => api.prefs(),
    // These change only when someone changes them, and then this component is
    // the one doing it. Refetching on focus would replace a choice made a
    // second ago with the same value, at the cost of a request per tab switch.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const stored = data?.[name];
  // Guarded rather than trusted: the server refuses values outside its own
  // allow-list, but a page that has since dropped an option would otherwise
  // render a layout it no longer has.
  const value = allowed.includes(stored as T) ? (stored as T) : fallback;

  const save = useMutation({
    mutationFn: ({ next }: { next: T }) => api.putPref(name, next),
  });

  const set = useCallback((next: T) => {
    // Anything still in flight is cancelled first: a read that started before
    // this choice was made would land after it and put the old layout back.
    // The window is small and real — the first paint of the page is exactly
    // when someone reaches for the menu.
    void qc.cancelQueries({ queryKey: KEY });
    // Then the cache, synchronously, so the page rearranges in the same frame
    // the menu item was clicked. Waiting on the round trip would leave a menu
    // reporting the new choice above a page still in the old one.
    //
    // Deliberately never rolled back: the layout is already on screen, and
    // undoing it under the viewer's hands would be a stranger answer than a
    // preference that quietly failed to persist. The next load simply opens on
    // what the server does hold.
    qc.setQueryData<Record<string, string>>(KEY, prev => ({ ...prev, [name]: next }));
    save.mutate({ next });
  }, [qc, name, save]);

  return [value, set];
}
