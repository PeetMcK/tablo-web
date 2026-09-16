import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api, type GridChannel, type Program } from "../api/tablo";
import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { ChannelLogo } from "./ChannelLogo";

interface Props {
  onPlay: (channel: GridChannel) => void;
}


function airingMatchesFilter(air: Program, f: ContentFilter): boolean {
  if (f === "all") return true;
  const genres = air.genres ?? [];
  if (f === "movies")       return air.kind === "movieAiring";
  if (f === "sports")       return air.kind === "sportEvent" || genres.some(g => /sport/i.test(g));
  if (f === "news")         return genres.some(g => /news/i.test(g));
  if (f === "reality")      return genres.some(g => /reality/i.test(g));
  if (f === "documentary")  return genres.some(g => /documentary/i.test(g));
  return false; // ota/fast handled at channel level
}

function channelMatchesFilter(ch: GridChannel, f: ContentFilter): boolean {
  if (f === "all")  return true;
  if (f === "ota")  return ch.kind === "ota";
  if (f === "fast") return ch.kind === "ott";
  return ch.airings.some(a => airingMatchesFilter(a, f));
}

/**
 * Stream the grid, keeping whatever is already on screen until it is replaced.
 *
 * The guide is stored server-side, so a refresh is answered from the database
 * without touching the device - fast enough that a client-side copy would be
 * duplicating state rather than saving a wait.
 */
function useGridStream() {
  const [grid, setGrid] = useState<GridChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const map = new Map<string, GridChannel>();

    async function run() {
      try {
        for await (const ch of api.guideGridStream(controller.signal)) {
          if (controller.signal.aborted) break;
          map.set(ch.identifier, ch);
          setGrid([...map.values()]);
          setLoading(false);
        }
      } catch (e) {
        if (!controller.signal.aborted) console.error("Grid stream error:", e);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    run();
    return () => controller.abort();
  }, []);

  return { grid, loading };
}

export function GuideGridView({ onPlay }: Props) {
  const { grid, loading: isLoading } = useGridStream();
  const [now, setNow] = useState(() => Date.now());
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // The hour headings and each channel are separate horizontal scrollers, so
  // they have to be driven together: scrolling one row on its own slid that
  // channel out from under the clock, and the grid then showed programmes
  // against the wrong times without any sign it had happened.
  //
  // Kept as one shared offset rather than a piece of state - this runs on every
  // scroll frame, and re-rendering the whole guide to move it would stutter.
  const lanes = useRef(new Set<HTMLDivElement>());
  const offset = useRef(0);

  const syncLanes = useCallback((from: HTMLDivElement) => {
    offset.current = from.scrollLeft;
    for (const lane of lanes.current) {
      // Assigning an unchanged scrollLeft still fires `scroll` in some browsers,
      // which would bounce straight back here; skipping the source and the
      // already-aligned keeps it from looping.
      if (lane !== from && lane.scrollLeft !== offset.current) {
        lane.scrollLeft = offset.current;
      }
    }
  }, []);

  const registerLane = useCallback((el: HTMLDivElement) => {
    lanes.current.add(el);
    // A channel that streams in after the guide has been scrolled must arrive
    // at the offset everything else is already showing.
    if (el.scrollLeft !== offset.current) el.scrollLeft = offset.current;
    // Returning a cleanup (React 19) drops the lane on unmount. Without it the
    // set kept every row a filter change had removed, and each scroll wrote to
    // detached nodes for the life of the page.
    return () => { lanes.current.delete(el); };
  }, []);

  // Stable grid start: current hour, zeroed minutes/seconds
  const startTime = useMemo(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }, []);

  const HOUR_WIDTH = 400; // px per hour
  const TOTAL_HOURS = 6;

  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => {
    const d = new Date(startTime + i * 3600 * 1000);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });

  // Pixel offset of "now" from the left edge of the timeline
  const nowLeft = ((now - startTime) / 1000 / 3600) * HOUR_WIDTH;
  const nowVisible = nowLeft >= 0 && nowLeft <= HOUR_WIDTH * TOTAL_HOURS;

  const filteredGrid = contentFilter === "all" ? grid : grid.filter(ch => channelMatchesFilter(ch, contentFilter));

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-48 gap-4">
        <div className="w-12 h-12 rounded-full border-4 border-accent border-t-transparent animate-spin" />
        <p className="text-fg-muted text-sm font-medium uppercase tracking-widest">Generating Grid...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
    {/* Content type filter chips */}
    <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
      {CONTENT_FILTERS.map(f => (
        <button
          key={f.id}
          onClick={() => setContentFilter(f.id)}
          className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition
            ${contentFilter === f.id
              ? "bg-accent text-accent-fg shadow-lg shadow-accent-glow"
              : "bg-fill-soft text-fg-muted hover:bg-fill hover:text-fg-secondary border border-border-subtle"
            }`}
        >
          <f.Icon className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />
          <span>{f.label}</span>
        </button>
      ))}
    </div>

    <div className="flex flex-col border border-border-subtle rounded-3xl overflow-hidden bg-surface-raised shadow-2xl shadow-shade">
      {/* Time Header */}
      <div className="flex bg-recess border-b border-border-subtle sticky top-0 z-20">
        <div className="w-32 shrink-0 border-r border-border-subtle bg-recess-soft flex items-center justify-center">
          <span className="text-[10px] font-black text-fg-muted uppercase tracking-widest">Channel</span>
        </div>
        <div className="flex flex-1 overflow-x-auto no-scrollbar relative"
             ref={registerLane}
             onScroll={e => syncLanes(e.currentTarget)}>
          {hours.map((h, i) => (
            <div key={i} className="shrink-0 font-mono text-[11px] font-bold text-fg-muted flex items-center px-6 border-r border-border-subtle h-10"
                 style={{ width: HOUR_WIDTH }}>
              {h}
            </div>
          ))}
          {/* Now marker in header */}
          {nowVisible && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-danger-solid pointer-events-none z-30"
              style={{ left: nowLeft }}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-danger-solid -ml-1 mt-1" />
            </div>
          )}
        </div>
      </div>

      {/* Grid Rows */}
      <div className="flex flex-col max-h-[70vh] overflow-y-auto overflow-x-hidden">
        {filteredGrid.map((ch) => (
          <div key={ch.identifier} className="flex border-b border-border-subtle hover:bg-tint/[0.02] transition">
            {/* Channel Info */}
            <div className="w-32 shrink-0 p-4 border-r border-border-subtle flex flex-col items-center justify-center gap-1.5 bg-recess-soft">
              <div className="w-12 h-10 flex items-center justify-center bg-surface-sunken rounded border border-border-subtle p-1">
                <ChannelLogo src={ch.logo_url} callSign={ch.call_sign} className="w-7 h-7" />
              </div>
              <span className="text-[11px] font-bold text-fg-muted tabular-nums">
                {ch.major > 0 ? `${ch.major}.${ch.minor}` : "FAST"}
              </span>
            </div>

            {/* Programs Timeline */}
            <div className="flex flex-1 overflow-x-auto no-scrollbar py-2 relative h-24"
                 ref={registerLane}
                 onScroll={e => syncLanes(e.currentTarget)}>
              {ch.airings.map((air, i) => {
                const airStart = new Date(air.start).getTime();
                const offsetSecs = (airStart - startTime) / 1000;
                let left = (offsetSecs / 3600) * HOUR_WIDTH;
                let width = (air.duration / 3600) * HOUR_WIDTH;

                if (left + width < 0) return null;

                // Clip programs that started before the grid start so the
                // title text stays visible at the left edge of the visible area.
                if (left < 0) {
                  width += left;
                  left = 0;
                }
                if (width < 20) return null;

                // Progress through this airing (0–100)
                const progress = air.duration > 0
                  ? Math.max(0, Math.min(100, ((now - airStart) / (air.duration * 1000)) * 100))
                  : 0;
                const isOnNow = progress > 0 && progress < 100;

                return (
                  <button
                    key={i}
                    onClick={() => onPlay(ch)}
                    className="absolute top-2 bottom-2 bg-fill-soft hover:bg-fill border-l border-border p-3 flex flex-col text-left group transition-colors rounded-sm overflow-hidden"
                    style={{ left, width: width - 4 }}
                  >
                    <p className="text-[11px] font-bold text-fg-secondary truncate group-hover:text-accent-strong transition-colors">
                      {air.title}
                    </p>
                    <p className="text-[10px] text-fg-muted line-clamp-1 mt-0.5">
                      {air.description || "Live TV Event"}
                    </p>
                    {/* Per-airing progress bar */}
                    {isOnNow && (
                      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-fill-soft">
                        <div className="h-full bg-accent/70" style={{ width: `${progress}%` }} />
                      </div>
                    )}
                  </button>
                );
              })}

              {/* Vertical "now" line across the row */}
              {nowVisible && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-danger-solid pointer-events-none z-30"
                  style={{ left: nowLeft }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
    </div>
  );
}
