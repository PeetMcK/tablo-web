import { useSearch } from "../hooks/useSearch";
import { SearchResultRow } from "./SearchResultRow";
import type { SearchItem, SearchKind } from "../api/tablo";

const LABELS: Record<SearchKind, string> = {
  recording: "Recordings",
  airing: "Guide",
  channel: "Channels",
};

/** Results hanging under the topbar input. Three per group: a glance, not a list. */
export function SearchDropdown({
  query, onActivate, onSeeAll,
}: {
  query: string;
  onActivate: (item: SearchItem) => void;
  onSeeAll: () => void;
}) {
  const { data } = useSearch(query, { limit: 3 });
  if (!data) return null;

  const empty = data.groups.length === 0;

  return (
    <div
      role="listbox"
      aria-label="Search results"
      className="absolute top-full mt-2 left-0 right-0 z-50 rounded-xl border border-white/10
                 bg-surface-raised shadow-2xl p-2 max-h-[70vh] overflow-y-auto"
    >
      {empty ? (
        <p className="px-3 py-4 text-xs text-white/30">No matches for "{data.query}"</p>
      ) : (
        data.groups.map(group => (
          <div key={group.kind} className="mb-2 last:mb-0">
            <p className="px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white/20">
              {LABELS[group.kind]}
            </p>
            {group.items.map(item => (
              <SearchResultRow
                key={`${item.kind}:${item.ref}`}
                item={item}
                selected={false}
                onActivate={onActivate}
              />
            ))}
            {group.total > group.items.length && (
              <button
                onClick={onSeeAll}
                className="w-full text-left px-3 py-1.5 text-[11px] text-accent hover:underline"
              >
                {group.total - group.items.length} more
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
