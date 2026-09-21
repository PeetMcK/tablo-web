import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { recordingFor, useRecordingsInProgress } from "../lib/useRecordingsInProgress";
import { recordedSpan } from "../lib/recording";
import { api, type GridChannel, type Program } from "../api/tablo";
import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { ContentFilterMenu } from "./ContentFilterMenu";
import {
  DATE_GAIN, DRAG_SLOP, GLIDE_DECAY, GLIDE_STOP, MIN_THROW,
  dominantAxis, prefersReducedMotion, throwVelocity, type DragSample,
} from "../lib/drag";
import { coveredHours, jumpDays, positionLabel } from "../lib/guideJump";
import { ChannelLogo } from "./ChannelLogo";
import { GuideJump } from "./GuideJump";
import { ShowInfo } from "./ShowInfo";
import { useSeriesDrawer } from "../lib/useSeriesDrawer";

/**
 * An airing to reveal, handed in from search.
 *
 * `nonce` is what makes a repeat activation land. The same result clicked
 * twice produces an identical channel and start, so without it the second
 * click is indistinguishable from the first and the effects below correctly
 * decline to re-run — leaving a click that visibly does nothing.
 */
export interface GuideJumpTarget {
  channel: string;
  start: string;
  nonce: number;
}

interface Props {
  onPlay: (channel: GridChannel) => void;
  jumpTo?: GuideJumpTarget | null;
}

const HOUR_WIDTH = 400; // px per hour
const MIN_HOURS = 6;    // floor, so a thin guide still looks like a timeline
/**
 * Width of the frozen channel column, in px. Must match the `w-20` on the
 * column itself: the scrolled surface is sized from it, and the "now" line is
 * offset by it, so the two drift apart if only one changes.
 *
 * 80, not the 128 it was: the column holds a 48px logo tile and a four-digit
 * channel number, and everything past about 64px of that was margin the guide
 * could not spare — every pixel here is a pixel of timeline.
 */
const CHANNEL_W = 80;

/**
 * Height of one channel row, in px — and it is a measurement, not a taste.
 *
 * An airing cell never grows: it is a title on one line and a description
 * clamped to one more, always. So the row is exactly what that content needs:
 * the cell's own 12px padding top and bottom, a 16.5px title line, the 2px
 * gap, and a 15px description line — 57.5 — inside the 8px the timeline
 * insets its cells by at either end. Anything taller is dead space under every
 * cell in the guide, which is what this used to be (`h-24`, 96px, ~22 of it
 * empty).
 *
 * The frozen channel tile has to fit inside the same number, which is why its
 * padding and logo box are as tight as they are — if it outgrows this, flex
 * stretches the row and the gap comes straight back.
 *
 * It is also how the band of drawn rows below is worked out, without measuring
 * a single row — a measurement per row is a layout read per row, which is the
 * cost that band exists to avoid. So this number and the rendered row height
 * have to remain the same number.
 */
const ROW_H = 74;

/**
 * Rows drawn beyond each edge of the viewport.
 *
 * Three is about a third of a screen at the smallest height worth supporting,
 * so a flick of the wheel reveals rows that were already drawn rather than
 * painting them as they arrive.
 */
const ROW_BUFFER = 3;

/**
 * How far before the live edge "back to now" lands.
 *
 * Scrolling exactly to now pins the red line to the left edge and clips the
 * programme in progress at its start - which is the one the viewer is most
 * likely looking for.
 */
const NOW_LEAD_MS = 15 * 60_000;

/**
 * How far before a jumped-to airing the guide lands.
 *
 * Scrolling exactly to its start puts the cell flush against the frozen
 * channel column, which reads as clipped rather than as the thing you asked
 * for. Same reasoning as NOW_LEAD_MS, and the same distance so both kinds of
 * jump settle the same way.
 */
const JUMP_LEAD_MS = NOW_LEAD_MS;


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

interface Placement {
  air: Program;
  left: number;
  width: number;
}

/**
 * Where each airing sits on the timeline, dropping the ones that cannot be drawn.
 *
 * Pulled out of the row so a row can ask whether it rendered anything. A
 * channel looks empty for three different reasons — no listings at all, every
 * listing already ended, or every listing too narrow to draw — and
 * `airings.length` only catches the first. Reading the result instead catches
 * all three, which is what decides whether the row gets a placeholder.
 */
function placeAirings(airings: Program[], startTime: number): Placement[] {
  const out: Placement[] = [];
  for (const air of airings) {
    const offsetSecs = (new Date(air.start).getTime() - startTime) / 1000;
    let left = (offsetSecs / 3600) * HOUR_WIDTH;
    let width = (air.duration / 3600) * HOUR_WIDTH;

    if (left + width < 0) continue;

    // Clip programmes that started before the grid start so the title text
    // stays visible at the left edge of the visible area.
    if (left < 0) {
      width += left;
      left = 0;
    }
    if (width < 20) continue;

    out.push({ air, left, width });
  }
  return out;
}

/** Pixel offset of an instant from the left edge of the timeline, clamped at 0. */
function timeOffset(at: number, startTime: number): number {
  return Math.max(0, ((at - startTime) / 3600_000) * HOUR_WIDTH);
}

/** How a channel names itself out loud — a logo and a number announce nothing. */
function channelLabel(ch: GridChannel): string {
  return ch.major > 0 ? `${ch.call_sign} ${ch.major}.${ch.minor}` : ch.call_sign;
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

export function GuideGridView({ onPlay, jumpTo }: Props) {
  // Opening the series behind an episode, from its sheet.
  const { openSeries, drawer: seriesDrawer } = useSeriesDrawer();
  // What is recording right now, from the same hook Live uses so the two views
  // cannot disagree about it. Keyed `(channel_identifier, start)`.
  const inProgress = useRecordingsInProgress(true);
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
  /** The frozen hour row, measured when scrolling a channel out from under it. */
  const headerRef = useRef<HTMLDivElement>(null);
  /** Which hour column the guide is scrolled to, for the jump control's label. */
  const [hourAt, setHourAt] = useState(0);
  // The open show sheet, keyed the way `guide_airing` is. Null when closed.
  // The open show sheet, keyed the way `guide_airing` is — except for a
  // channel the guide has no listing for, where there is no airing to key and
  // `start` is null. `label` names the channel in that case, since the sheet's
  // own eyebrow is built from an airing it will not have.
  const [info, setInfo] = useState<
    { channel: string; start: string | null; label?: string } | null>(null);
  /** The `jumpTo` nonce whose sheet has been opened. See the jump block below. */
  const [shownJump, setShownJump] = useState<number | null>(null);

  // ---- dragging the guide ------------------------------------------------
  // Nothing here is state: it is all pointer bookkeeping and writes to
  // `scrollLeft`/`scrollTop`, and a re-render per pointer move would stutter
  // the very thing being dragged. The scroller's own `onScroll` already keeps
  // the jump control's label honest.
  const glide = useRef<number | null>(null);
  const grab = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
    /** Multiplier on the drag: 1 from the hours, DATE_GAIN from the date band. */
    gain: number;
    /** Locked at the slop threshold; null until the gesture commits to one. */
    axis: "x" | "y" | null;
    samples: DragSample[];
  } | null>(null);
  // Set when a drag panned, so the click that follows a pan does not open the
  // programme under it. Cleared on the next press rather than by the click
  // itself: a pan that ends over empty space is followed by no click at all,
  // and a flag left standing would eat the next real one.
  const panned = useRef(false);

  /**
   * How a live drag keeps text from selecting under it.
   *
   * Not `user-select`, which is what this was. That property inherits, so
   * putting it on the scroller invalidates the computed style of every node
   * beneath it — 30,932 of them in a real guide, measured at 136ms to apply
   * and 117ms to take away, synchronously inside the pointer handler. A drag
   * across the listings therefore hitched for an eighth of a second as it took
   * hold and again as it let go. (Dragging the hour header never did, because
   * that gesture commits its axis at pointerdown and never reaches the branch
   * below — which is exactly the difference that was visible.)
   *
   * Refusing `selectstart` costs nothing and says the same thing: no selection
   * may begin while the guide is being dragged. One listener, no style
   * invalidation, no layout.
   */
  const refuse = useRef<((e: Event) => void) | null>(null);
  const refuseSelections = useCallback(() => {
    if (refuse.current) return;
    refuse.current = (e: Event) => e.preventDefault();
    document.addEventListener("selectstart", refuse.current);
  }, []);
  const allowSelections = useCallback(() => {
    if (!refuse.current) return;
    document.removeEventListener("selectstart", refuse.current);
    refuse.current = null;
  }, []);
  // A guide unmounted mid-drag would leave that listener on the document,
  // refusing every selection on the page with nothing left to lift it.
  useEffect(() => allowSelections, [allowSelections]);

  const stopGlide = useCallback(() => {
    if (glide.current !== null) {
      cancelAnimationFrame(glide.current);
      glide.current = null;
    }
  }, []);
  // A guide left mid-throw must not keep calling back into a dead component.
  useEffect(() => stopGlide, [stopGlide]);

  /** Coast to a stop along whichever axes the gesture kept. */
  const throwGuide = useCallback((vx: number, vy: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    let x = vx;
    let y = vy;
    let prev = performance.now();
    const frame = (ts: number) => {
      const step = ts - prev;
      prev = ts;
      if (step > 0) {
        const wasLeft = el.scrollLeft;
        const wasTop = el.scrollTop;
        el.scrollLeft -= x * step;
        el.scrollTop -= y * step;
        // Clamped at an edge: the guide has run out, so drop that axis rather
        // than grind against the end for the rest of the decay.
        if (el.scrollLeft === wasLeft) x = 0;
        if (el.scrollTop === wasTop) y = 0;
        const decay = Math.pow(GLIDE_DECAY, step);
        x *= decay;
        y *= decay;
      }
      if (Math.abs(x) < GLIDE_STOP && Math.abs(y) < GLIDE_STOP) {
        glide.current = null;
        return;
      }
      glide.current = requestAnimationFrame(frame);
    };
    glide.current = requestAnimationFrame(frame);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Touch already pans this scroller natively, and a worse gesture in place
    // of a good one is not a trade worth making.
    if (e.pointerType === "touch" || e.button !== 0) return;
    const el = scrollerRef.current;
    if (!el) return;

    stopGlide();
    panned.current = false;

    const target = e.target as HTMLElement;
    const header = target.closest("[data-guide-header]");
    // The header is a ruler, so it is geared and moves time only. The
    // listings are the content itself, so they move one-to-one - gearing
    // there would slide the programmes out from under the pointer.
    const gain = header
      ? (target.closest("[data-day-band]") ? DATE_GAIN : 1)
      : 1;

    grab.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
      gain,
      axis: header ? "x" : null,
      samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
    };
    // Capture the pointer only where there is nothing to click. Capturing it
    // over the listings broke opening a programme entirely: the browser
    // retargets the compatibility mouse events - `click` among them - to the
    // capture element, so every click landed on this surface instead of the
    // button under the finger, and no sheet ever opened. Over the listings
    // capture is taken at the moment a drag commits instead (see the move
    // handler), which is after any click has been decided against.
    if (header) e.currentTarget.setPointerCapture(e.pointerId);
  }, [stopGlide]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    const el = scrollerRef.current;
    if (!g || !el || g.id !== e.pointerId) return;

    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;

    if (g.axis === null) {
      if (Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP) return;
      // Committed, and committed once: see `dominantAxis`.
      g.axis = dominantAxis(dx, dy);
      panned.current = true;
      // Dragging across text selects it, and a pan that paints the listings
      // blue as it goes reads as broken. Only while a drag is live, so a
      // programme title can still be selected and copied at rest.
      refuseSelections();
      // Now that this is a drag and not a click, take the pointer: the
      // gesture has to survive leaving the guide, and there is no longer a
      // click for the capture to steal.
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    if (g.axis === "x") el.scrollLeft = g.left - dx * g.gain;
    else el.scrollTop = g.top - dy;

    g.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    if (g.samples.length > 12) g.samples.shift();
  }, [refuseSelections]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    grab.current = null;
    allowSelections();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    // Never crossed the threshold, so it was a click: leave it to the button
    // underneath, which opens the programme.
    if (g.axis === null || prefersReducedMotion()) return;

    const v = throwVelocity(g.samples, performance.now());
    if (!v) return;
    const vx = g.axis === "x" ? v.x * g.gain : 0;
    const vy = g.axis === "y" ? v.y : 0;
    if (Math.abs(vx) < MIN_THROW && Math.abs(vy) < MIN_THROW) return;
    throwGuide(vx, vy);
  }, [throwGuide, allowSelections]);

  // The jump control names where the guide is, which needs a render to change -
  // but this runs on every scroll frame, and re-rendering the guide per frame
  // would stutter. Quantising to the hour column makes it at most one render
  // per column crossed, and the label only ever names an hour anyway.
  const trackHour = useCallback((el: HTMLDivElement) => {
    const hour = Math.floor(el.scrollLeft / HOUR_WIDTH);
    setHourAt((held) => (held === hour ? held : hour));
  }, []);

  /**
   * Which rows get their programme cells drawn.
   *
   * A full guide holds about 9,800 cells, and they are not only the scroll's
   * problem: one step of a window drag-resize measured 12.4ms with all of them
   * in the DOM against 2.6ms with the off-screen rows' cells taken out. Every
   * frame of a resize was laying out ten thousand cells nobody could see,
   * which is why dragging the window was as slow as it could be.
   *
   * Quantised to whole rows, the same way `trackHour` is quantised to columns:
   * a render at most once per row crossed, rather than one per scroll frame.
   * The row boxes themselves always render, so the guide's height, each row's
   * `offsetTop` — which is how a jump finds it — and the scroll extent are
   * unchanged.
   */
  const [band, setBand] = useState({ first: 0, last: ROW_BUFFER * 2 });
  const trackBand = useCallback((el: HTMLDivElement) => {
    const first = Math.max(0, Math.floor(el.scrollTop / ROW_H) - ROW_BUFFER);
    const last = Math.ceil((el.scrollTop + el.clientHeight) / ROW_H) + ROW_BUFFER;
    setBand((held) =>
      held.first === first && held.last === last ? held : { first, last });
  }, []);

  // A resize changes how many rows fit without scrolling a pixel, so the band
  // has to be recut on it as well - and this is the gesture the whole thing is
  // for. `setBand` holds its object when nothing moved, so a drag that crosses
  // no row boundary re-renders nothing.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const recut = () => trackBand(el);
    recut();
    window.addEventListener("resize", recut);
    return () => window.removeEventListener("resize", recut);
  }, [trackBand]);

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
   * The hour columns grouped into the calendar days they fall in.
   *
   * A guide running past midnight shows "12:00 AM" twice over, and the time
   * alone cannot say which night it belongs to. The day used to be printed in
   * the first hour column of each day, which said it once and then scrolled
   * away — leaving most of the guide showing times that named no day at all.
   * A band per day says it for as long as that day is on screen.
   *
   * The first and last bands are usually partial: the guide starts at the top
   * of the current hour, not at midnight, so `hours` is what each band is
   * measured in rather than a flat 24.
   */
  const days = useMemo(() => {
    const out: { key: string; label: string; hours: number }[] = [];
    for (let i = 0; i < totalHours; i++) {
      const d = new Date(startTime + i * 3600_000);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const last = out[out.length - 1];
      if (last && last.key === key) {
        last.hours += 1;
      } else {
        out.push({
          key,
          label: d.toLocaleDateString([], {
            weekday: "long", month: "long", day: "numeric",
          }),
          hours: 1,
        });
      }
    }
    return out;
  }, [totalHours, startTime]);

  /**
   * One heading per hour, marked where a new day begins.
   *
   * The date itself lives in the band above (`days`); what stays here is the
   * boundary, so the transition is still visible among the times.
   */
  const hours = useMemo(() => Array.from({ length: totalHours }, (_, i) => {
    const d = new Date(startTime + i * 3600_000);
    const prev = i === 0 ? null : new Date(startTime + (i - 1) * 3600_000);
    const startsDay = prev === null || d.getDate() !== prev.getDate();
    return {
      time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
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
    // A throw still coasting would keep writing `scrollLeft` after this lands
    // and carry the guide straight back off the hour it was sent to.
    stopGlide();
    // A target inside the last screenful sits past the furthest the guide can
    // scroll, and the browser clamps the write. Read back what it actually did
    // rather than what was asked for, or the jump control's label describes a
    // position the guide is not at.
    el.scrollLeft = timeOffset(at, startTime);
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

  // A jumped-to airing opens its sheet straight away, without waiting for the
  // grid. ShowInfo fetches by (channel, start) from the mirror and needs
  // nothing from the stream, so making the answer wait on a channel row that
  // may be seconds away - or, if the device has since dropped the channel,
  // never - would withhold the one thing the click actually asked for.
  //
  // Adjusted during render rather than from an effect: this is React's own
  // "changing state when a prop changes" pattern, and an effect here would
  // render the guide once with the sheet shut and again with it open.
  // `shownJump` is compared, not `info` - the sheet can be closed, and
  // deriving from `info` would reopen it on the next render.
  if (jumpTo && shownJump !== jumpTo.nonce) {
    setShownJump(jumpTo.nonce);
    setInfo({ channel: jumpTo.channel, start: jumpTo.start });
  }

  // Hidden behind a content filter: drop the filter rather than scroll to a
  // row that is not rendered. Landing nowhere with no explanation is worse
  // than losing a filter the search result plainly contradicts. Guarded on
  // the channel being in `grid` at all, so this waits for the stream instead
  // of clearing the filter over a channel that was never coming; and on
  // `contentFilter` already being narrowed, so it cannot loop.
  const jumpHidden =
    jumpTo !== null && jumpTo !== undefined &&
    contentFilter !== "all" &&
    grid.some(c => c.identifier === jumpTo.channel) &&
    !filteredGrid.some(c => c.identifier === jumpTo.channel);
  if (jumpHidden) setContentFilter("all");

  // Scrolling to it is the best-effort half, and needs the channel's row in
  // the DOM. The stream delivers channels one at a time, so this runs again
  // on every grid update until the row is there. An effect, not render-time
  // work: it writes to the DOM and sets no state - `scrollLeft` fires the
  // scroller's own `onScroll`, which is what moves the jump control's label.
  //
  // What it must survive is that the row appearing is the WORST moment to
  // scroll: the scroller cannot scroll past its own content, and the content
  // is still arriving, so the row is inside the last screenful and the
  // browser clamps the write. Measured in the browser - a jump to 8.1 CBS
  // wrote 485 and got 217, because nine channels had streamed in of an
  // eventual twenty-eight, and the guide sat three rows short of the show it
  // had been sent to. (The horizontal write escapes this: every channel
  // carries the full fortnight, so `totalHours` is already right when the
  // first one lands.) So each attempt records whether it actually landed,
  // and an attempt that did not is retried on the next change to the rows or
  // the filter - by which time there is more below the row to scroll past.
  const attempt = `${jumpTo?.nonce ?? ""}|${grid.length}|${contentFilter}`;
  const jumped = useRef<{ nonce: number; attempt: string; landed: boolean } | null>(null);
  useEffect(() => {
    if (!jumpTo) return;
    const last = jumped.current;
    // Landed once, done for this nonce - a later render must not yank the
    // guide back from wherever the viewer has since scrolled it.
    if (last && last.nonce === jumpTo.nonce && (last.landed || last.attempt === attempt)) return;

    const el = scrollerRef.current;
    const row = el?.querySelector<HTMLElement>(
      `[data-channel="${CSS.escape(jumpTo.channel)}"]`,
    );
    if (!el || !row) return;

    stopGlide();   // same reason as `scrollToTime`: a coast would undo this
    const at = new Date(jumpTo.start).getTime();
    if (Number.isFinite(at)) el.scrollLeft = timeOffset(at - JUMP_LEAD_MS, startTime);
    // `offsetTop` rather than a row-height constant: rows are a fixed height
    // today, but a second place to encode it is a second place to drift.
    // Sticky elements still take part in flow, so this already includes the
    // header - which is why it comes back off, leaving the row flush beneath.
    const want = Math.max(0, row.offsetTop - (headerRef.current?.offsetHeight ?? 0));
    el.scrollTop = want;
    // Read back rather than assume: a clamped write is the whole problem.
    // Within a pixel, because a scroll position is not always an integer.
    jumped.current = {
      nonce: jumpTo.nonce,
      attempt,
      landed: Math.abs(el.scrollTop - want) <= 1,
    };
  }, [jumpTo, attempt, startTime, stopGlide]);

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
    {/* Content type filters, and the jump control beside or below them.

        Three shapes as the window narrows, in order:

          wide     chips on one line, NOW and the date jump at the right end
          tighter  NOW and the jump drop to a line of their own beneath the
                   chips, which are still one line
          tighter  the chips wrap onto as many lines as they need
          phone    the chips become one pill-and-popover, and all three
                   controls share a single line again

        No breakpoint decides the first of those, because the thing that
        matters is not a width: it is Streaming and NOW meeting in the middle.
        So the row simply wraps, and `min-w-max` on the chips keeps them a
        single line while there is room for one — which leaves the controls
        nowhere to go but the next line at exactly the moment the two would
        crowd. The browser works out where that is; a number here would only
        ever be an estimate of it, and `xl` was a bad one, stacking them with
        164px of the row still empty.

        `gap-x-4` is what "would crowd" means: 16px, twice the space between
        NOW and the date pill beside it. They break apart before they touch,
        not after.

        `min-w-max` only above 880px — 809px of chips inside `main`'s 48px of
        padding, and a little over. Below that the chips themselves have to
        wrap, so they must be allowed to shrink. */}
    <div data-filter-row
         className="flex flex-wrap items-start gap-x-4 gap-y-2">
    {/* Wrapping, not a hidden-scrollbar overflow. As a scroller the eighth
        chip ran under the NOW pill and off the edge with nothing to say it was
        there — 809px of chips in 553px of room at the width this was found at.
        `min-w-0` so the wrapping box may actually be narrower than its
        content, which a flex child refuses by default. */}
    <div data-filter-chips
         className="hidden sm:flex flex-wrap gap-2 min-[880px]:min-w-max">
      {CONTENT_FILTERS.map(f => (
        <button
          key={f.id}
          onClick={() => setContentFilter(f.id)}
          className={`touch-target shrink-0 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition
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

      {/* The chips, as one control, at the only width they cannot be a row.
          Shown where they are hidden and hidden where they are shown. */}
      <div data-filter-menu className="sm:hidden">
        <ContentFilterMenu value={contentFilter} onChange={setContentFilter} />
      </div>

      {/* Right-aligned at every width, whichever line it is on: `ml-auto` eats
          whatever is left of the row, beside the chips or under them. Without
          it the pair sat left once it wrapped, so it crossed the toolbar as the
          window narrowed. */}
      <div data-filter-controls className="ml-auto shrink-0">
        <GuideJump
          days={jumpRows}
          label={positionLabel(startTime, hourAt * HOUR_WIDTH, HOUR_WIDTH)}
          onJump={scrollToTime}
          onNow={() => scrollToTime(Date.now() - NOW_LEAD_MS)}
        />
      </div>
    </div>

    {/* On a phone the grid is the page, so it stops being a card: it breaks
        back out of the page's own gutter, drops the rounding and the side
        borders that would draw a frame around something touching both edges,
        and keeps only the rules above and below it. Every pixel of that inset
        was timeline on the one screen that can least afford to lose it.
        `-mx-4` is main's phone `px-4` negated — move one and move the other. */}
    <div className="flex flex-col flex-1 min-h-0 -mx-4 sm:mx-0 border-y sm:border
                    border-border-subtle rounded-none sm:rounded-3xl overflow-hidden
                    bg-surface-raised shadow-2xl shadow-shade">
      {/* The single scroller. Both axes, and the only scroll position in the
          guide. `min-h-0` so it can shrink inside the flex column above it. */}
      <div
        ref={scrollerRef}
        onScroll={e => { trackHour(e.currentTarget); trackBand(e.currentTarget); }}
        /* Focusable so the guide answers a keyboard at all. A scroll
           container that can hold focus is scrolled by the arrow keys, Page
           Up/Down and Home/End for free — the browser does it, and none of it
           worked here before because nothing in the guide could be focused.
           Labelled because a focus stop with no name announces nothing. */
        tabIndex={0}
        role="region"
        aria-label="Programme guide"
        className="flex-1 min-h-0 overflow-auto no-scrollbar
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        {/* The scrolled surface. Explicit width so the timeline extends the
            full run of the guide whatever any individual channel lists — the
            per-row spacer this replaces existed because programmes are
            absolutely positioned and contribute nothing to scroll extent. */}
        <div
          className="relative"
          style={{ width: CHANNEL_W + totalHours * HOUR_WIDTH }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >

      {/* Time Header */}
      {/* Opaque, not `bg-recess`: a sticky element has content moving beneath
          it, and recess is an 8%/40% wash that programmes would show straight
          through. The frozen row and the frozen column share `surface-sunken`,
          which is the token for exactly this and reads within a point or two of
          what the wash composited to. */}
      {/* One frozen cell beside both rows rather than one per row: stacked,
          they drew a divider across the corner that lines up with nothing —
          the column it heads is not split. So the header is a row of two
          things, the corner and the stack of dates over hours. */}
      <div
        ref={headerRef}
        data-guide-header
        className="flex bg-surface-sunken border-b border-border-subtle sticky top-0 z-30"
      >
        <div className="w-20 shrink-0 border-r border-border-subtle bg-surface-sunken flex items-center justify-center sticky left-0 z-20">
          <span className="text-[10px] font-black text-fg-muted uppercase tracking-widest">Channel</span>
        </div>

        <div className="flex flex-col cursor-grab active:cursor-grabbing select-none">
        {/* Day band. One per calendar day, spanning exactly that day's hours,
            so the boundary you scroll across is the real one. */}
        <div data-day-band className="flex border-b border-border-subtle hover:bg-fill-soft transition-colors">
          <div className="flex">
            {days.map((d, i) => (
              <div
                key={d.key}
                /* No `overflow-hidden` here, however much it looks like it
                   belongs: `overflow` other than visible makes an element a
                   scroll container, and a sticky child measures its offsets
                   against the NEAREST one. With it, each label pinned 128px
                   into its own band rather than to the guide's left edge —
                   measured at 580 where 452 was wanted. The band still
                   contains the label, because sticky cannot escape its own
                   containing block. */
                className={`shrink-0 h-6 flex items-center
                            ${i > 0 ? "border-l border-border-medium" : ""}`}
                style={{ width: d.hours * HOUR_WIDTH }}
              >
                {/* Sticky at the width of the frozen column, so the date stays
                    read-able for as long as any part of its day is on screen
                    rather than only at that day's first hour. Sticky is
                    constrained by its own band, so the label stops at the
                    boundary instead of sliding over the next day. */}
                <span
                  className="sticky px-6 whitespace-nowrap text-[11px] font-bold tracking-wide text-accent"
                  style={{ left: CHANNEL_W }}
                >
                  {d.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex relative hover:bg-fill-soft transition-colors">
            {hours.map((h, i) => (
              <div
                key={i}
                /* The day-boundary column is the stronger of the two: a heavier
                   border and a heavier text rung. Both rungs still have to carry
                   11px type, so the pair is fg-secondary / fg-muted rather than
                   the old white/50 and white/30 — white/30 has no token because
                   nothing that faint may hold text. */
                className={`shrink-0 font-mono text-[11px] font-bold flex items-center gap-2 px-6 h-8
                            ${h.startsDay
                              ? "border-l border-border-medium text-fg-secondary"
                              : "border-r border-border-subtle text-fg-muted"}`}
                style={{ width: HOUR_WIDTH }}
              >
                <span>{h.time}</span>
              </div>
            ))}
            {/* Now marker, kept to the hour row rather than run up through the
                day band: the band's label is pinned to the left edge, so a
                line spanning the whole header crosses the date text on any
                day that is under way. */}
            {nowVisible && (
              <div
                /* Below the frozen corner (z-20), above the hour cells. At
                   z-30 it drew over the word CHANNEL the moment the current
                   time scrolled behind the frozen column — the marker has to
                   disappear under that column, not ride over it. */
                className="absolute top-0 bottom-0 w-0.5 bg-danger-solid pointer-events-none z-10"
                style={{ left: nowLeft }}
              >
                <div className="w-2.5 h-2.5 rounded-full bg-danger-solid -ml-1 mt-1" />
              </div>
            )}
        </div>
        </div>
      </div>

      {/* Grid Rows */}
      <div className="flex flex-col">
        {filteredGrid.map((ch, i) => {
          // Off the band, the row is drawn as an empty box of the right size.
          // `placeAirings` is skipped with it: that work is per airing, and
          // there is nothing to place it into.
          const drawn = i >= band.first && i <= band.last;
          const placed = drawn ? placeAirings(ch.airings, startTime) : [];
          return (
          <div
            key={ch.identifier}
            /* How a jump finds this row's vertical offset. See the jump
               effect above: read, never styled. */
            data-channel={ch.identifier}
            /* The row rule is carried by the cells, not by the row. A border
               here is outside the frozen column's own box, so the now line —
               which the column is meant to hide — showed through that 1px
               strip as a red dash at every row boundary, right across the
               column. The cells paint their own bottom edge and cover it. */
            className="flex hover:bg-tint/[0.02] transition"
          >
            {/* Channel Info — frozen left, and the tune control.
                Opaque for the same reason the header is: programmes scroll
                underneath it. `hover:bg-surface-raised` rather than the usual
                `bg-fill`, which is a translucent wash and would let the
                timeline show through the moment you pointed at it.

                A button, not a tile with a click handler. This is the one way
                to tune that survives: the programme cells are to become show
                info and recording management, so the affordance has to be
                unmistakable here first. Its visible content is a logo image
                and a number, neither of which announces anything, hence the
                label. */}
            <button
              onClick={() => onPlay(ch)}
              aria-label={`Watch ${channelLabel(ch)}`}
              className="group/tile w-20 shrink-0 p-2 border-r border-b border-border-subtle flex flex-col items-center justify-center gap-1
                         bg-surface-sunken hover:bg-surface-raised transition-colors sticky left-0 z-20
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            >
              {/* The plate is the play button, the same way it is on the Live
                  TV card: the logo drops to a hint and a bare triangle comes
                  up in its place, so the thing you already aim at when you
                  want this channel is the thing that plays it. Nothing moves
                  and nothing is covered.

                  `group/tile` rather than a bare group because the row and
                  the blank-listing cell both carry groups of their own; the
                  plate must answer to the tile it lives in and nothing else.

                  `bg-logo-plate` rather than a surface token, for the reason
                  `ChannelCard` sets out at length: the logo carries its own
                  dark plate, so a tile that followed the theme put a black
                  box inside a white one in light mode. */}
              <div data-plate
                   className="relative w-12 h-9 flex items-center justify-center rounded p-1
                              bg-logo-plate border border-border-subtle
                              group-hover/tile:bg-accent-soft group-hover/tile:border-accent/30
                              group-active/tile:scale-95 transition-all duration-100">
                {/* Dimmed, not blurred. A station's mark is mostly colour and
                    that colour is how the column is scanned; held at a hint
                    behind the triangle the channel is still identifiable.
                    Blur smears 28px into a grey wash.

                    On a wrapper rather than through `ChannelLogo`, which puts
                    a caller's class on the mark inside its own opaque plate —
                    fading the mark alone leaves the plate sitting there. */}
                <span className="w-full h-full flex items-center justify-center
                                 transition-opacity duration-150
                                 group-hover/tile:opacity-[0.35]">
                  <ChannelLogo src={ch.logo_url} callSign={ch.call_sign} className="w-7 h-7" />
                </span>
                {/* Just the triangle. A second rounded shape inside the
                    rounded plate is the puck this replaced. Centred on its own
                    box: 7.5..17.5 puts the middle at 12.5, half a unit right
                    of the viewBox's 12, which is the optical correction a
                    right-pointing triangle wants. */}
                <svg className="absolute w-5 h-5 text-accent opacity-0 transition-opacity duration-150
                                group-hover/tile:opacity-100"
                     fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path d="M7.5 5 17.5 12 7.5 19 Z" />
                </svg>
              </div>
              <span className="text-[11px] font-bold text-fg-muted tabular-nums">
                {ch.major > 0 ? `${ch.major}.${ch.minor}` : "FAST"}
              </span>
            </button>

            {/* Programs Timeline — no longer a scroller, just the surface the
                absolutely-positioned airings are placed on. */}
            <div data-timeline
                 className="shrink-0 py-2 relative border-b border-border-subtle"
                 style={{ width: totalHours * HOUR_WIDTH, height: ROW_H }}>
              {!drawn ? null : placed.length === 0 ? (
                /* A channel with nothing drawable is still a channel you can
                   watch — several carry no EPG data at all and were, until
                   now, unreachable from the guide entirely. The label is
                   `sticky` at the width of the frozen column so it stays in
                   view however far along the timeline you have scrolled,
                   rather than sitting at hour zero and disappearing. */
                <button
                  /* The sheet, not playback — every other row in the guide
                     opens the sheet, and this one tuning on contact made a
                     brushed blank row the single click that started a stream.
                     Its own Watch Live does the tuning. `panned` for the same
                     reason the programme cells check it: a pan that happens to
                     end over a row is not a click on it. */
                  onClick={() => {
                    if (panned.current) return;
                    setInfo({ channel: ch.identifier, start: null,
                              label: channelLabel(ch) });
                  }}
                  aria-label={`Watch ${channelLabel(ch)} — no programme information`}
                  className="absolute inset-y-2 left-0 flex items-center rounded-sm border-l border-border-subtle
                             hover:bg-fill-soft transition-colors group text-left"
                  style={{ width: totalHours * HOUR_WIDTH - 4 }}
                >
                  <span
                    className="sticky px-4 text-[11px] font-medium uppercase tracking-widest whitespace-nowrap
                               text-fg-faint group-hover:text-fg-muted transition-colors"
                    style={{ left: CHANNEL_W }}
                  >
                    Programming Not Available
                  </span>
                </button>
              ) : placed.map(({ air, left, width }, i) => {
                const airStart = new Date(air.start).getTime();

                // Progress through this airing (0–100)
                const progress = air.duration > 0
                  ? Math.max(0, Math.min(100, ((now - airStart) / (air.duration * 1000)) * 100))
                  : 0;
                const isOnNow = progress > 0 && progress < 100;
                // What has actually been captured, when this airing is being
                // recorded. The bar above says how far through the programme
                // the clock is; once a recording exists the useful question is
                // how much of it there is, and a tuner that joined late will
                // never catch the opening.
                const recording = recordingFor(inProgress, ch.identifier, air.start);
                const captured = recording ? recordedSpan(recording) : null;

                return (
                  <button
                    key={i}
                    /* Opens information; it does not tune. The channel tile
                       above is the tune affordance - see its comment. */
                    onClick={() => {
                      if (panned.current) return;
                      setInfo({ channel: ch.identifier, start: air.start });
                    }}
                    className="absolute top-2 bottom-2 bg-fill-soft hover:bg-fill border-l border-border p-3 flex flex-col text-left group transition-colors rounded-sm overflow-hidden"
                    style={{ left, width: width - 4 }}
                  >
                    <p className="text-[11px] font-bold text-fg-secondary truncate group-hover:text-accent-strong transition-colors">
                      {recording && (
                        <span
                          className="inline-flex relative w-1.5 h-1.5 mr-1.5 align-middle"
                          aria-label={`Recording now: ${recording.title ?? air.title}`}
                        >
                          <span className="motion-safe:animate-ping absolute inline-flex w-full h-full rounded-full bg-danger opacity-60" />
                          <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-danger" />
                        </span>
                      )}
                      {air.title}
                    </p>
                    <p className="text-[10px] text-fg-muted line-clamp-1 mt-0.5">
                      {air.description || "Live TV Event"}
                    </p>
                    {/* Per-airing progress bar, or coverage where something is
                        recording this: the same geometry the Library card and
                        the Live card draw, from the same function. */}
                    {captured ? (
                      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-fill-soft">
                        <div
                          className="bg-danger h-full absolute inset-y-0"
                          style={{ left: `${captured.left}%`, width: `${captured.width}%` }}
                        />
                      </div>
                    ) : isOnNow && (
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
          );
        })}
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

      {/* The sheet a programme cell opens. Tuning from it goes through the
          same `onPlay` the channel tile uses, so there is one tune path. */}
      {info && (
        <ShowInfo
          channel={info.channel}
          start={info.start}
          channelLabel={info.label}
          onOpenSeries={(guidePath, title) => {
            setInfo(null);
            void openSeries(guidePath, title);
          }}
          onClose={() => setInfo(null)}
          onTune={() => {
            const ch = filteredGrid.find((c) => c.identifier === info.channel);
            setInfo(null);
            if (ch) onPlay(ch);
          }}
        />
      )}

      {/* The series panel, when the sheet sent us to one. */}
      {seriesDrawer}

        </div>
      </div>
    </div>
    </div>
  );
}
