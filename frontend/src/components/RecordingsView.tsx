/**
 * The Recordings tab — the DVR management home.
 *
 * A segmented switch over three card grids: Series (the series I record, with
 * their rule/keep/counts), Upcoming (what is scheduled), and Conflicts (what is
 * double-booked, hidden when there are none). Conflicts are also surfaced as a
 * banner above every segment so they are never buried.
 *
 * Upcoming/Conflicts rows are parsed from lineup-handle identifiers — the
 * device's scheduled-airings projection carries only the handle (datetime +
 * channel, no title), so v1 shows time + channel + skip reason. Tapping a
 * series card opens its detail (settings + episode cleanup).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Film } from "lucide-react";
import { api, type SeriesCard, type UpcomingAiring } from "../api/tablo";
import { Segmented } from "./ui/controls";
import { SeriesDetail } from "./SeriesDetail";

type Segment = "recordings" | "scheduled" | "upcoming" | "conflicts" | "failures";

const TABS: { value: Segment; label: string }[] = [
  { value: "recordings", label: "Recordings" },
  { value: "scheduled", label: "Scheduled" },
  { value: "upcoming", label: "Upcoming Airings" },
  { value: "conflicts", label: "Conflicts" },
  { value: "failures", label: "Failures" },
];

/** Pull datetime + channel out of a lineup handle
 *  (`LH-C…-S{station}_{maj}_{min}-T{epoch}`). No title lives in the handle. */
function parseHandle(identifier: string): {
  date: Date | null;
  channel: string | null;
} {
  const chan = identifier.match(/-S\d+_(\d+)_(\d+)/);
  const when = identifier.match(/-T(\d+)/);
  return {
    date: when ? new Date(Number(when[1]) * 1000) : null,
    channel: chan ? `${Number(chan[1])}.${Number(chan[2])}` : null,
  };
}

const dayKey = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
const timeOf = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function keepLabel(keep: SeriesCard["keep"]): string {
  if (keep.rule === "all") return "Keep all";
  if (keep.rule === "count" && keep.count != null) return `Keep ${keep.count}`;
  return "Keep none";
}

const ruleLabel: Record<SeriesCard["rule"], string> = {
  all: "All", new: "New", none: "Off",
};

function SeriesGridCard({ s, onOpen }: { s: SeriesCard; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="group text-left rounded-xl overflow-hidden bg-surface-raised border border-border-subtle
                 hover:border-border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="aspect-video bg-surface-sunken relative">
        {s.cover_image_id != null ? (
          <img
            src={`/api/channels/image/${s.cover_image_id}`}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-fg-subtle">
            <Film className="w-8 h-8" aria-hidden />
          </div>
        )}
        {s.conflict && (
          <span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-danger-solid"
                title="A scheduled airing conflicts" aria-label="Conflict" />
        )}
      </div>
      <div className="p-3">
        <div className="font-bold truncate">{s.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="px-1.5 py-0.5 rounded bg-fill text-fg-secondary font-semibold">
            {ruleLabel[s.rule]}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-fill text-fg-secondary">
            {keepLabel(s.keep)}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-fill text-fg-secondary tabular-nums">
            {s.episode_count} ep
          </span>
          {s.unwatched_count > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-strong font-semibold tabular-nums">
              {s.unwatched_count} new
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function SeriesGrid({
  list, empty, onOpen,
}: {
  list: SeriesCard[];
  empty: string;
  onOpen: (s: SeriesCard) => void;
}) {
  if (list.length === 0) {
    return (
      <p className="text-fg-muted py-8 text-center flex flex-col items-center gap-2">
        <CalendarClock className="w-8 h-8" aria-hidden />
        {empty}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {list.map((s) => (
        <SeriesGridCard key={s.recordings_path} s={s} onOpen={() => onOpen(s)} />
      ))}
    </div>
  );
}

function AiringList({
  airings, emptyLabel = "Nothing scheduled.",
}: {
  airings: UpcomingAiring[];
  emptyLabel?: string;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, { air: UpcomingAiring; date: Date | null; channel: string | null }[]>();
    for (const air of airings) {
      const { date, channel } = parseHandle(air.identifier);
      const key = date ? dayKey(date) : "Scheduled";
      const row = { air, date, channel };
      (by.get(key) ?? by.set(key, []).get(key)!).push(row);
    }
    return [...by.entries()];
  }, [airings]);

  if (airings.length === 0) {
    return <p className="text-fg-muted py-8 text-center">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map(([day, rows]) => (
        <div key={day}>
          <h3 className="text-sm font-bold text-fg-secondary mb-2">{day}</h3>
          <ul className="flex flex-col divide-y divide-border-subtle">
            {rows.map((r, i) => (
              <li key={r.air.identifier + i}
                  className="flex items-center gap-3 py-2 text-sm">
                <span className="tabular-nums w-20 text-fg-secondary">
                  {r.date ? timeOf(r.date) : "—"}
                </span>
                <span className="tabular-nums text-fg-muted w-14">
                  {r.channel ?? ""}
                </span>
                {r.air.schedule.skip_reason !== "none" && (
                  <span className="px-1.5 py-0.5 rounded bg-warning-soft text-warning text-[11px] font-semibold">
                    {r.air.schedule.skip_reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function RecordingsView() {
  const [segment, setSegment] = useState<Segment>("recordings");
  const [selected, setSelected] = useState<SeriesCard | null>(null);

  const series = useQuery({ queryKey: ["series"], queryFn: api.series.index });
  const upcoming = useQuery({ queryKey: ["upcoming"], queryFn: api.series.upcoming });
  const conflicts = useQuery({ queryKey: ["conflicts"], queryFn: api.series.conflicts });

  const conflictCount = conflicts.data?.length ?? 0;
  const all = series.data?.series ?? [];
  const scheduled = all.filter((s) => s.rule !== "none");
  const failed = all.filter((s) => s.failed_count > 0);

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="flex items-center gap-3 shrink-0">
        <h1 className="text-xl font-bold shrink-0">Recordings</h1>
        {/* The tab set mirrors the Tablo app. Scrolls sideways on a phone
            rather than wrapping, so the row height never changes. */}
        <div className="overflow-x-auto -mx-1 px-1">
          <Segmented<Segment>
            value={segment}
            options={TABS}
            onChange={setSegment}
            label="Recordings view"
          />
        </div>
      </div>

      {conflictCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-danger-solid/40 bg-danger-solid/10 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          <span>
            {conflictCount} scheduled recording{conflictCount === 1 ? "" : "s"} conflict.
          </span>
          {segment !== "conflicts" && (
            <button
              onClick={() => setSegment("conflicts")}
              className="ml-auto font-semibold underline underline-offset-2"
            >
              Review
            </button>
          )}
        </div>
      )}

      {/* The one scroll pane: the header, switch and banner stay put; only the
          active segment's grid/list scrolls. `pb-6` keeps the last row off the
          bottom edge, `-mx-1 px-1` gives focus rings room without a clip. */}
      <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 pb-6">
        {series.isLoading && segment !== "upcoming" && segment !== "conflicts" ? (
          <p className="text-fg-muted py-8 text-center">Loading…</p>
        ) : segment === "recordings" ? (
          <SeriesGrid list={all} empty="No series recordings yet."
                      onOpen={setSelected} />
        ) : segment === "scheduled" ? (
          <SeriesGrid list={scheduled} empty="No series are set to record."
                      onOpen={setSelected} />
        ) : segment === "failures" ? (
          <SeriesGrid list={failed} empty="No failed recordings."
                      onOpen={setSelected} />
        ) : segment === "upcoming" ? (
          <AiringList airings={upcoming.data ?? []} />
        ) : (
          <AiringList airings={conflicts.data ?? []} emptyLabel="No conflicts." />
        )}
      </div>

      {selected && (
        <SeriesDetail
          key={selected.recordings_path}
          card={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
