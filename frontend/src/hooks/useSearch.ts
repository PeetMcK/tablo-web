import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SearchKind, type SearchResponse } from "../api/tablo";

/** Below this a query matches so much that the results are noise. */
export const MIN_QUERY = 2;

const DEBOUNCE_MS = 180;

/**
 * The one thing that talks to the search API.
 *
 * Three surfaces render these results - a dropdown, a palette and a page - and
 * routing them all through here is what stops them disagreeing about ordering,
 * loading state or what counts as too short to search.
 *
 * Debounced rather than fired per keystroke: the server ranks across the whole
 * index, and typing "broncos" would otherwise be seven ranked queries of which
 * six are discarded.
 */
export function useSearch(
  query: string,
  opts: { limit?: number; kinds?: SearchKind[] } = {},
) {
  // Starts empty rather than at `query` so the very first render doesn't
  // bypass the debounce with whatever the prop happens to be at mount.
  const [settled, setSettled] = useState("");
  const { limit, kinds } = opts;

  useEffect(() => {
    const t = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const trimmed = settled.trim();
  const enabled = trimmed.length >= MIN_QUERY;

  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ["search", trimmed, limit, kinds?.join(",")],
    queryFn: () => api.search(trimmed, { limit, kinds }),
    enabled,
    staleTime: 30_000,
  });

  return { data: enabled ? data : undefined, isFetching: enabled && isFetching };
}
