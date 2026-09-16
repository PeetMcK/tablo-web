import { Tv, CalendarClock, Film, CheckCircle2 } from "lucide-react";
import type { SearchItem } from "../api/tablo";
import { formatAired } from "../lib/format";

const ICONS = { channel: Tv, airing: CalendarClock, recording: Film } as const;

/** When `item` aired, as `9/13/2026 2:25 PM` — or "" for a channel result. */
function when(epoch: number | null): string {
  if (!epoch) return "";
  return formatAired(new Date(epoch * 1000).toISOString());
}

/**
 * One match, rendered the same way in the dropdown, the palette and the page.
 *
 * Shared deliberately: three surfaces showing the same result differently is
 * how a search starts feeling like three separate features.
 */
export function SearchResultRow({
  item, selected, onActivate,
}: {
  item: SearchItem;
  selected: boolean;
  onActivate: (item: SearchItem) => void;
}) {
  const Icon = ICONS[item.kind];
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={() => onActivate(item)}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition
                  ${selected ? "bg-accent-soft" : "hover:bg-fill-soft"}`}
    >
      <Icon className="w-4 h-4 shrink-0 text-fg-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg truncate">
          {item.title || "Untitled"}
        </p>
        <p className="text-[11px] text-fg-muted truncate">
          {[item.subtitle, when(item.start_epoch)].filter(Boolean).join(" · ")}
        </p>
      </div>
      {item.channel && (
        <span className="text-[10px] font-bold text-fg-muted tabular-nums shrink-0">
          {item.channel}
        </span>
      )}
      {item.recorded && (
        <span className="flex items-center gap-1 text-[10px] font-bold text-success shrink-0">
          <CheckCircle2 className="w-3 h-3" aria-hidden />
          Recorded
        </span>
      )}
    </div>
  );
}
