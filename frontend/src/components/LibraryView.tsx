import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, downloadUrl } from "../api/tablo";
import type { Recording, RecordingList } from "../api/tablo";
import { VideoPlayer, LIVE_EDGE } from "./VideoPlayer";
import { AlertTriangle, Play, Download, CheckCircle2, CloudOff, FileDown, Info, Loader2, Pause, Radio, Trash2, Undo2 } from "lucide-react";
import { onRoutePop, parseRoute, writeRoute } from "../lib/route";
import { dayKey, formatAired, formatDayHeading } from "../lib/format";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { ShowInfo } from "./ShowInfo";
import { CoverageStrip } from "./CoverageStrip";
import { loadResume, saveResume, resumeKey } from "../lib/resume";
import { cardArt, isIncomplete, recordedSpan, strippedTime, watchedSpan } from "../lib/recording";
import type { Coverage } from "../lib/recording";

/**
 * Whether there is something to play.
 *
 * A recording still being written plays fine: the device serves it as HLS from
 * the first moment, which is how its own app lets you start a show that is
 * still recording. Verified against a recording in progress - `state:
 * recording`, `duration: 0` - which still answered `POST .../watch` with a
 * playlist. This used to refuse them on the assumption that a transcode needs
 * a complete file, and the result was the one thing the device is best at
 * being the one thing we could not do.
 */
function isPlayable(rec: Recording): boolean {
  // An offline copy plays regardless of what the device reports — it may not
  // be on the device at all any more.
  if (rec.offline_only) return true;
  return !rec.error;
}

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
 * A recording as the coverage bar sees it.
 *
 * The one subtlety is which number is "captured": while recording the server
 * derives it, and once finished `duration` *is* it — the device replaces the
 * slot with the real length at that moment, which is why `slot_seconds` exists
 * separately.
 */
function coverageOf(rec: Recording): Coverage {
  return {
    start: rec.start,
    duration: rec.slot_seconds,
    recording_started: rec.recording_started,
    recorded_seconds: isRecording(rec) ? rec.recorded_seconds : rec.duration,
  };
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

/** Still being written, and so still growing under anyone watching it. */
function isRecording(rec: Recording): boolean {
  return rec.state === "recording";
}

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

/**
 * The saved position for a recording, or 0.
 *
 * Read at render because the in-progress card labels its own button with it —
 * "Resume 12:20" rather than "From start" — and that label has to be right
 * before anything is playing. The player's own resume point is still read once
 * per recording, where feeding it back on every tick used to reload the stream.
 */
function resumeFor(rec: Recording): number {
  const ours = loadResume(resumeKey("recording", rec.object_id));
  // The device's own position, which its app writes and ours now does too.
  // Whichever is further in wins, and only here — once playing, our writes go
  // to the device unconditionally, so a deliberate rewind sticks rather than
  // being compared away.
  //
  // Neither side carries a timestamp: `user_info` is exactly
  // {position, watched, protected}, so there is no honest last-writer-wins to
  // implement. Taking the greater is right in the cases that happen — watched
  // on the phone then opened here, or the reverse — and taking the device
  // wholesale would have rewound eleven recordings, Saturday Night Live from
  // 21:36 back to 33 seconds.
  //
  // Clamped to what exists: a position captured while the programme was still
  // recording can outrun the media once it finishes and is cut short, and
  // "greater wins" would otherwise enshrine it.
  const theirs = rec.position ?? 0;
  const furthest = Math.max(ours, theirs);
  const limit = isRecording(rec) ? (rec.recorded_seconds ?? 0) : rec.duration;
  return limit > 0 ? Math.min(furthest, limit) : furthest;
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
function dayTint(iso: string, alpha?: number): string {
  const d = new Date(iso);
  const day = Number.isNaN(d.getTime()) ? 0 : d.getDay();
  return alpha === undefined
    ? `rgb(var(--c-day-${day}))`
    : `rgb(var(--c-day-${day}) / ${alpha})`;
}

export function LibraryView() {
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

  const qc = useQueryClient();

  const { data: storage } = useQuery({
    queryKey: ["recordings-storage"],
    queryFn: () => api.storage(),
    refetchInterval: 15_000,
  });

  const control = useMutation<unknown, Error, { id: number; action: "pause" | "resume" | "delete" }>({
    mutationFn: ({ id, action }) =>
      action === "pause" ? api.pauseKeep(id)
        : action === "resume" ? api.resumeKeep(id)
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

  const clearCover = useMutation({
    mutationFn: (id: number) => api.clearRecordingCover(id),
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
   * The recordings split into the days they aired on, newest day first.
   *
   * A flat wall of cards gave no sense of when anything was recorded; the
   * heading rows are the only place the date is read at a glance.
   */
  const days = useMemo(() => {
    // The heading is rendered from a real timestamp, not from the key: a key is
    // a bare `2026-09-14`, which Date parses as UTC midnight and would name the
    // day before for anyone west of UTC — the very slip the key exists to avoid.
    const byDay = new Map<string, { start: string; items: Recording[] }>();
    for (const rec of recordings) {
      const start = rec.start ?? "";
      const key = dayKey(start);
      const bucket = byDay.get(key);
      if (bucket) bucket.items.push(rec);
      else byDay.set(key, { start, items: [rec] });
    }
    return [...byDay.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, group]) => ({ key, ...group }));
  }, [recordings]);

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
          // This card's recording, not the airing's newest: a capture stopped
          // and restarted leaves two against one slot, and the sheet must
          // delete the one whose card was opened.
          recordingId={infoFor.object_id}
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
          onTune={() => { setStartMode("live"); setPlaying(infoFor); setInfoFor(null); }}
        />
      )}

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

      {/* With no days to hang it on there is no rule to sit on either, so the
          readout falls back to a row of its own. Without this an empty library
          would drop it entirely — and an empty library is exactly when "106.9
          GB free" is worth reading. */}
      {days.length === 0 && storageLine && (
        <div className="flex items-center justify-end mb-3">{storageLine}</div>
      )}

      <div
        className="grid gap-6"
        style={{
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
        ) : (
          days.map(({ key, start, items }, dayIndex) => (
            <Fragment key={key}>
              {/* The day these aired, in that weekday's colour. Spans the grid,
                  so the cards below it read as one evening's recordings.

                  The first one also carries the storage readout, at the far end
                  of the rule. The rule already runs the width of the grid and
                  fades out on the way, so the right end is space this row was
                  spending on nothing. It is rendered here rather than owned by
                  the day group: these are page totals, and they would be a lie
                  if read as belonging to Monday. `flex-wrap` so it drops to its
                  own line at phone width instead of crushing the rule. */}
              <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 first:pt-0">
                <span
                  className="text-[11px] font-black uppercase tracking-widest whitespace-nowrap"
                  style={{ color: dayTint(start) }}
                >
                  {formatDayHeading(start) || "Undated"}
                </span>
                <span
                  className="h-px flex-1 min-w-8 rounded-full"
                  style={{
                    background: `linear-gradient(to right, ${dayTint(start, 0.5)}, transparent)`,
                  }}
                />
                {dayIndex === 0 && storageLine}
              </div>

              {items.map((rec) => {
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
                      className="absolute inset-0 w-full h-full object-fill"
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
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2
                                      bg-scrim-soft opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
                        {/* Where you left off leads: it is the likeliest thing
                            wanted, and the only one that needs no thought. */}
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
                      </div>
                    );
                  })()}

                  {/* Recording wins the corner outright. Nothing else a card can
                      say about itself matters as much as the fact that it is
                      still growing — and the cache badges cannot apply anyway,
                      since keeping a copy needs a finished recording. */}
                  {isRecording(rec) ? (
                    <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded bg-danger-solid text-[10px] font-bold text-danger-fg uppercase tracking-wider">
                      <span className="relative flex w-2 h-2" aria-hidden>
                        {/* The pulse is the only motion on the card, and it
                            stops for reduced motion — where the dot alone
                            still reads as recording. */}
                        <span className="motion-safe:animate-ping absolute inline-flex w-full h-full rounded-full bg-danger-fg opacity-60" />
                        <span className="relative inline-flex w-2 h-2 rounded-full bg-danger-fg" />
                      </span>
                      Recording
                    </div>
                  ) : broken ? (
                    // Four seconds of an hour is not a short recording, it is a
                    // broken one. The device does not agree - `error` is null
                    // and `warnings` empty on all three measured failures - so
                    // this is inferred from how little of the slot exists, and
                    // said out loud rather than left to a sliver on the strip.
                    <div className="absolute top-3 left-3 flex items-center gap-1 px-2 py-1 rounded bg-warning-solid text-[10px] font-bold text-warning-fg uppercase tracking-wider"
                         title="Only a fraction of the scheduled programme was captured.">
                      <AlertTriangle className="w-3 h-3" aria-hidden />
                      Incomplete
                    </div>
                  ) : rec.pinned ? (
                    <div className="absolute top-3 left-3 flex items-center gap-1 px-2 py-1 rounded bg-success-solid text-[10px] font-bold text-success-fg uppercase tracking-wider">
                      <CheckCircle2 className="w-3 h-3" aria-hidden />
                      {rec.cache_state === "complete" ? "Cached" : `${Math.round(rec.cache_progress * 100)}%`}
                    </div>
                  ) : rec.cache_state === "complete" ? (
                    <div className="absolute top-3 left-3 px-2 py-1 rounded bg-accent text-[10px] font-bold text-accent-fg uppercase tracking-wider">
                      Ready
                    </div>
                  ) : rec.cache_progress > 0 ? (
                    // Watching transcodes as it goes, so a recording nobody
                    // asked to keep is often substantially on disk already.
                    // Deliberately not emerald and without the tick: that badge
                    // means the copy is kept and outlives the Tablo deleting
                    // it, and an incidental cache makes no such promise. The
                    // colour carries the distinction now that both say cached.
                    <div className="absolute top-3 left-3 px-2 py-1 rounded bg-ink/80 text-[10px] font-bold text-media-fg-muted uppercase tracking-wider tabular-nums"
                         title="Transcoded so far. Keep it offline to fill in the rest.">
                      {Math.max(1, Math.round(rec.cache_progress * 100))}% cached
                    </div>
                  ) : null}
                  {rec.offline_only && (
                    <div className="absolute top-3 right-3 flex items-center gap-1 px-2 py-1 rounded bg-ink/80 text-[10px] font-bold text-media-fg-muted uppercase tracking-wider"
                         title="Kept here — the Tablo no longer has this recording">
                      <CloudOff className="w-3 h-3" aria-hidden />
                      Only here
                    </div>
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
                  {/* Only while the picture is one the viewer picked. Bottom
                      left, clear of the badges in the opposite corner and of
                      the strip's reach along the bottom edge — and it appears
                      on hover like the play controls, because a card at rest
                      should be its picture and nothing else.

                      Above the strip's band in z-order, or the band would take
                      the click and start playing instead. */}
                  {rec.cover_frame !== null && (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        clearCover.mutate(rec.object_id);
                      }}
                      disabled={clearCover.isPending}
                      title="Use the show's own picture again"
                      aria-label="Use the show's own picture again"
                      className="absolute bottom-3 left-3 z-20 w-7 h-7 rounded-full glass
                                 flex items-center justify-center text-media-fg
                                 opacity-0 group-hover/art:opacity-100 focus-visible:opacity-100
                                 hover:bg-fill transition disabled:opacity-40"
                    >
                      <Undo2 className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  )}

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
                    </h3>
                    {/* The way into everything the card has no room for —
                        artwork, synopsis, rating, and the record controls. On
                        every card: the sheet asks the device about the
                        recording rather than the guide about its airing, so
                        there is always something to open. */}
                    <button
                      onClick={() => setInfoFor(rec)}
                      className="shrink-0 -mt-0.5 p-1 rounded-lg text-fg-muted
                                 hover:text-fg hover:bg-fill transition"
                      title="Show information"
                      aria-label={`Information about ${rec.title ?? "this recording"}`}
                    >
                      <Info className="w-4 h-4" aria-hidden />
                    </button>
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
                  {rec.pinned && rec.cache_state !== "complete" && (
                    <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-widest">
                      {rec.paused ? (
                        <span className="text-fg-muted">Paused</span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-success">
                          <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
                          Downloading
                        </span>
                      )}
                      {/* normal-case: the units carry meaning here, and the
                          line's uppercasing turns "3h 35m" into "3H 35M". */}
                      <span className="text-fg-muted tabular-nums normal-case">
                        {Math.round(rec.cache_progress * 100)}% ·{" "}
                        {formatDuration(rec.cached_seconds)} of {formatDuration(rec.duration)}
                        {!rec.paused && rec.rate?.mbps > 0 && (
                          <>
                            {" · "}
                            <span
                              className="text-success"
                              title={`${(rec.rate.mbps / 8).toFixed(1)} MB/s`}
                            >
                              {rec.rate.mbps.toFixed(1)} Mb/s
                            </span>
                            {rec.rate.realtime > 0 && ` · ${rec.rate.realtime.toFixed(1)}×`}
                          </>
                        )}
                      </span>
                    </div>
                  )}

                  <div className="mt-4 flex items-center justify-between">
                    <span
                      className="text-[10px] font-black text-fg-muted uppercase tracking-widest"
                      title={new Date(rec.start).toLocaleString()}
                    >
                      {formatAired(rec.start)}
                    </span>
                    <div className="flex items-center gap-2">
                      {rec.pinned && rec.cache_state !== "complete" && (
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
                        onClick={() => {
                          if (!playable) return;
                          setStartMode("resume");
                          setPlaying(rec);
                        }}
                        disabled={!playable}
                        className="w-8 h-8 rounded-full bg-fill-soft flex items-center justify-center hover:bg-accent hover:text-accent-fg transition text-fg-faint disabled:opacity-30 disabled:hover:bg-fill-soft
                                   enabled:hover:scale-110 enabled:active:scale-95"
                        aria-label={`Play ${rec.title ?? "recording"}`}
                      >
                        <Play className="w-4 h-4" fill="currentColor" aria-hidden />
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
