/**
 * The Series tab — the DVR management home.
 *
 * Three views: Series (the series I record — recorded *and* scheduled-but-
 * not-yet-recorded, with their rule/keep/counts), Upcoming (a time-ordered grid
 * of every upcoming airing of those series, state-marked so a skipped rerun is
 * visible), and Failures.
 *
 * Named Series rather than Recordings because the Library is literally the
 * recordings; this is where you decide what becomes one. "Series" is the
 * device's own word for these - /guide/series, series_path - and stays true
 * for a series whose rule is Off but whose episodes are still on disk. Conflicts are surfaced as a banner and as a marker in
 * the Schedule grid rather than a tab of their own. Tapping a series card opens
 * its detail (settings + episode cleanup).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Film } from "lucide-react";
import { api, type SeriesCard } from "../api/tablo";
import { Segmented } from "./ui/controls";
import { SeriesDetail } from "./SeriesDetail";
import { ScheduleGrid } from "./ScheduleGrid";
import { RecordingPill } from "./RecordingPill";
import { keepLabel } from "../lib/keep";

type Segment = "series" | "upcoming" | "failures";

const TABS: { value: Segment; label: string }[] = [
  { value: "series", label: "Series" },
  { value: "upcoming", label: "Upcoming" },
  { value: "failures", label: "Failures" },
];

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

export function RecordingsView({ query }: {
  /**
   * What to narrow to, from the topbar's box; empty while it is searching.
   * See `lib/topbarMemory` for where the text lives between visits.
   */
  query: string;
}) {
  const [segment, setSegment] = useState<Segment>("series");
  const [selected, setSelected] = useState<SeriesCard | null>(null);

  const series = useQuery({ queryKey: ["series"], queryFn: api.series.index });

  // By title only: a card carries counts, a rule and a keep policy, and none
  // of those is what anyone types into a box looking for a show.
  const all = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cards = series.data?.series ?? [];
    if (!needle) return cards;
    return cards.filter((s) => s.title.toLowerCase().includes(needle));
  }, [series.data, query]);
  const failed = all.filter((s) => s.failed_count > 0);
  // Deliberately counted over everything rather than over `all`: a conflict
  // does not stop being one because the box is narrowed to something else,
  // and a banner that vanishes when you filter is a banner that lies.
  const conflictCount = (series.data?.series ?? []).filter((s) => s.conflict).length;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* No page title. The nav says which section this is and the switch
          below says which view - a heading here said "Recordings" a third
          time inside the same hundred pixels. */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="overflow-x-auto -mx-1 px-1">
          <Segmented<Segment>
            value={segment}
            options={TABS}
            onChange={setSegment}
            label="Schedule view"
          />
        </div>
      </div>

      {conflictCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-danger-solid/40 bg-danger-solid/10 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
          <span>
            {conflictCount} series {conflictCount === 1 ? "has" : "have"} a scheduling conflict.
          </span>
          {segment !== "upcoming" && (
            <button
              onClick={() => setSegment("upcoming")}
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
        {series.isLoading && segment !== "upcoming" ? (
          <p className="text-fg-muted py-8 text-center">Loading…</p>
        ) : segment === "series" ? (
          <SeriesGrid list={all} empty="No series recordings yet."
                      onOpen={setSelected} />
        ) : segment === "upcoming" ? (
          <ScheduleGrid query={query} />
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
