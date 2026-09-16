import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api, type GridChannel, type Program } from "../api/tablo";
import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { coveredHours, jumpDays, positionLabel } from "../lib/guideJump";
import { ChannelLogo } from "./ChannelLogo";
import { GuideJump } from "./GuideJump";

interface Props {
  onPlay: (channel: GridChannel) => void;
}

const HOUR_WIDTH = 400; // px per hour
const MIN_HOURS = 6;    // floor, so a thin guide still looks like a timeline
/**
 * Width of the frozen channel column, in px. Must match the `w-32` on the
 * column itself: the scrolled surface is sized from it, and the "now" line is
 * offset by it, so the two drift apart if only one changes.
 */
const CHANNEL_W = 128;

/**
 * How far before the live edge "back to now" lands.
 *
 * Scrolling exactly to now pins the red line to the left edge and clips the
 * programme in progress at its start - which is the one the viewer is most
 * likely looking for.
 */
const NOW_LEAD_MS = 15 * 60_000;


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

  /**
   * The guide is ONE scroller, in both axes.
   *
   * It used to be a scroller per row — the hour headings plus one per channel —
   * held together by writing `scrollLeft` to all the others on every scroll
   * frame. That kept them aligned at rest but could not keep them aligned in
   * motion: the browser scrolls whichever row the pointer is over on the
   * compositor, with momentum and rubber-band, while the rest were assigned
   * from JavaScript a frame later, with neither. A flick left the hovered row
   * tracking the clock and the other rows trailing it by about 20px, which is
   * one frame at a normal flick speed, and at the ends the hovered row would
   * overscroll while the others clamped dead.
   *
   * Frozen row and column are `position: sticky` inside this one scroller
   * instead, so alignment is not maintained at all — there is only one surface,
   * and one scroll position. `lanes`, `offset`, `syncLanes` and `registerLane`
   * are all gone with it.
   */
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** Which hour column the guide is scrolled to, for the jump control's label. */
  const [hourAt, setHourAt] = useState(0);

  // The jump control names where the guide is, which needs a render to change -
  // but this runs on every scroll frame, and re-rendering the guide per frame
  // would stutter. Quantising to the hour column makes it at most one render
  // per column crossed, and the label only ever names an hour anyway.
  const trackHour = useCallback((el: HTMLDivElement) => {
    const hour = Math.floor(el.scrollLeft / HOUR_WIDTH);
    setHourAt((held) => (held === hour ? held : hour));
  }, []);

  // Stable grid start: current hour, zeroed minutes/seconds
  const startTime = useMemo(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }, []);

  /**
   * How far the timeline runs, taken from the listings themselves.
   *
   * This was a fixed six hours while programmes were positioned from their real
   * start with no cap, so anything further out was drawn under blank space and
   * the clock stopped describing the content beneath it. The header has to span
   * whatever the guide actually holds.
   */
  const totalHours = useMemo(() => {
    let end = startTime + MIN_HOURS * 3600_000;
    for (const ch of grid) {
      for (const air of ch.airings ?? []) {
        const airEnd = new Date(air.start).getTime() + (air.duration || 0) * 1000;
        if (Number.isFinite(airEnd) && airEnd > end) end = airEnd;
      }
    }
    return Math.ceil((end - startTime) / 3600_000);
  }, [grid, startTime]);

  /**
   * One heading per hour, carrying the day when it changes.
   *
   * A guide running past midnight shows "12:00 AM" twice over, and the time
   * alone cannot say which night it belongs to — so the first column of each
   * day is labelled with the date and marked off.
   */
  const hours = useMemo(() => Array.from({ length: totalHours }, (_, i) => {
    const d = new Date(startTime + i * 3600_000);
    const prev = i === 0 ? null : new Date(startTime + (i - 1) * 3600_000);
    const startsDay = prev === null || d.getDate() !== prev.getDate();
    return {
      time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      day: startsDay
        ? d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })
        : null,
      startsDay,
    };
  }), [totalHours, startTime]);

  // Pixel offset of "now" from the left edge of the timeline
  const nowLeft = ((now - startTime) / 1000 / 3600) * HOUR_WIDTH;
  const nowVisible = nowLeft >= 0 && nowLeft <= HOUR_WIDTH * totalHours;

  /**
   * Put an instant at the left edge of the guide.
   *
   * One write now rather than a loop over every lane. Written as a plain
   * handler rather than a `useCallback`: scrolling is a write to the DOM
   * through a ref, which belongs to an event and not to a memoized value.
   */
  const scrollToTime = (at: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const want = Math.max(0, ((at - startTime) / 3600_000) * HOUR_WIDTH);
    // A target inside the last screenful sits past the furthest the guide can
    // scroll, and the browser clamps the write. Read back what it actually did
    // rather than what was asked for, or the jump control's label describes a
    // position the guide is not at.
    el.scrollLeft = want;
    setHourAt(Math.floor(el.scrollLeft / HOUR_WIDTH));
  };

  /** Which hours hold listings, so the jump control can refuse the empty ones. */
  const covered = useMemo(
    () => coveredHours(grid.flatMap(ch => ch.airings ?? [])),
    [grid],
  );

  const jumpRows = useMemo(
    () => jumpDays({ startTime, totalHours, covered, now }),
    [startTime, totalHours, covered, now],
  );

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
    // `min-h-0` on every link of this chain, not just the scroller. A flex
    // child defaults to `min-height: auto`, which refuses to shrink below its
    // content — so a single ancestor without it silently cancels the `flex-1`
    // below and the card goes back to overflowing the page.
    <div className="flex flex-col gap-4 flex-1 min-h-0">
    {/* Content type filter chips, and the jump control in the space they leave */}
    <div className="flex items-center gap-2">
    <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
      {CONTENT_FILTERS.map(f => (
        <button
          key={f.id}
          onClick={() => setContentFilter(f.id)}
          className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition
            ${contentFilter === f.id
              /* A flat accent rather than the brand ramp: this chip carries a
                 12px bold LABEL, and nothing clears 4.5:1 against both ends of
                 the gradient. `bg-accent text-accent-fg` is 6.37:1 light and
                 5.40:1 dark. The ramp stays on the marks and bars below. */
              ? "bg-accent text-accent-fg shadow-lg shadow-accent-glow"
              : "bg-fill-soft text-fg-muted hover:bg-fill hover:text-fg-secondary border border-border-subtle"
            }`}
        >
          <f.Icon className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />
          <span>{f.label}</span>
        </button>
      ))}
    </div>

      <div className="flex-1" />

      <GuideJump
        days={jumpRows}
        label={positionLabel(startTime, hourAt * HOUR_WIDTH, HOUR_WIDTH)}
        onJump={scrollToTime}
        onNow={() => scrollToTime(Date.now() - NOW_LEAD_MS)}
      />
    </div>

    <div className="flex flex-col flex-1 min-h-0 border border-border-subtle rounded-3xl overflow-hidden bg-surface-raised shadow-2xl shadow-shade">
      {/* The single scroller. Both axes, and the only scroll position in the
          guide. `min-h-0` so it can shrink inside the flex column above it. */}
      <div
        ref={scrollerRef}
        onScroll={e => trackHour(e.currentTarget)}
        className="flex-1 min-h-0 overflow-auto no-scrollbar"
      >
        {/* The scrolled surface. Explicit width so the timeline extends the
            full run of the guide whatever any individual channel lists — the
            per-row spacer this replaces existed because programmes are
            absolutely positioned and contribute nothing to scroll extent. */}
        <div className="relative" style={{ width: CHANNEL_W + totalHours * HOUR_WIDTH }}>

      {/* Time Header */}
      {/* Opaque, not `bg-recess`: a sticky element has content moving beneath
          it, and recess is an 8%/40% wash that programmes would show straight
          through. The frozen row and the frozen column share `surface-sunken`,
          which is the token for exactly this and reads within a point or two of
          what the wash composited to. */}
      <div className="flex bg-surface-sunken border-b border-border-subtle sticky top-0 z-30 relative">
        <div className="w-32 shrink-0 border-r border-border-subtle bg-surface-sunken flex items-center justify-center sticky left-0 z-10">
          <span className="text-[10px] font-black text-fg-muted uppercase tracking-widest">Channel</span>
        </div>
        <div className="flex relative">
          {hours.map((h, i) => (
            <div
              key={i}
              /* The day-boundary column is the stronger of the two: a heavier
                 border and a heavier text rung. Both rungs still have to carry
                 11px type, so the pair is fg-secondary / fg-muted rather than
                 the old white/50 and white/30 — white/30 has no token because
                 nothing that faint may hold text. */
              className={`shrink-0 font-mono text-[11px] font-bold flex items-center gap-2 px-6 h-10
                          ${h.startsDay
                            ? "border-l border-border-medium text-fg-secondary"
                            : "border-r border-border-subtle text-fg-muted"}`}
              style={{ width: HOUR_WIDTH }}
            >
              {/* The date leads the first column of each day; a stronger left
                  border makes the boundary visible while scrolling past it.
                  Full-strength accent, not accent/70: the faded form lands near
                  3.3:1 on this strip, where the solid token holds ~6:1. */}
              {h.day && <span className="text-accent">{h.day}</span>}
              <span>{h.time}</span>
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
      <div className="flex flex-col">
        {filteredGrid.map((ch) => (
          <div key={ch.identifier} className="flex border-b border-border-subtle hover:bg-tint/[0.02] transition">
            {/* Channel Info — frozen left. Opaque for the same reason the header
                is: programmes scroll underneath it. */}
            <div className="w-32 shrink-0 p-4 border-r border-border-subtle flex flex-col items-center justify-center gap-1.5 bg-surface-sunken sticky left-0 z-20">
              <div className="w-12 h-10 flex items-center justify-center bg-surface-sunken rounded border border-border-subtle p-1">
                <ChannelLogo src={ch.logo_url} callSign={ch.call_sign} className="w-7 h-7" />
              </div>
              <span className="text-[11px] font-bold text-fg-muted tabular-nums">
                {ch.major > 0 ? `${ch.major}.${ch.minor}` : "FAST"}
              </span>
            </div>

            {/* Programs Timeline — no longer a scroller, just the surface the
                absolutely-positioned airings are placed on. */}
            <div className="shrink-0 py-2 relative h-24" style={{ width: totalHours * HOUR_WIDTH }}>
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
                        {/* A bar, not a label: the brand ramp is allowed here. */}
                        <div className="accent-gradient-x h-full opacity-70" style={{ width: `${progress}%` }} />
                      </div>
                    )}
                  </button>
                );
              })}

            </div>
          </div>
        ))}
      </div>

      {/* One "now" line for the whole grid, not one per row. It lives on the
          scrolled surface so it travels with the timeline, and sits at z-10:
          above the airings, below the frozen column (z-20) and the frozen
          header (z-30), so it slides under both rather than over them. */}
      {nowVisible && (
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-danger-solid pointer-events-none z-10"
          style={{ left: CHANNEL_W + nowLeft }}
          aria-hidden
        />
      )}

        </div>
      </div>
    </div>
    </div>
  );
}
