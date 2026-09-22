/**
 * The Upcoming view — a time-ordered grid of every upcoming airing of the
 * series I record, each marked with its real record state. Unlike the
 * series-card Series view, this makes the gap visible: an episode a "new" rule skips
 * shows as "Rerun / Won't record" rather than silently not appearing.
 *
 * Scoped to ruled series (not the whole 4000-row lineup — that is the Guide).
 * Filter chips toggle Scheduled / Airing / Conflict independently; a Recording
 * in progress is always shown.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { api, type ScheduleRow } from "../api/tablo";
import { stateMarker, type ScheduleGroup } from "../lib/scheduleState";

const dayKey = (d: Date) =>
  d.toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });
const timeOf = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const FILTERS: { group: ScheduleGroup; label: string }[] = [
  { group: "scheduled", label: "Scheduled" },
  { group: "airing", label: "Airing" },
  { group: "conflict", label: "Conflict" },
];

function FilterChip({
  label, on, onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={
        "px-3 py-1 rounded-full text-xs font-semibold border transition " +
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
        (on
          ? "bg-accent-soft text-accent-strong border-transparent"
          : "bg-transparent text-fg-muted border-border")
      }
    >
      {label}
    </button>
  );
}

function Row({ row }: { row: ScheduleRow }) {
  const marker = stateMarker(row.state, row.skip_reason);
  const date = row.datetime ? new Date(row.datetime) : null;
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <span className="tabular-nums w-20 shrink-0 text-fg-secondary">
        {date ? timeOf(date) : "—"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate">{row.series_title}</div>
        <div className="text-fg-muted truncate">
          {row.title ?? "Upcoming episode"}
          {row.channel ? ` · ${row.channel}` : ""}
        </div>
      </div>
      <span
        className={
          "shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold " +
          marker.className
        }
      >
        {marker.label}
      </span>
    </li>
  );
}

export function ScheduleGrid({ query }: {
  /** What to narrow to, from the topbar's box; empty while it is searching. */
  query: string;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["schedule"],
    queryFn: api.series.schedule,
  });
  // All buckets on by default.
  const [enabled, setEnabled] = useState<Set<ScheduleGroup>>(
    () => new Set<ScheduleGroup>(["scheduled", "airing", "conflict"]),
  );

  const toggle = (g: ScheduleGroup) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const rows = useMemo(() => data ?? [], [data]);
  const visible = useMemo(
    () => {
      const needle = query.trim().toLowerCase();
      return rows.filter((r) => {
        const g = stateMarker(r.state, r.skip_reason).group;
        if (g !== null && !enabled.has(g)) return false; // recording (null) always shown
        if (!needle) return true;
        // The series title and the episode's own: an upcoming airing is as
        // often remembered by the episode as by the show it belongs to.
        return r.series_title.toLowerCase().includes(needle)
          || (r.title?.toLowerCase().includes(needle) ?? false);
      });
    },
    [rows, enabled, query],
  );

  const groups = useMemo(() => {
    const by = new Map<string, ScheduleRow[]>();
    for (const r of visible) {
      const key = r.datetime ? dayKey(new Date(r.datetime)) : "Scheduled";
      const bucket = by.get(key) ?? by.set(key, []).get(key)!;
      bucket.push(r);
    }
    return [...by.entries()];
  }, [visible]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-faint uppercase tracking-wide mr-1">
          Show
        </span>
        {FILTERS.map((f) => (
          <FilterChip
            key={f.group}
            label={f.label}
            on={enabled.has(f.group)}
            onToggle={() => toggle(f.group)}
          />
        ))}
      </div>

      {isLoading ? (
        <p className="text-fg-muted py-8 text-center">Loading…</p>
      ) : isError ? (
        <p className="text-fg-muted py-8 text-center">
          Couldn’t load the schedule.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-fg-muted py-8 text-center flex flex-col items-center gap-2">
          <CalendarClock className="w-8 h-8" aria-hidden />
          Nothing scheduled.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-fg-muted py-8 text-center">
          Nothing matches these filters.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(([day, dayRows]) => (
            <div key={day}>
              <h3 className="text-sm font-bold text-fg-secondary mb-2">{day}</h3>
              <ul className="flex flex-col divide-y divide-border-subtle">
                {dayRows.map((r) => (
                  <Row key={r.object_id} row={r} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
