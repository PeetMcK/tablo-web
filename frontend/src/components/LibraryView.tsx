import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, downloadUrl } from "../api/tablo";
import type { Recording, RecordingList } from "../api/tablo";
import { VideoPlayer, LIVE_EDGE } from "./VideoPlayer";
import { AlertTriangle, Play, Download, CheckCircle2, CloudOff, Eye, EyeOff, FileDown, Funnel, ImageOff, Loader2, Lock, LockOpen, Pause, Radio, Trash2, X } from "lucide-react";
import { recordingMatchesFilter, type ContentFilter } from "../lib/contentFilters";
import { ContentFilterMenu } from "./ContentFilterMenu";
import { OptionMenu } from "./OptionMenu";
import {
  LIBRARY_GROUPS, LIBRARY_LAYOUTS, LIBRARY_SORTS, arrange,
  type LibraryGroup, type LibraryLayout, type LibrarySort,
} from "../lib/libraryLayout";
import { LayoutToggle } from "./LayoutToggle";
import { RecordingRow } from "./RecordingRow";
import { usePref } from "../lib/usePref";
import { useMediaQuery } from "../lib/useMediaQuery";
import { onRoutePop, parseRoute, writeRoute } from "../lib/route";
import { formatAired } from "../lib/format";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { ShowInfo } from "./ShowInfo";
import { useSeriesDrawer } from "../lib/useSeriesDrawer";
import { CoverageStrip } from "./CoverageStrip";
import { RecordingPill } from "./RecordingPill";
import { loadResume, saveResume, resumeKey } from "../lib/resume";
import {
  cardArt, coverageOf, isIncomplete, isPlayable, isRecording, recordedSpan,
  resumeFor, strippedTime, watchedSpan,
} from "../lib/recording";

/**
 * Whether an offline copy can be made.
 *
 * Unlike playback this really does need a finished recording: caching copies
 * the whole thing, and the whole thing does not exist yet.
 */
function isKeepable(rec: Recording): boolean {
  if (rec.offline_only) return true;
  return rec.state !== "recording" && !rec.error;
}

/**
 * How far playback must move before the device is told again, in seconds.
 *
 * Measured from the device's own app, which writes every ~7.5 seconds of media
 * progress rather than on a clock: nine consecutive writes each moved the
 * position 5-9s while the wall gaps between them ran from 11.6s to 16.4s.
 * Spacing ours by progress rather than by time is what makes a paused player
 * write nothing at all.
 */
const DEVICE_POSITION_STEP = 7;

/**
 * Which point a card asked the player to open at.
 *
 * "resume" is every ordinary case — the saved position, or the start if there
 * is none. The other two exist only for a recording in progress, where "the
 * start" and "what is happening now" are genuinely different places and the
 * card offers both rather than guessing.
 */
/**
 * Where a recording opens.
 *
 * "at" is a point the viewer pointed to on the coverage strip — neither where
 * they left off nor the beginning, but the frame they were looking at.
 */
type StartMode = "resume" | "beginning" | "live" | "at";

/**
 * Why the card can say how far along something still recording is.
 *
 * Worth spelling out on hover, because it is the one number here that is not
 * simply reported: the device gives the start and the expected length, and the
 * elapsed part assumes recording has run without interruption since.
 */
function progressTitle(rec: Recording): string {
  const began = rec.recording_started
    ? new Date(rec.recording_started).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
  const total = rec.expected_seconds || rec.duration;
  return [
    rec.duration ? `Bar spans the scheduled ${formatDuration(rec.duration)}.` : null,
    began ? `Recording began at ${began}.` : null,
    total ? `Expected to capture ${formatDuration(total)} of it.` : null,
    "Elapsed time is derived from that start, not measured from the file.",
  ].filter(Boolean).join(" ");
}

/** A position as `12:20`, or `1:02:20` past the hour. */
function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/**
 * Runtime as `3h 35m`.
 *
 * Lowercase deliberately, and rendered without the uppercasing applied to the
 * rest of that line: `3H 35M` sitting beside a transfer rate reads as megabytes
 * when it means minutes.
 */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The heading colour for the day `iso` falls on, as a live token reference.
 *
 * Deliberately not `dayColor` from lib/format, which returns a fixed hex tuned
 * for the dark page — every one of those pastels drops under 3:1 on the light
 * one. `--c-day-0`…`--c-day-6` carry a legible rung per theme, so the heading
 * reads the variable and follows the theme with no second code path and no
 * `dark:` variant. Indexed by `Date.getDay()`, Sunday first, as the tokens are.
 *
 * `alpha` is passed through the slash form rather than concatenated as hex
 * digits: `rgb(...)` has no two-character alpha suffix to append.
 */
/** What each stored layout preference is allowed to be — the menus themselves. */
const GROUP_IDS = LIBRARY_GROUPS.map(g => g.id);
const SORT_IDS = LIBRARY_SORTS.map(s => s.id);
const LAYOUT_IDS = LIBRARY_LAYOUTS.map(l => l.id);

function dayTint(iso: string, alpha?: number): string {
  const d = new Date(iso);
  const day = Number.isNaN(d.getTime()) ? 0 : d.getDay();
  return alpha === undefined
    ? `rgb(var(--c-day-${day}))`
    : `rgb(var(--c-day-${day}) / ${alpha})`;
}

export function LibraryView() {
  // Opening the series behind a recording, from its sheet.
  const { openSeries, drawer: seriesDrawer } = useSeriesDrawer();
  const [playing, setPlaying] = useState<Recording | null>(null);
  /** Which entry point the card asked for; only in-progress recordings ask. */
  const [startMode, setStartMode] = useState<StartMode>("resume");
  /** Seconds the strip was clicked at, for `startMode === "at"`. */
  const [startAt, setStartAt] = useState(0);
  /** The recording whose information sheet is open, if any. */
  const [infoFor, setInfoFor] = useState<Recording | null>(null);
  const [initialRoute] = useState(parseRoute);
  const [restoreDone, setRestoreDone] = useState(false);
  const positionRef = useRef(0);
  /** Position last written to the device, so writes are spaced by progress. */
  const devicePositionRef = useRef(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const playingRef = useRef<Recording | null>(null);
  /**
   * The toolbar's two controls.
   *
   * Deliberately not in the URL. The header's search is a route — it names a
   * results page anyone can link to — where these two narrow a page already
   * open, and survive nothing but the scroll.
   */
  const [query, setQuery] = useState("");
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
  /**
   * Whether the filter is a field or an icon, and the width that decides.
   *
   * Only below 640px is there a choice to make: above it the field, the
   * content filter and the two menus all fit the row, and an icon that has to
   * be opened would be a step where there was none.
   */
  const phone = useMediaQuery("(max-width: 639px)");
  const [filterExpanded, setFilterExpanded] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);

  /** Give the row back, dropping the query with it. */
  const collapseFilter = useCallback(() => {
    setFilterExpanded(false);
    setQuery("");
  }, []);

  // Focus follows the expansion: tapping the icon should put the caret in the
  // field, not merely reveal it. An effect rather than `autoFocus`, which only
  // fires on mount and would do nothing the second time it is opened.
  useEffect(() => {
    if (filterExpanded) filterInputRef.current?.focus();
  }, [filterExpanded]);

  // Widening the window while the field is open would otherwise leave the row
  // carrying a close button it no longer needs.
  useEffect(() => {
    if (!phone) setFilterExpanded(false);
  }, [phone]);
  /**
   * How the page is laid out, which — unlike the two above — is remembered.
   *
   * A search and a content filter are momentary: they answer "show me this,
   * now", and restoring them tomorrow would open the Library on a question
   * nobody asked. Grouping and order are how this person reads the page, and
   * having to set them again every visit is the kind of small tax that makes a
   * setting feel like it does not work. Kept server-side rather than in this
   * browser's storage, so the answer follows the viewer between machines.
   */
  const [groupBy, setGroupBy] = usePref<LibraryGroup>(
    "library.group", "day", GROUP_IDS);
  const [sortBy, setSortBy] = usePref<LibrarySort>(
    "library.sort", "newest", SORT_IDS);
  /**
   * Cards or rows.
   *
   * Cards is the fallback because cards is what this page has always been, and
   * because it is the answer that is never wrong: a first paint in the layout
   * someone did not choose is a worse greeting than one in the layout everyone
   * knows.
   */
  const [layout, setLayout] = usePref<LibraryLayout>(
    "library.layout", "cards", LAYOUT_IDS);

  const qc = useQueryClient();

  const { data: storage } = useQuery({
    queryKey: ["recordings-storage"],
    queryFn: () => api.storage(),
    refetchInterval: 15_000,
  });

  const control = useMutation<unknown, Error, { id: number; action: "pause" | "resume" | "delete" | "cancel" }>({
    mutationFn: ({ id, action }) =>
      action === "pause" ? api.pauseKeep(id)
        : action === "resume" ? api.resumeKeep(id)
        : action === "cancel" ? api.cancelKeep(id)
        : api.deleteRecordingCache(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["recordings-storage"] });
    },
  });

  const keep = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) =>
      on ? api.keepRecording(id) : api.unkeepRecording(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["recordings"] });
      qc.invalidateQueries({ queryKey: ["recordings-storage"] });
    },
  });

  /**
   * Which frame a card leads with, chosen from its strip.
   *
   * The picture is served by the thumbnail route, so nothing here needs the
   * image itself — only the position, and a re-read so every card that shows
   * this recording picks the new one up.
   */
  const pickCover = useMutation({
    mutationFn: ({ id, t }: { id: number; t: number }) => api.setRecordingCover(id, t),
    onSettled: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
  });

  // The "remove custom picture" control lives at the top-middle of the picture,
  // revealed on image hover only (not the whole card) and only when a custom
  // cover exists. Round = action, so it is a puck like the watched/protect
  // toggles, not a squarish status chip.
  const clearCover = useMutation({
    mutationFn: (id: number) => api.clearRecordingCover(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
  });

  /**
   * Watched / protected toggles, optimistic against the cached listing.
   *
   * The status is the whole point of the icon, so it flips at once and the
   * device write follows; a refusal rolls the row back and the trailing
   * invalidation reconciles with the truth. Both write the same way — one row
   * of `["recordings"]` patched by `object_id`.
   */
  const patchRow = useCallback(
    (id: number, patch: Partial<Recording>) => {
      qc.setQueryData<RecordingList>(["recordings"], (held) =>
        held
          ? {
              ...held,
              recordings: held.recordings.map((r) =>
                r.object_id === id ? { ...r, ...patch } : r,
              ),
            }
          : held,
      );
    },
    [qc],
  );

  /**
   * Marking watched and un-marking are asymmetric because of how the device
   * stores it (measured on-device):
   *   - `{watched:true}`  sets watched AND forces `position` to 0.
   *   - `{position:>0}`    sets the position AND clears `watched`.
   *   - `{watched:false}` clears watched but leaves position — so un-marking a
   *     watched recording (whose position the device already reset to 0) would
   *     read as **New** (position 0, not watched).
   * To un-mark without it flashing back to New, we write `position:1` instead:
   * that clears watched and lands it at "seen / in progress", never New. See
   * docs/tablo-api.md.
   */
  const markWatched = useMutation({
    mutationFn: (id: number) => api.setRecordingWatched(id, true),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["recordings"] });
      const prev = qc.getQueryData<RecordingList>(["recordings"]);
      patchRow(id, { watched: true, position: 0 });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["recordings"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
  });

  const markUnwatched = useMutation({
    mutationFn: (id: number) => api.setRecordingPosition(id, 1),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["recordings"] });
      const prev = qc.getQueryData<RecordingList>(["recordings"]);
      patchRow(id, { watched: false, position: 1 });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["recordings"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
  });

  const setProtect = useMutation({
    mutationFn: ({ id, protectedFlag }: { id: number; protectedFlag: boolean }) =>
      api.setProtected(id, protectedFlag),
    onMutate: async ({ id, protectedFlag }) => {
      await qc.cancelQueries({ queryKey: ["recordings"] });
      const prev = qc.getQueryData<RecordingList>(["recordings"]);
      patchRow(id, { protected: protectedFlag });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["recordings"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["recordings"] }),
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["recordings"],
    queryFn: () => api.recordings(),
    staleTime: 5 * 60_000,
    // A refetch re-renders this component, which used to reload the player.
    // That is fixed in VideoPlayer, but there is no reason to churn mid-watch.
    refetchOnWindowFocus: false,
    // Poll quickly while a copy is being made so progress actually moves;
    // back off once nothing is in flight.
    //
    // Something still recording is the other reason to keep looking: its
    // progress comes from the server, so the card is only ever as current as
    // the last poll. Fifteen seconds rather than four - a bar creeping across
    // an hour does not need the cadence a download does, and this is the whole
    // recordings list.
    refetchInterval: (q) => {
      const rows = q.state.data?.recordings ?? [];
      const copying = rows.some(r => r.pinned && !r.paused && r.cache_state !== "complete");
      if (copying) return 4_000;
      return rows.some(isRecording) ? 15_000 : 30_000;
    },
  });

  const recordings = useMemo(() => data?.recordings ?? [], [data]);
  const truncated = data ? data.total > data.returned : false;

  /**
   * The recordings left after the toolbar has had its say.
   *
   * Filtered here rather than in `days` so the grid below can tell a library
   * with nothing in it from one where nothing matches — two different things
   * to say, and the day groups alone cannot tell them apart.
   *
   * The search is local, over what the listing already returned: a Library is
   * a few hundred rows in hand, so typing filters them instantly and without a
   * round trip. Title, episode and blurb, because an episode is as often
   * remembered by what it was about as by what it was called.
   */
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recordings.filter(rec => {
      if (!recordingMatchesFilter(rec, contentFilter)) return false;
      if (!needle) return true;
      return [rec.title, rec.subtitle, rec.description]
        .some(field => field?.toLowerCase().includes(needle));
    });
  }, [recordings, query, contentFilter]);

  /**
   * The cards under their headings, in the order the toolbar asked for.
   *
   * A flat wall of cards gave no sense of when anything was recorded, which is
   * why the headings exist at all; what they say is now a choice. The rules
   * live in `libraryLayout` — see `arrange` for why the sort orders the
   * sections as well as the cards inside them.
   */
  const sections = useMemo(
    () => arrange(shown, groupBy, sortBy),
    [shown, groupBy, sortBy],
  );

  // A recording named in the URL reopens as soon as the list contains it.
  // Derived rather than assigned from an effect, which would cascade renders.
  const routeWatch = initialRoute.watch;
  const restoredRecording =
    !restoreDone && !playing && routeWatch?.kind === "recording"
      // Guarded: a URL could name a recording that cannot be played.
      ? recordings.find(r => r.object_id === routeWatch.id && isPlayable(r)) ?? null
      : null;
  const nowPlaying = playing ?? restoredRecording;

  // Read the resume point ONCE per recording. Reading it on every render fed
  // the continuously-saved position back into the player's startPosition, which
  // changed its identity and tore the player down — every clock tick caused a
  // reload and a jump backwards.
  const resumeAt = useMemo(
    () => (nowPlaying ? loadResume(resumeKey("recording", nowPlaying.object_id)) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nowPlaying?.object_id],
  );

  /**
   * Where to open, once the card has been asked.
   *
   * Only a recording in progress has a choice to make, and only then does the
   * card ask: everything else resumes where it was left, which is what the
   * saved position is for. `LIVE_EDGE` defers the decision to the player, which
   * is the only thing that knows how much exists by the time the stream opens.
   */
  const openAt = startMode === "live" ? LIVE_EDGE
    : startMode === "beginning" ? 0
    : startMode === "at" ? startAt
    : resumeAt;

  useEffect(() => {
    playingRef.current = nowPlaying;
    if (!nowPlaying) positionRef.current = 0;
    writeRoute({
      tab: "library",
      watch: nowPlaying ? { kind: "recording", id: nowPlaying.object_id } : null,
    });
  }, [nowPlaying]);

  /**
   * Push the playhead to the device, spaced by how far playback has moved.
   *
   * Measured from the device's own app: it writes every ~7.5 seconds of *media*
   * progress, not on a wall clock — nine consecutive writes moved the position
   * 5-9s each while the wall gaps between them varied from 11.6s to 16.4s.
   *
   * Matching the unit is what makes this self-throttling: a paused player makes
   * no progress and so writes nothing, and buffering or slow playback space the
   * writes out for free. No timer to tune, and no thundering herd to jitter
   * against, because the spacing is the viewer's own progress.
   */
  const writeDevicePosition = useCallback((rec: Recording, seconds: number) => {
    if (Math.abs(seconds - devicePositionRef.current) < DEVICE_POSITION_STEP) return;
    devicePositionRef.current = seconds;
    api.setRecordingPosition(rec.object_id, seconds).catch(() => {
      // A lost position is a small annoyance; the next write carries it.
    });
  }, []);

  /**
   * Write the playhead now, whatever the spacing rule says.
   *
   * Almost every session ends deliberately — closing, pausing, seeking — so
   * these carry the common case exactly and the progress rule only has to cover
   * the browser being killed. A seek especially: waiting for seven more seconds
   * of progress after a discontinuity would leave the device holding a position
   * that is wrong rather than merely stale.
   */
  const flushDevicePosition = useCallback(() => {
    const rec = playingRef.current;
    const at = Math.floor(positionRef.current);
    if (!rec || at <= 0 || at === devicePositionRef.current) return;
    devicePositionRef.current = at;
    api.setRecordingPosition(rec.object_id, at).catch(() => {});
  }, []);

  const closePlayer = useCallback(() => {
    flushDevicePosition();
    setPlaying(null);
    setRestoreDone(true);
  }, [flushDevicePosition]);

  // Back out of a player means Escape, the same as it does on the guide side.
  useEffect(() => onRoutePop((route) => {
    if (!route.watch) closePlayer();
  }), [closePlayer]);

  // Persist the playhead locally. Throttled to whole seconds; the URL is left
  // alone so it stays a stable reference to the recording.
  const handlePosition = useCallback((seconds: number) => {
    const whole = Math.floor(seconds);
    if (whole === Math.floor(positionRef.current)) return;
    positionRef.current = whole;
    const rec = playingRef.current;
    if (!rec) return;
    saveResume(resumeKey("recording", rec.object_id), whole, rec.duration);
    writeDevicePosition(rec, whole);
  }, []);

  /**
   * The DVR readout, as one node rendered in one of two places.
   *
   * Normally it rides the first day heading's rule; with no days it falls back
   * to a row of its own. Built once here so the two sites cannot drift.
   */
  const storageLine = (truncated || storage) ? (
    <span className="flex items-center gap-4 whitespace-nowrap text-[11px] uppercase tracking-widest text-fg-muted">
      {truncated && <span>Showing {data!.returned} of {data!.total}</span>}
      {storage && (
        <span>
          {formatBytes(storage.pinned_bytes)} kept
          {storage.pinned_count > 0 && ` (${storage.pinned_count})`}
          {" · "}{formatBytes(storage.cache_bytes)} cache
          {" · "}{formatBytes(storage.free_bytes)} free
        </span>
      )}
    </span>
  ) : null;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-48 gap-4">
        <div className="w-12 h-12 rounded-full border-4 border-accent border-t-transparent animate-spin" />
        <p className="text-fg-muted text-sm font-medium uppercase tracking-widest">Accessing Library...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-48 gap-6 text-center">
        <p className="text-danger font-bold">Failed to load recordings</p>
        <button onClick={() => refetch()} className="px-6 py-2 rounded-xl glass text-sm hover:bg-fill-soft transition">
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />

      {/* No channel gate any more. The sheet used to be keyed by the airing,
          so a recording with no channel identifier had nothing to open; it
          asks the device about the recording now, and answers for an offline
          copy of something the Tablo has since deleted from its own snapshot.
          Without an identifier there is simply no airing to look up. */}
      {infoFor && (
        <ShowInfo
          channel={infoFor.channel?.identifier ?? ""}
          start={infoFor.channel?.identifier ? infoFor.start : null}
          channelLabel={infoFor.channel?.call_sign ?? undefined}
          // The sheet shows the SAME image the card resolved — a viewer-picked
          // cover, else this episode's own snapshot, else the series art — so
          // it never falls back to the generic series cover and shows a
          // different picture than the card the viewer just tapped.
          posterOverride={cardArt(infoFor)}
          // This card's recording, not the airing's newest: a capture stopped
          // and restarted leaves two against one slot, and the sheet must
          // delete the one whose card was opened.
          recordingId={infoFor.object_id}
          onOpenSeries={(guidePath, title) => {
            setInfoFor(null);
            void openSeries(guidePath, title);
          }}
          onClose={() => setInfoFor(null)}
          // The row goes on the same beat as the sheet, before the device has
          // answered: re-reading the listing costs a round trip of its own, and
          // a card still sitting there afterwards reads as a delete that did
          // not work.
          //
          // Spliced out of the cached listing rather than refetched, then
          // reconciled by the invalidation that follows - which also corrects
          // the totals this cannot honestly guess at.
          onDeleted={(objectId) => {
            qc.setQueryData(["recordings"], (held?: RecordingList) => (
              held
                ? { ...held,
                    recordings: held.recordings.filter((r) => r.object_id !== objectId),
                    returned: Math.max(0, held.returned - 1),
                    total: Math.max(0, held.total - 1) }
                : held
            ));
          }}
          // Only once the Tablo has actually done it. Re-reading alongside the
          // delete reads the library before the delete lands and puts the card
          // straight back, where it sits until the next poll - measured at 515ms
          // for the listing against 597ms for the delete, and a card that
          // returned for the rest of the interval.
          onDeleteConfirmed={() => {
            qc.invalidateQueries({ queryKey: ["recordings"] });
            qc.invalidateQueries({ queryKey: ["recordings-storage"] });
          }}
          // It is still there after all, so put it back and say why. The sheet
          // that asked has gone, so this is the only place left to say it.
          onDeleteFailed={(_objectId, message) => {
            qc.invalidateQueries({ queryKey: ["recordings"] });
            setConfirmation({
              title: "The recording was not deleted.",
              body: message,
              confirmLabel: "OK",
              onConfirm: () => {},
            });
          }}
          // "Watch Live" only renders while the airing is actually on, which
          // for the Library means a recording still being written. Its live
          // edge is the same pictures, and we already hold them — so this
          // plays the recording there rather than tuning a second stream.
          // This view owns a player, so it plays in place rather than routing
          // to itself. "resume" is the ordinary entry point: the saved
          // position, or the start when there is none.
          onWatchRecording={() => {
            setStartMode("resume");
            setPlaying(infoFor);
            setInfoFor(null);
          }}
          onTune={() => { setStartMode("live"); setPlaying(infoFor); setInfoFor(null); }}
        />
      )}

      {/* The series panel, when the sheet sent us to one. */}
      {seriesDrawer}

      {nowPlaying && (
        <VideoPlayer
          key={nowPlaying.object_id}
          source={{ kind: "recording", recording: nowPlaying }}
          // Restored from a URL: resume at the saved point, paused, so audio is
          // not blocked by the missing user activation on a fresh page load.
          // Resume where this recording was left, whether opened fresh or
          // restored by a refresh. Only a refresh starts paused — a reload
          // carries no user activation, so autoplay would be forced to mute.
          startAt={openAt}
          autoPlay={Boolean(playing)}
          onPosition={handlePosition}
          onClose={closePlayer}
          // Picked from the card at the end of the last one. From its
          // beginning, not from a resume point: an episode reached this way is
          // being started, and offering it where someone once abandoned it is
          // a different thing entirely.
          onPlayRecording={(rec) => { setStartMode("beginning"); setPlaying(rec); }}
        />
      )}

      {/* Above the first day's rule, because it narrows every day below it and
          not the one it sits over.

          The field and the menu, in that order, and sized so the pair reads as
          one control: the field takes the room it can up to `max-w-sm` — the
          same ceiling the header's search uses — and the menu keeps its
          natural width beside it. `flex-wrap` so the menu drops under the field
          at phone width rather than squeezing it to nothing. */}
      <div data-library-toolbar className="flex flex-wrap items-center gap-3 mb-4">
        {/* Closed on a phone, the field is an icon at the head of the row —
            the same move the topbar search makes, and for the same reason: a
            full-width field, the content filter and two menus cannot share a
            400px row, and the field is the one of them that is empty most of
            the time.

            Hidden rather than unmounted: the input's value IS the filter, and
            unmounting it would drop the query every time the row narrowed. */}
        {phone && !filterExpanded && (
          <button
            onClick={() => setFilterExpanded(true)}
            aria-label="Filter recordings"
            aria-expanded={false}
            className="touch-target shrink-0 flex items-center justify-center p-2.5 rounded-xl
                       bg-fill-soft border border-border-subtle text-fg-muted
                       hover:text-fg-secondary hover:bg-fill transition
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Funnel className="w-4 h-4" aria-hidden />
          </button>
        )}
        <div className={`relative flex-1 min-w-48 max-w-sm
                         ${phone && !filterExpanded ? "hidden" : ""}`}>
          {/* A funnel, not a spyglass: this narrows what is already here,
              where the topbar's spyglass goes and finds things. Two controls
              on one screen wearing the same icon read as the same control. */}
          <Funnel className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-muted" aria-hidden />
          <input
            ref={filterInputRef}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            // Escape clears rather than blurs: the field holds the only thing
            // standing between the viewer and the whole library, so the way
            // out of it should be the way back to everything. On a phone the
            // field IS the row, so one Escape gives the row back too.
            onKeyDown={e => {
              if (e.key !== "Escape") return;
              if (phone && filterExpanded) collapseFilter(); else setQuery("");
            }}
            placeholder="Filter recordings..."
            aria-label="Filter recordings"
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-fill-soft border border-border-subtle
                       text-sm placeholder-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent
                       focus:bg-fill transition shadow-inner"
          />
        </div>
        {/* The way back to the row. Dropping the query with it: a filter left
            behind an icon is a library missing recordings for no reason
            anyone can see. */}
        {phone && filterExpanded && (
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={collapseFilter}
            aria-label="Close filter"
            className="touch-target shrink-0 flex items-center justify-center p-2.5 rounded-xl
                       text-fg-muted hover:text-fg-secondary hover:bg-fill-soft transition
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        )}
        <ContentFilterMenu value={contentFilter} onChange={setContentFilter} />

        {/* What narrows the page on the left, what arranges it on the right.
            `ml-auto` puts the pair against the right edge on a wide window and
            simply starts the line when the row has wrapped, so they stay
            together either way rather than drifting apart as it narrows. */}
        <div data-layout-menus className="ml-auto flex items-center gap-2">
          {/* The words go before anything else does as the row narrows: the
              icons say which menu is which, and the value is the part being
              read. The accessible name keeps saying "Group by", since a
              screen reader has no icon to go on. */}
          <OptionMenu
            label="Group by"
            prefix={phone ? undefined : "Group"}
            options={LIBRARY_GROUPS}
            value={groupBy}
            onChange={setGroupBy}
            align="right"
          />
          <OptionMenu
            label="Sort by"
            prefix={phone ? undefined : "Sort"}
            options={LIBRARY_SORTS}
            value={sortBy}
            onChange={setSortBy}
            align="right"
          />
          {/* Last in the cluster, and the only one here without words on it:
              what the page is arranged by is a question, where cards-or-rows
              is a switch. */}
          <LayoutToggle value={layout} onChange={setLayout} />
        </div>
      </div>

      {/* With no sections to hang it on there is no rule to sit on either, so
          the readout falls back to a row of its own. Without this an empty
          library would drop it entirely — and an empty library is exactly when
          "106.9 GB free" is worth reading. */}
      {sections.length === 0 && storageLine && (
        <div className="flex items-center justify-end mb-3">{storageLine}</div>
      )}

      {/* The layouts differ in the container and in what one recording is
          drawn as. The headings, the storage readout and both empty states are
          written once and serve either: they are the page's landmarks, and a
          landmark that moves when the layout changes is not one.

          `col-span-full` on the heading and the empty states means nothing in
          a flex column, which is why it can stay on both paths rather than
          becoming a third conditional. */}
      <div
        className={layout === "list" ? "flex flex-col" : "grid gap-6"}
        style={layout === "list" ? undefined : {
          // `min(280px, 100%)` — a floor wider than the container overflows
          // rather than shrinking, and that overflow scrolls the page
          // sideways. Same guard as the Live grid's.
          gridTemplateColumns: "repeat(auto-fill, minmax(min(280px, 100%), 1fr))",
        }}
      >
        {recordings.length === 0 ? (
          <div className="col-span-full py-48 text-center bg-fill-soft rounded-3xl border border-border-subtle">
            <p className="text-fg-muted font-black tracking-widest uppercase">No Recordings Found</p>
          </div>
        ) : shown.length === 0 ? (
          /* A library that holds things and a toolbar that finds none of them
             are two different states, and one message for both reads as "your
             recordings are gone". This one says what to undo, and offers it. */
          <div className="col-span-full py-48 flex flex-col items-center gap-4 text-center bg-fill-soft rounded-3xl border border-border-subtle">
            <p className="text-fg-muted font-black tracking-widest uppercase">
              Nothing Matches
            </p>
            <button
              onClick={() => { setQuery(""); setContentFilter("all"); }}
              className="touch-target px-4 py-2 rounded-xl glass text-xs font-bold uppercase
                         tracking-widest text-fg-muted hover:text-fg hover:bg-fill transition"
            >
              Clear filters
            </button>
          </div>
        ) : (
          sections.map(({ key, label, tintFrom, items }, sectionIndex) => (
            <Fragment key={key}>
              {/* What these have in common — a day, a show, a station — with a
                  rule under it, so the cards below read as one group.

                  A day is drawn in that weekday's colour, which is the one
                  grouping where a colour means something: every card under
                  "MONDAY 9/21" aired that day. A show or a channel spans weeks,
                  so it takes the plain foreground rather than a colour picked
                  from whichever card happened to come first.

                  The first heading also carries the storage readout, at the far
                  end of the rule. The rule already runs the width of the grid
                  and fades out on the way, so the right end is space this row
                  was spending on nothing. It is rendered here rather than owned
                  by the group: these are page totals, and they would be a lie
                  if read as belonging to Monday. `flex-wrap` so it drops to its
                  own line at phone width instead of crushing the rule. */}
              <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 first:pt-0">
                <span
                  data-library-heading
                  className="text-[11px] font-black uppercase tracking-widest whitespace-nowrap"
                  style={tintFrom ? { color: dayTint(tintFrom) } : undefined}
                >
                  {label}
                </span>
                <span
                  className="h-px flex-1 min-w-8 rounded-full"
                  style={{
                    background: `linear-gradient(to right, ${
                      tintFrom ? dayTint(tintFrom, 0.5) : "rgb(var(--c-border))"
                    }, transparent)`,
                  }}
                />
                {sectionIndex === 0 && storageLine}
              </div>

              {items.map((rec) => {
            // The row carries its own everything: it is given the recording and
            // the two things a row can do, and the sheet behind the ⋮ holds the
            // rest. Nothing below this line applies to it.
            if (layout === "list") {
              return (
                <RecordingRow
                  key={rec.object_id}
                  rec={rec}
                  onPlay={() => { setStartMode("resume"); setPlaying(rec); }}
                  onInfo={() => setInfoFor(rec)}
                />
              );
            }
            const playable = isPlayable(rec);
            const keepable = isKeepable(rec);
            // Coverage is worth drawing whether or not it is still recording:
            // three recordings on one device captured seconds of an hour, and
            // the device called none of them an error.
            const span = recordedSpan(coverageOf(rec));
            const broken = !isRecording(rec) && isIncomplete(coverageOf(rec));
            // How far in the viewer is, over the top of what exists. Read here
            // rather than inside the strip so the title can name the position.
            const watchedAt = resumeFor(rec);
            const watched = watchedSpan(coverageOf(rec), watchedAt);
            return (
              <div
                key={rec.object_id}
                className="group flex flex-col bg-surface-raised border border-border rounded-2xl overflow-hidden hover:border-accent/40 transition shadow-lg"
              >
                {/* A div, not a button: a recording in progress puts two
                    buttons inside this, and a button inside a button is
                    invalid and unreachable by keyboard. The ordinary case
                    keeps its full-bleed button below, so nothing changes for
                    it — the whole picture is still the target. */}
                {/* `overflow-hidden` is not decoration here, and neither is the
                    absolute positioning on the picture inside.

                    `aspect-video` states a *preferred* ratio, and a block's
                    automatic minimum size lets content override it - so a 4:3
                    picture grew the well to 4:3 and pushed the title down with
                    it. Only frames from SD recordings did, the pack being
                    320x240 for those and 320x180 for everything else, which is
                    what made it look arbitrary: the same card was 16:9 with its
                    artwork and 4:3 the moment a frame was chosen for it. */}
                <div className="group/art aspect-video bg-surface-sunken relative block w-full
                                overflow-hidden">
                  {/* The show's own artwork, the way the schedule's info box
                      resolves it — the airing's picture, else the series
                      cover. A frame from the recording is the floor rather
                      than the default: it is a grab from the middle of a
                      capture, and on plenty of programmes that is a caption
                      card or somebody's back.

                      A frame the viewer picked comes through `thumbnail`,
                      which serves it: their choice outranks the artwork. */}
                  {cardArt(rec) ? (
                    <img
                      src={cardArt(rec)!}
                      alt=""
                      // `fill`, not `cover`. The artwork is already 16:9 so
                      // either behaves the same on it — but a frame from the
                      // recording is anamorphic, a 16:9 picture in a 4:3 grid
                      // with non-square pixels, and cropping one to fit takes
                      // an eighth off the top and bottom instead of
                      // un-squeezing it.
                      // Absolute, so the picture cannot size the well it sits
                      // in — an out-of-flow box contributes nothing to its
                      // parent's height, which is what makes `aspect-video`
                      // above hold whatever shape the frame happens to be.
                      className={`absolute inset-0 w-full h-full object-fill transition-opacity
                                  ${rec.watched ? "opacity-[0.55]" : ""}`}
                      loading="lazy"
                      // A card whose artwork link is dead falls back to the
                      // frame it still has, rather than showing the empty box.
                      //
                      // Compared as resolved URLs. `img.src` reads back
                      // absolute and `rec.thumbnail` is a path, so comparing
                      // them directly never matched - the fallback reassigned
                      // the same address forever, an error loop that also
                      // fetched the un-keyed thumbnail URL and cached a
                      // snapshot there for a day.
                      onError={(e) => {
                        const img = e.currentTarget;
                        if (!rec.thumbnail) return;
                        const fallback = new URL(rec.thumbnail, location.href).href;
                        if (img.src !== fallback) img.src = fallback;
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-tint/10 uppercase font-black text-xl italic">
                      Tablo
                    </div>
                  )}
                  {(() => {
                    // Resuming, starting over and jumping to the frontier are
                    // three different intentions. Which exist depends on the
                    // recording: only one still being written has a frontier,
                    // and only one already watched has somewhere to resume to.
                    // `loadResume` already ignores the first thirty seconds and
                    // the last minute, so an offer to resume always means one.
                    const at = resumeFor(rec);
                    const live = isRecording(rec);

                    // Nothing to choose between: the whole picture is the
                    // button, as it has always been.
                    if (!at && !live) {
                      return (
                        <button
                          onClick={() => { setStartMode("resume"); setPlaying(rec); }}
                          disabled={!playable}
                          className="absolute inset-0 flex items-center justify-center bg-scrim-soft
                                     opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition
                                     disabled:cursor-not-allowed w-full"
                          aria-label={`Play ${rec.title ?? "recording"}`}
                        >
                          {/* The mark answers its own hover — it grows, lifts
                              and brightens — while the press belongs to the
                              whole artwork: clicking the picture and clicking
                              the puck are the same act, so they look the same. */}
                          <div className="accent-gradient w-14 h-14 rounded-full flex items-center justify-center
                                          shadow-lg hover:scale-110 hover:shadow-2xl hover:brightness-110
                                          group-active/art:scale-95 transition-all duration-150">
                            <Play className="w-6 h-6 text-brand-fg ml-0.5" fill="currentColor" aria-hidden />
                          </div>
                        </button>
                      );
                    }

                    const chip = "flex items-center gap-2 pl-3 pr-4 h-10 rounded-full text-xs font-bold"
                      + " shadow-lg hover:scale-105 active:scale-95 transition-all duration-150";
                    return (
                      // `py-10` keeps the button stack clear of the top badge
                      // row and the bottom progress/time row — the top chip used
                      // to butt right against the CACHED/offline cluster — while
                      // leaving room for all three chips (Live/Resume/From start).
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 py-10
                                      bg-scrim-soft opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
                        {/* Order top-to-bottom: Live (the frontier of what is
                            recording now), Resume (where you left off), From
                            start. Resume still carries the accent when it
                            exists, else From start does. */}
                        {live && (
                          <button
                            onClick={() => { setStartMode("live"); setPlaying(rec); }}
                            className={`${chip} glass text-media-fg hover:bg-fill`}
                            title="Jump to what is being recorded right now"
                          >
                            <Radio className="w-4 h-4" aria-hidden />
                            Live
                          </button>
                        )}
                        {at > 0 && (
                          <button
                            onClick={() => { setStartMode("resume"); setPlaying(rec); }}
                            className={`${chip} accent-gradient text-brand-fg hover:shadow-2xl hover:brightness-110`}
                          >
                            <Play className="w-4 h-4" fill="currentColor" aria-hidden />
                            Resume {formatClock(at)}
                          </button>
                        )}
                        <button
                          onClick={() => { setStartMode("beginning"); setPlaying(rec); }}
                          className={at > 0
                            ? `${chip} glass text-media-fg hover:bg-fill`
                            : `${chip} accent-gradient text-brand-fg hover:shadow-2xl hover:brightness-110`}
                        >
                          <Play className="w-4 h-4" fill="currentColor" aria-hidden />
                          From start
                        </button>
                      </div>
                    );
                  })()}

                  {/* Top-left cluster: the single state badge, with the
                      "Only here" offline badge beside it (moved here from the
                      top-right, which the watched/protect controls now own).
                      Recording wins the state slot outright — nothing a card can
                      say matters as much as the fact that it is still growing,
                      and the cache badges cannot apply anyway, since keeping a
                      copy needs a finished recording. */}
                  <div className="absolute top-3 left-3 flex items-start gap-1.5">
                    {isRecording(rec) ? (
                      <RecordingPill />
                    ) : broken ? (
                      // Four seconds of an hour is not a short recording, it is a
                      // broken one. The device does not agree - `error` is null
                      // and `warnings` empty on all three measured failures - so
                      // this is inferred from how little of the slot exists, and
                      // said out loud rather than left to a sliver on the strip.
                      <div className="flex items-center gap-1 px-2 py-1 rounded bg-warning-solid text-[10px] font-bold text-warning-fg uppercase tracking-wider"
                           title="Only a fraction of the scheduled programme was captured.">
                        <AlertTriangle className="w-3 h-3" aria-hidden />
                        Incomplete
                      </div>
                    ) : rec.pinned ? (
                      <div className="flex items-center gap-1 px-2 py-1 rounded bg-success-solid text-[10px] font-bold text-success-fg uppercase tracking-wider">
                        <CheckCircle2 className="w-3 h-3" aria-hidden />
                        {rec.cache_state === "complete" ? "Cached" : `${Math.round(rec.cache_progress * 100)}%`}
                      </div>
                    ) : rec.cache_state === "complete" ? (
                      <div className="px-2 py-1 rounded bg-accent text-[10px] font-bold text-accent-fg uppercase tracking-wider">
                        Ready
                      </div>
                    ) : rec.cache_progress > 0 ? (
                      // Watching transcodes as it goes, so a recording nobody
                      // asked to keep is often substantially on disk already.
                      // Deliberately not emerald and without the tick: that badge
                      // means the copy is kept and outlives the Tablo deleting
                      // it, and an incidental cache makes no such promise. The
                      // colour carries the distinction now that both say cached.
                      <div className="px-2 py-1 rounded bg-ink/80 text-[10px] font-bold text-media-fg-muted uppercase tracking-wider tabular-nums"
                           title="Transcoded so far. Keep it offline to fill in the rest.">
                        {Math.max(1, Math.round(rec.cache_progress * 100))}% cached
                      </div>
                    ) : null}
                    {rec.offline_only && (
                      // Icon-only STATUS chip — squarish, the same box as the
                      // protected lock (px-1.5 py-1, w-3.5 icon). Round is for
                      // actions; this only reports that the copy is local, so it
                      // carries no text and matches the other status chips.
                      <div className="flex items-center px-1.5 py-1 rounded bg-ink/80 text-media-fg-muted"
                           title="Kept here — the Tablo no longer has this recording"
                           aria-label="Kept here — the Tablo no longer has this recording">
                        <CloudOff className="w-3.5 h-3.5" aria-hidden />
                      </div>
                    )}
                  </div>

                  {/* Top-right cluster: watched + protect TOGGLES. These are
                      hover-only controls (persistent state lives in the
                      bottom-left status cluster instead), revealed on hover
                      ANYWHERE on the card — `group-hover:` uses the card root's
                      `group`, not the picture's `group/art`. Watched left,
                      protect right. Each stops propagation so a tap toggles
                      rather than starting playback. Skipped while recording —
                      neither applies to a growing file. */}
                  {!isRecording(rec) && (
                    <div className="absolute top-3 right-3 flex items-center gap-1.5
                                    opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // Un-mark via position:1 (clears watched without New);
                          // mark via watched:true. See the mutations above.
                          if (rec.watched) markUnwatched.mutate(rec.object_id);
                          else markWatched.mutate(rec.object_id);
                        }}
                        title={rec.watched ? "Mark unwatched" : "Mark watched"}
                        aria-label={rec.watched ? "Mark unwatched" : "Mark watched"}
                        aria-pressed={rec.watched}
                        className="z-20 w-7 h-7 rounded-full glass flex items-center justify-center
                                   text-media-fg hover:bg-fill transition"
                      >
                        {rec.watched
                          ? <EyeOff className="w-3.5 h-3.5" aria-hidden />
                          : <Eye className="w-3.5 h-3.5" aria-hidden />}
                      </button>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setProtect.mutate({ id: rec.object_id, protectedFlag: !rec.protected });
                        }}
                        title={rec.protected ? "Remove protection" : "Protect from deletion"}
                        aria-label={rec.protected ? "Remove protection" : "Protect from deletion"}
                        aria-pressed={rec.protected}
                        className="z-20 w-7 h-7 rounded-full glass flex items-center justify-center
                                   text-media-fg hover:bg-fill transition"
                      >
                        {rec.protected
                          ? <LockOpen className="w-3.5 h-3.5" aria-hidden />
                          : <Lock className="w-3.5 h-3.5" aria-hidden />}
                      </button>
                    </div>
                  )}

                  {/* Clear-custom-image ACTION, top-middle of the picture.
                      Only rendered when a viewer-picked cover exists
                      (`cover_frame`), and revealed on hover of the PICTURE
                      alone — `group-hover/art:`, not the card's `group` — so it
                      does not crowd the whole-card hover controls. A round puck
                      like the toggles (round = action); stops propagation so a
                      tap clears the image rather than starting playback. */}
                  {rec.cover_frame !== null && (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        clearCover.mutate(rec.object_id);
                      }}
                      title="Remove custom image"
                      aria-label="Remove custom image"
                      className="absolute top-3 left-1/2 -translate-x-1/2 z-20 w-7 h-7 rounded-full
                                 glass flex items-center justify-center text-media-fg hover:bg-fill
                                 opacity-0 group-hover/art:opacity-100 focus-visible:opacity-100 transition"
                    >
                      <ImageOff className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  )}
                  {/* While recording, the slot is not what exists — it is what
                      is promised. Showing `1h 0m` on something eight minutes old
                      invited exactly the wrong expectation of the scrubber. */}
                  <div
                    className="absolute bottom-3 right-3 px-2 py-1 rounded bg-ink/80 text-[10px] font-bold text-media-fg tabular-nums"
                    title={isRecording(rec) ? progressTitle(rec) : undefined}
                  >
                    {isRecording(rec) && rec.recorded_seconds !== null
                      ? `${formatDuration(rec.recorded_seconds)} of `
                        + `${formatDuration(rec.expected_seconds || rec.duration)}`
                      : formatDuration(rec.duration)}
                  </div>

                  {/* Fill progress along the bottom edge — the corner badge
                      alone was too easy to miss. Shown for anything part-cached,
                      not only for kept copies, so the bar and the badge above
                      never disagree about whether there is work on disk. */}
                  {/* The strip is the scheduled slot, widened to hold anything
                      captured outside it, and the filled part is what actually
                      exists — positioned where it falls, not flush left. A
                      recording that started twenty minutes late reads as twenty
                      minutes late at a glance; drawn from the left edge it was
                      indistinguishable from one that caught the whole show.

                      Coverage owns this strip outright, recording or finished.
                      It used to show cache progress, which still has the corner
                      badge, the percentage row and the live transfer rate — and
                      which mattered more when a transcode was the only way to
                      watch a recording at all. Measured on one device, three
                      recordings had captured four seconds, eight seconds and
                      3.7 minutes of an hour, and the device reported no error
                      for any of them: this bar is the only thing that says so. */}
                  {/* Bottom-left cluster: persistent STATUS. A New or Watched
                      chip (mutually exclusive; nothing when in progress) and,
                      when protected, a colourful lock — sitting to the right of
                      the chip, or alone in the corner when the show is neither
                      new nor watched. No hover involved; the toggles live in the
                      top-right hover cluster. Above the strip in z-order so the
                      band cannot take a click. (The "remove custom picture" undo
                      is intentionally hidden for now — placement TBD.) */}
                  {(() => {
                    const isNew = rec.position === 0 && !rec.watched && !isRecording(rec);
                    const isWatched = rec.watched && !isRecording(rec);
                    if (!isNew && !isWatched && !rec.protected) return null;
                    return (
                      <div className="absolute bottom-3 left-3 z-20 flex items-center gap-1.5">
                        {isNew && (
                          <span className="px-2 py-1 rounded bg-accent text-[10px] font-bold text-accent-fg uppercase tracking-wider">
                            New
                          </span>
                        )}
                        {isWatched && (
                          <span className="px-2 py-1 rounded bg-ink/80 text-[10px] font-bold text-media-fg-muted uppercase tracking-wider">
                            Watched
                          </span>
                        )}
                        {rec.protected && (
                          // Same vertical box as the New/Watched chips (px-1.5
                          // py-1) so the row height never changes whether or not
                          // the lock is present — a taller circle nudged the
                          // chip beside it by a couple of pixels.
                          <span className="flex items-center px-1.5 py-1 rounded bg-ink/80 text-warning"
                                title="Protected from deletion"
                                aria-label="Protected from deletion">
                            <Lock className="w-3.5 h-3.5" aria-hidden />
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  {span && (
                    <CoverageStrip
                      recording={rec}
                      span={span}
                      watched={watched}
                      watchedAt={watchedAt}
                      recording_now={isRecording(rec)}
                      broken={broken}
                      title={progressTitle(rec)}
                      timeAt={(f) => strippedTime(rec, span, f)}
                      onPlayAt={(t) => { setStartMode("at"); setStartAt(t); setPlaying(rec); }}
                      onPickCover={(t) => pickCover.mutate({ id: rec.object_id, t })}
                    />
                  )}
                </div>

                <div className="p-5 flex flex-col gap-1">
                  <div className="flex items-start gap-2">
                    <h3 className="font-bold text-fg truncate leading-tight flex-1">
                      {rec.title || "Untitled Recording"}
                      {/* The card is an episode: season/episode inline after the
                          series title, muted. Omitted for anything without both
                          (sport, movies, one-off live). */}
                      {rec.season_number != null && rec.episode_number != null && (
                        <span className="ml-1.5 text-xs font-semibold text-fg-muted tabular-nums align-baseline">
                          S{rec.season_number} E{rec.episode_number}
                        </span>
                      )}
                    </h3>
                  </div>
                  {rec.subtitle && (
                    <p className="text-xs font-medium text-accent truncate">{rec.subtitle}</p>
                  )}
                  {(rec.channel || rec.scan) && (
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] font-bold
                                    tracking-wide normal-case">
                      {rec.channel && (
                        <span className="px-1.5 py-0.5 rounded bg-fill-soft text-fg-subtle">
                          {rec.channel.number && `${rec.channel.number} `}
                          {rec.channel.network || rec.channel.call_sign}
                        </span>
                      )}
                      {rec.scan && (
                        // Interlaced is called out because it is the one that
                        // costs something: it has to be deinterlaced on the way
                        // to H.264, which halves throughput and roughly doubles
                        // the cached size.
                        <span
                          className={`px-1.5 py-0.5 rounded ${
                            rec.interlaced
                              ? "bg-warning-soft text-warning"
                              : "bg-fill-soft text-fg-subtle"
                          }`}
                          title={
                            rec.interlaced
                              ? "Interlaced source — deinterlaced to 60p during transcode"
                              : "Progressive source — no deinterlacing needed"
                          }
                        >
                          {rec.scan}
                        </span>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-fg-muted line-clamp-2 leading-relaxed min-h-[2.5rem]">
                    {rec.description || "No description available"}
                  </p>
                  {rec.pinned && rec.cache_state === "failed" ? (
                    // Couldn't finish. Say so and offer a Resume, which starts a
                    // fresh attempt from whatever is already on disk.
                    <div className="mt-2 flex items-center gap-2">
                      <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-danger">
                        <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                        Download failed
                      </span>
                      <button
                        onClick={() => control.mutate({ id: rec.object_id, action: "resume" })}
                        disabled={control.isPending}
                        className="rounded-full bg-fill-soft px-3 py-1 text-[11px] font-semibold text-fg-secondary
                                   hover:bg-fill hover:text-fg transition disabled:opacity-40"
                      >
                        Resume
                      </button>
                    </div>
                  ) : rec.pinned && rec.cache_state !== "complete" && rec.paused ? (
                    <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-widest">
                      <span className="text-fg-muted">Paused</span>
                      <span className="text-fg-muted tabular-nums normal-case">
                        {Math.round(rec.cache_progress * 100)}% ·{" "}
                        {formatDuration(rec.cached_seconds)} of {formatDuration(rec.duration)}
                      </span>
                    </div>
                  ) : rec.pinned && rec.cache_state !== "complete" ? (
                    // Active download: a spinner the height of the two stat lines
                    // that turns into a Cancel (X) on hover. Cancel keeps the
                    // partial cache and un-pins; re-keeping resumes.
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        onClick={() => control.mutate({ id: rec.object_id, action: "cancel" })}
                        disabled={control.isPending}
                        title="Cancel download (keeps what's downloaded)"
                        aria-label={`Cancel download of ${rec.title ?? "recording"}`}
                        className="group/dl relative w-8 h-8 shrink-0 rounded-full flex items-center justify-center
                                   text-success hover:text-danger hover:bg-fill transition disabled:opacity-40"
                      >
                        <Loader2 className="w-6 h-6 animate-spin group-hover/dl:hidden" aria-hidden />
                        <X className="hidden w-5 h-5 group-hover/dl:block" aria-hidden />
                      </button>
                      {/* normal-case: units carry meaning; uppercasing turns
                          "3h 35m" into "3H 35M". Two lines, matched by the spinner. */}
                      <div className="text-[11px] leading-tight tabular-nums normal-case text-fg-muted">
                        <div>
                          {Math.round(rec.cache_progress * 100)}% ·{" "}
                          {formatDuration(rec.cached_seconds)} of {formatDuration(rec.duration)}
                        </div>
                        <div>
                          {rec.rate?.mbps > 0 ? (
                            <>
                              <span className="text-success" title={`${(rec.rate.mbps / 8).toFixed(1)} MB/s`}>
                                {rec.rate.mbps.toFixed(1)} Mb/s
                              </span>
                              {rec.rate.realtime > 0 && ` · ${rec.rate.realtime.toFixed(1)}×`}
                            </>
                          ) : (
                            <span className="text-fg-subtle">starting…</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 flex items-center justify-between">
                    <span
                      className="text-[10px] font-black text-fg-muted uppercase tracking-widest"
                      title={new Date(rec.start).toLocaleString()}
                    >
                      {formatAired(rec.start)}
                    </span>
                    <div className="flex items-center gap-2">
                      {rec.pinned && rec.cache_state !== "complete" && rec.cache_state !== "failed" && (
                        <button
                          onClick={() => control.mutate({
                            id: rec.object_id,
                            action: rec.paused ? "resume" : "pause",
                          })}
                          disabled={control.isPending}
                          title={rec.paused ? "Resume download" : "Pause download"}
                          aria-label={rec.paused
                            ? `Resume download of ${rec.title ?? "recording"}`
                            : `Pause download of ${rec.title ?? "recording"}`}
                          className="w-8 h-8 rounded-full bg-fill-soft flex items-center justify-center
                                     text-fg-subtle hover:bg-fill hover:text-fg transition disabled:opacity-30
                                     enabled:hover:scale-110 enabled:active:scale-95"
                        >
                          {rec.paused
                            ? <Download className="w-4 h-4" aria-hidden />
                            : <Pause className="w-4 h-4" fill="currentColor" aria-hidden />}
                        </button>
                      )}
                      {rec.cache_state === "complete" && (
                        // A plain link, not a fetch: the browser owns the
                        // download, so a 7 GB file streams to disk instead of
                        // being buffered in a tab.
                        <a
                          href={downloadUrl(rec.object_id)}
                          download
                          title="Save as a single MP4 file"
                          aria-label={`Save ${rec.title ?? "recording"} as an MP4 file`}
                          className="w-8 h-8 rounded-full bg-fill-soft flex items-center justify-center
                                     text-fg-subtle hover:bg-fill hover:text-fg transition
                                     hover:scale-110 active:scale-95"
                        >
                          <FileDown className="w-4 h-4" aria-hidden />
                        </a>
                      )}
                      {rec.cache_state !== "absent" && (
                        <button
                          onClick={() => setConfirmation({
                            title: `Delete the cached video of "${rec.title ?? "this recording"}"?`,
                            body: rec.offline_only
                              ? "The Tablo no longer has this recording. Deleting it here removes the only copy."
                              : "It can be cached again from the Tablo.",
                            confirmLabel: "Delete cache",
                            danger: true,
                            onConfirm: () => control.mutate({ id: rec.object_id, action: "delete" }),
                          })}
                          disabled={control.isPending}
                          title="Delete cached video"
                          aria-label={`Delete cached video of ${rec.title ?? "recording"}`}
                          className="w-8 h-8 rounded-full bg-fill-soft flex items-center justify-center
                                     text-fg-faint hover:bg-danger-soft hover:text-danger transition disabled:opacity-30
                                     enabled:hover:scale-110 enabled:active:scale-95"
                        >
                          <Trash2 className="w-4 h-4" aria-hidden />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (!rec.pinned) {
                            keep.mutate({ id: rec.object_id, on: true });
                            return;
                          }
                          setConfirmation({
                            title: `Stop keeping "${rec.title ?? "this recording"}" offline?`,
                            body: rec.offline_only
                              ? "The Tablo no longer has this recording, so the copy cannot be remade once it is reclaimed."
                              : "The cached video stays until space is needed, then it is reclaimed automatically.",
                            confirmLabel: "Stop keeping",
                            danger: rec.offline_only,
                            onConfirm: () => keep.mutate({ id: rec.object_id, on: false }),
                          });
                        }}
                        disabled={!keepable || keep.isPending}
                        title={rec.pinned ? "Kept offline — click to stop keeping" : "Keep offline"}
                        aria-label={rec.pinned ? `Stop keeping ${rec.title ?? "recording"}` : `Keep ${rec.title ?? "recording"} offline`}
                        className={`w-8 h-8 rounded-full flex items-center justify-center transition disabled:opacity-30
                          enabled:hover:scale-110 enabled:active:scale-95
                          ${rec.pinned
                            ? "bg-success-soft text-success hover:bg-success-soft-strong"
                            : "bg-fill-soft text-fg-faint hover:bg-fill hover:text-fg-secondary"}`}
                      >
                        {keep.isPending && keep.variables?.id === rec.object_id
                          ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                          : rec.pinned
                            ? <CheckCircle2 className="w-4 h-4" aria-hidden />
                            : <Download className="w-4 h-4" aria-hidden />}
                      </button>
                      <button
                        // Says how it opens as well as what: the mode is
                        // shared across every card, so a button that only set
                        // the recording inherited whatever the last one chose.
                        // Harmless while that was "beginning" or "live"; not
                        // once a click on the strip could leave behind a
                        // position from a three-hour film, which then opened a
                        // half-hour show past its end.
                        onClick={() => setInfoFor(rec)}
                        className="w-8 h-8 rounded-full bg-fill-soft flex items-center justify-center hover:bg-accent hover:text-accent-fg transition text-fg-faint
                                   enabled:hover:scale-110 enabled:active:scale-95"
                        title="Show information"
                        aria-label={`Information about ${rec.title ?? "this recording"}`}
                      >
                        {/* The Live card's mark, at the Live card's
                            proportions: three quarters of the puck, so the
                            ring is the glyph rather than a small thing
                            floating in a big disc. */}
                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth={1.6}
                             strokeLinecap="round" aria-hidden>
                          <circle cx="12" cy="12" r="9.6" />
                          <path d="M12 11.1v5.6M12 7.5v.2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
              })}
            </Fragment>
          ))
        )}
      </div>
    </>
  );
}
