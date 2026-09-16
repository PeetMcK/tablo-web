import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useSearch } from "../hooks/useSearch";
import { SearchResultRow } from "./SearchResultRow";
import type { SearchItem, SearchKind } from "../api/tablo";

const LABELS: Record<SearchKind, string> = {
  recording: "Recordings",
  airing: "Guide",
  channel: "Channels",
};

/**
 * Search over whatever is on screen.
 *
 * A modal rather than a route so it never disturbs playback: opening it while
 * watching must not unmount the player.
 */
export function CommandPalette({
  open, onClose, onActivate,
}: {
  open: boolean;
  onClose: () => void;
  onActivate: (item: SearchItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const { data } = useSearch(query, { limit: 5 });

  // One flat list, because the keyboard moves through results rather than
  // through groups - the headings are visual only.
  const flat = useMemo(
    () => (data?.groups ?? []).flatMap(g => g.items),
    [data],
  );
  // Where each group's items start in `flat`, so the visual grouping below
  // can still mark the right row selected. Computed without mutating a
  // shared counter across iterations, which React's compiler lint flags as
  // an unsafe render-time mutation.
  const groupOffsets = useMemo(() => {
    const groups = data?.groups ?? [];
    return groups.map((group, i) => ({
      group,
      offset: groups.slice(0, i).reduce((n, g) => n + g.items.length, 0),
    }));
  }, [data]);

  // Reset the selection when the results change, and clear the query once
  // the palette closes - both adjusted during render rather than from an
  // effect. Setting state in an effect body queues a second render with the
  // stale values already painted (and React's `react-hooks/set-state-in-effect`
  // flags exactly that cascade); comparing the previous value here is React's
  // documented way to adjust state when a prop changes; see VideoPlayer's
  // `renderedSource` for the same pattern.
  const [renderedData, setRenderedData] = useState(data);
  if (renderedData !== data) {
    setRenderedData(data);
    setCursor(0);
  }
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setQuery("");
      setCursor(0);
    }
  }

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // Handled here, on the dialog itself, rather than a document listener:
      // the dropdown underneath (Task 12) has its own Escape handling on the
      // topbar input, and a document-level listener here would fire for both
      // and fight over which one wins. The palette holds focus while it is
      // open, so its own keydown is the only one that sees this Escape.
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(c => Math.min(c + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && flat[cursor]) {
      e.preventDefault();
      onActivate(flat[cursor]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[15vh] px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
        onKeyDown={onKeyDown}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-xl rounded-2xl border border-white/10 bg-surface-raised shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 border-b border-white/5">
          <Search className="w-4 h-4 text-white/20" aria-hidden />
          <input
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="palette-results"
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search channels, guide and recordings..."
            className="flex-1 bg-transparent py-4 text-sm placeholder-white/20 focus:outline-none"
          />
        </div>
        <div id="palette-results" role="listbox" className="p-2 max-h-[50vh] overflow-y-auto">
          {groupOffsets.map(({ group, offset }) => (
            <div key={group.kind} className="mb-2 last:mb-0">
              <p className="px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white/20">
                {LABELS[group.kind]}
              </p>
              {group.items.map((item, i) => (
                <SearchResultRow
                  key={`${item.kind}:${item.ref}`}
                  item={item}
                  selected={offset + i === cursor}
                  onActivate={onActivate}
                />
              ))}
            </div>
          ))}
          {data && flat.length === 0 && (
            <p className="px-3 py-4 text-xs text-white/30">No matches for "{data.query}"</p>
          )}
        </div>
      </div>
    </div>
  );
}
