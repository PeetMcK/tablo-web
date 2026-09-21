/**
 * The Recordings tab — the DVR management home.
 *
 * Three views: Recordings (the series I record — recorded *and* scheduled-but-
 * not-yet-recorded, with their rule/keep/counts), Schedule (a time-ordered grid
 * of every upcoming airing of those series, state-marked so a skipped rerun is
 * visible), and Failures. Conflicts are surfaced as a banner and as a marker in
 * the Schedule grid rather than a tab of their own. Tapping a series card opens
 * its detail (settings + episode cleanup).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Film } from "lucide-react";
import { api, type SeriesCard } from "../api/tablo";
import { Segmented } from "./ui/controls";
import { SeriesDetail } from "./SeriesDetail";
import { ScheduleGrid } from "./ScheduleGrid";
import { RecordingPill } from "./RecordingPill";

type Segment = "recordings" | "schedule" | "failures";

const TABS: { value: Segment; label: string }[] = [
  { value: "recordings", label: "Recordings" },
  { value: "schedule", label: "Schedule" },
  { value: "failures", label: "Failures" },
];

function keepLabel(keep: SeriesCard["keep"]): string {
  if (keep.rule === "all") return "Keep all";
  if (keep.rule === "count" && keep.count != null) return `Keep ${keep.count}`;
  return "Keep none";
}

const ruleLabel: Record<SeriesCard["rule"], string> = {
  all: "All", new: "New", none: "Off",
};

const cardKey = (s: SeriesCard) =>
  s.recordings_path ?? s.identifier ?? s.guide_path ?? s.title;

function SeriesGridCard({ s, onOpen }: { s: SeriesCard; onOpen: () => void }) {
  // A ruled series with nothing on disk yet: no recordings to browse or delete;
  // its story is "set to record", so lead with that rather than "0 ep".
  const unrecorded = s.recordings_path == null;
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
        {s.recording_now && (
          <div className="absolute top-2 left-2">
            <RecordingPill />
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
          {unrecorded ? (
            <>
              {/* Squarish status chip — status, not an action. */}
              <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-strong font-semibold">
                Scheduled
              </span>
              {s.scheduled_count > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-fill text-fg-secondary tabular-nums">
                  {s.scheduled_count} upcoming
                </span>
              )}
            </>
          ) : (
            <>
              <span className="px-1.5 py-0.5 rounded bg-fill text-fg-secondary tabular-nums">
                {s.episode_count} ep
              </span>
              {s.unwatched_count > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-accent-soft text-accent-strong font-semibold tabular-nums">
                  {s.unwatched_count} new
                </span>
              )}
            </>
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
        <SeriesGridCard key={cardKey(s)} s={s} onOpen={() => onOpen(s)} />
      ))}
    </div>
  );
}

export function RecordingsView() {
  const [segment, setSegment] = useState<Segment>("recordings");
  const [selected, setSelected] = useState<SeriesCard | null>(null);

  const series = useQuery({ queryKey: ["series"], queryFn: api.series.index });

  const all = series.data?.series ?? [];
  const failed = all.filter((s) => s.failed_count > 0);
  const conflictCount = all.filter((s) => s.conflict).length;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="flex items-center gap-3 shrink-0">
        <h1 className="text-xl font-bold shrink-0">Recordings</h1>
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
            {conflictCount} series {conflictCount === 1 ? "has" : "have"} a scheduling conflict.
          </span>
          {segment !== "schedule" && (
            <button
              onClick={() => setSegment("schedule")}
              className="ml-auto font-semibold underline underline-offset-2"
            >
              Review
            </button>
          )}
        </div>
      )}

      {/* The one scroll pane: header, switch and banner stay put; only the
          active view scrolls. `pb-6` keeps the last row off the bottom edge,
          `-mx-1 px-1` gives focus rings room without a clip. */}
      <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 pb-6">
        {series.isLoading && segment !== "schedule" ? (
          <p className="text-fg-muted py-8 text-center">Loading…</p>
        ) : segment === "recordings" ? (
          <SeriesGrid list={all} empty="No series recordings yet."
                      onOpen={setSelected} />
        ) : segment === "schedule" ? (
          <ScheduleGrid />
        ) : (
          <SeriesGrid list={failed} empty="No failed recordings."
                      onOpen={setSelected} />
        )}
      </div>

      {selected && (
        <SeriesDetail
          key={cardKey(selected)}
          card={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
