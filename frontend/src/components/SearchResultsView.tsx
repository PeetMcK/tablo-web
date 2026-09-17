import { useState } from "react";
import { useSearch, MIN_QUERY } from "../hooks/useSearch";
import { SearchResultRow } from "./SearchResultRow";
import type { SearchItem, SearchKind } from "../api/tablo";

const CHIPS: { id: SearchKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "recording", label: "Recordings" },
  { id: "airing", label: "Guide" },
  { id: "channel", label: "Channels" },
];

/**
 * The third search surface — a full page rather than a glance.
 *
 * Unlike the dropdown and palette, this one owns per-kind filtering (the
 * chips below) and always reports how far back the guide can be trusted:
 * without that, an empty result here reads identically whether the show
 * never aired or the sync simply never saw that far back — which is the
 * whole reason this feature exists.
 */
export function SearchResultsView({
  query, onQueryChange, onActivate,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onActivate: (item: SearchItem) => void;
}) {
  const [chip, setChip] = useState<SearchKind | "all">("all");
  const { data, isFetching } = useSearch(query, {
    limit: 50,
    kinds: chip === "all" ? undefined : [chip],
  });

  const since = data?.coverage.since;
  // Below the server's own minimum, useSearch never fetches at all — so
  // "no data yet" here means "not searched", not "searched and found
  // nothing". That distinction is what keeps the page from reading as
  // broken the moment it opens.
  const notSearchedYet = query.trim().length < MIN_QUERY;

  return (
    <div className="flex flex-col gap-6">
      {/* Same fill, hairline and focus ring as the topbar field in ChannelGrid:
          the two are the same control at two sizes, and on this route they sit
          one directly above the other. */}
      <input
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder="Search channels, guide and recordings..."
        className="w-full px-4 py-3 rounded-xl bg-fill-soft border border-border-subtle text-sm
                   placeholder-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent
                   focus:bg-fill transition"
      />

      <div className="flex gap-2 flex-wrap">
        {CHIPS.map(c => (
          <button
            key={c.id}
            onClick={() => setChip(c.id)}
            className={`px-4 py-1.5 rounded-full text-sm font-bold transition
                        ${chip === c.id ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Coverage, so an empty result cannot be mistaken for "it never aired". */}
      {since && (
        <p className="text-[11px] text-fg-muted">
          Guide history since {new Date(since).toLocaleDateString()}
        </p>
      )}

      {notSearchedYet && (
        <p className="text-sm text-fg-muted">
          Search across channels, the guide and your recordings.
        </p>
      )}

      {!notSearchedYet && isFetching && !data && (
        <p className="text-xs text-fg-muted">Searching...</p>
      )}

      {!notSearchedYet && data?.groups.length === 0 && (
        <p className="text-sm text-fg-muted">No matches for "{data.query}"</p>
      )}

      {data && data.groups.length > 0 && (
        <div role="listbox" aria-label="Search results" className="flex flex-col gap-6">
          {data.groups.map(group => (
            <section key={group.kind}>
              <h2 className="text-[10px] font-black uppercase tracking-widest text-fg-muted mb-2">
                {CHIPS.find(c => c.id === group.kind)?.label ?? group.kind} · {group.total}
              </h2>
              <div className="flex flex-col gap-1">
                {group.items.map(item => (
                  <SearchResultRow
                    key={`${item.kind}:${item.ref}`}
                    item={item}
                    selected={false}
                    onActivate={onActivate}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
