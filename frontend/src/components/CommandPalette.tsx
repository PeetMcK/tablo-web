import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useSearch } from "../hooks/useSearch";
import { SearchResultRow } from "./SearchResultRow";
import type { SearchItem, SearchKind } from "../api/tablo";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  // What had focus before this opened, so closing can give it back instead
  // of dropping focus to <body>. Captured during render (state, not a ref —
  // React's compiler lint flags a ref write during render) rather than an
  // effect: an effect would run after the input's `autoFocus` has already
  // moved focus, by which point `document.activeElement` is this dialog's
  // own input, not whatever the user was on beforehand.
  const [previousFocus, setPreviousFocus] = useState<HTMLElement | null>(null);

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
    if (open) {
      setPreviousFocus(document.activeElement as HTMLElement | null);
    } else {
      setQuery("");
      setCursor(0);
    }
  }

  // Give focus back to whatever had it before Cmd-K, once the dialog itself
  // has actually left the DOM. Only `.focus()` here, no setState, so it
  // doesn't trip the same lint rule the render-time resets above dodge.
  useEffect(() => {
    if (open) return;
    previousFocus?.focus?.();
  }, [open, previousFocus]);

  if (!open) return null;

  // Keeps Tab/Shift+Tab from leaving the dialog — without this, a
  // keyboard or screen-reader user could tab past the input onto whatever
  // is sitting behind the backdrop, despite `aria-modal="true"` claiming
  // otherwise. Only wraps at the boundaries, so it degrades to a no-op loop
  // when the input is the only focusable element, which it usually is.
  function trapFocus(e: React.KeyboardEvent) {
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Unconditional, for every key, not just Escape: VideoPlayer keeps a
    // global `keydown` listener for its own bare-key shortcuts (space/"k"
    // play-pause, "q" close, "f"/"m" fullscreen/mute). It now ignores events
    // whose native target is a text field, which already covers this
    // dialog's input — but a modal should contain its own keyboard events on
    // principle, not rely on every listener downstream getting its guard
    // right. The failure mode if this ever drifted is silent and drops
    // playback (typing "q" while searching would close the video), so this
    // stays as a second line of defense.
    //
    // One consequence of that: ChannelGrid's own window-level listener,
    // which is what actually toggles `open`, never sees a Cmd-K pressed in
    // here — React's `stopPropagation()` stops the underlying native event
    // too, and the autoFocus input means focus is inside this dialog for as
    // long as it is open. So Cmd-K-to-close has to be handled right here,
    // rather than special-cased out of the stopPropagation above (which
    // would reopen exactly the leak the VideoPlayer fix closed, for a set of
    // keys that would need maintaining by hand). The dialog already knows it
    // is open, which makes it the right place to decide what a second Cmd-K
    // means anyway.
    e.stopPropagation();

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Tab") {
      trapFocus(e);
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
        ref={dialogRef}
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
