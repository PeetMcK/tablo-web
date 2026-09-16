import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, downloadUrl } from "../api/tablo";
import type { Recording } from "../api/tablo";
import { VideoPlayer } from "./VideoPlayer";
import { Play, Download, CheckCircle2, CloudOff, FileDown, Loader2, Pause, Trash2 } from "lucide-react";
import { parseRoute, writeRoute } from "../lib/route";
import { dayColor, dayKey, formatAired, formatDayHeading } from "../lib/format";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { loadResume, saveResume, resumeKey } from "../lib/resume";

/** A recording still being written has no complete source to transcode. */
function isPlayable(rec: Recording): boolean {
  // An offline copy plays regardless of what the device reports — it may not
  // be on the device at all any more.
  if (rec.offline_only) return true;
  return rec.state !== "recording" && !rec.error;
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

export function LibraryView() {
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [initialRoute] = useState(parseRoute);
  const [restoreDone, setRestoreDone] = useState(false);
  const positionRef = useRef(0);
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

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["recordings"],
    queryFn: () => api.recordings(),
    staleTime: 5 * 60_000,
    // A refetch re-renders this component, which used to reload the player.
    // That is fixed in VideoPlayer, but there is no reason to churn mid-watch.
    refetchOnWindowFocus: false,
    // Poll quickly while a copy is being made so progress actually moves;
    // back off once nothing is in flight.
    refetchInterval: (q) => {
      const rows = q.state.data?.recordings ?? [];
      const busy = rows.some(r => r.pinned && !r.paused && r.cache_state !== "complete");
      return busy ? 4_000 : 30_000;
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

  useEffect(() => {
    playingRef.current = nowPlaying;
    if (!nowPlaying) positionRef.current = 0;
    writeRoute({
      tab: "library",
      watch: nowPlaying ? { kind: "recording", id: nowPlaying.object_id } : null,
    });
  }, [nowPlaying]);

  // Persist the playhead locally. Throttled to whole seconds; the URL is left
  // alone so it stays a stable reference to the recording.
  const handlePosition = useCallback((seconds: number) => {
    const whole = Math.floor(seconds);
    if (whole === Math.floor(positionRef.current)) return;
    positionRef.current = whole;
    const rec = playingRef.current;
    if (rec) saveResume(resumeKey("recording", rec.object_id), whole, rec.duration);
  }, []);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-48 gap-4">
        <div className="w-12 h-12 rounded-full border-4 border-accent border-t-transparent animate-spin" />
        <p className="text-white/40 text-sm font-medium uppercase tracking-widest">Accessing Library...</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-48 gap-6 text-center">
        <p className="text-red-400 font-bold">Failed to load recordings</p>
        <button onClick={() => refetch()} className="px-6 py-2 rounded-xl glass text-sm hover:bg-white/5 transition">
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />

      {nowPlaying && (
        <VideoPlayer
          key={nowPlaying.object_id}
          source={{ kind: "recording", recording: nowPlaying }}
          // Restored from a URL: resume at the saved point, paused, so audio is
          // not blocked by the missing user activation on a fresh page load.
          // Resume where this recording was left, whether opened fresh or
          // restored by a refresh. Only a refresh starts paused — a reload
          // carries no user activation, so autoplay would be forced to mute.
          startAt={resumeAt}
          autoPlay={Boolean(playing)}
          onPosition={handlePosition}
          onClose={() => { setPlaying(null); setRestoreDone(true); }}
        />
      )}

      <div className="flex items-center gap-4 mb-3 text-[11px] uppercase tracking-widest text-white/30">
        {truncated && <span>Showing {data!.returned} of {data!.total}</span>}
        {storage && (
          <span>
            {formatBytes(storage.pinned_bytes)} kept
            {storage.pinned_count > 0 && ` (${storage.pinned_count})`}
            {" · "}{formatBytes(storage.cache_bytes)} cache
            {" · "}{formatBytes(storage.free_bytes)} free
          </span>
        )}
      </div>

      <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {recordings.length === 0 ? (
          <div className="col-span-full py-48 text-center bg-white/5 rounded-3xl border border-white/5">
            <p className="text-white/20 font-black tracking-widest uppercase">No Recordings Found</p>
          </div>
        ) : (
          days.map(({ key, start, items }) => (
            <Fragment key={key}>
              {/* The day these aired, in that weekday's colour. Spans the grid,
                  so the cards below it read as one evening's recordings. */}
              <div className="col-span-full flex items-center gap-3 pt-2 first:pt-0">
                <span
                  className="text-[11px] font-black uppercase tracking-widest whitespace-nowrap"
                  style={{ color: dayColor(start) }}
                >
                  {formatDayHeading(start) || "Undated"}
                </span>
                <span
                  className="h-px flex-1 rounded-full"
                  style={{
                    background: `linear-gradient(to right, ${dayColor(start)}80, transparent)`,
                  }}
                />
              </div>

              {items.map((rec) => {
            const playable = isPlayable(rec);
            return (
              <div
                key={rec.object_id}
                className="group flex flex-col bg-surface-raised border border-surface-border rounded-2xl overflow-hidden hover:border-accent/40 transition shadow-lg"
              >
                <button
                  onClick={() => playable && setPlaying(rec)}
                  disabled={!playable}
                  className="aspect-video bg-black/40 relative block w-full disabled:cursor-not-allowed"
                  aria-label={`Play ${rec.title ?? "recording"}`}
                >
                  {rec.thumbnail ? (
                    <img src={rec.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/10 uppercase font-black text-xl italic">
                      Tablo
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition">
                    <div className="accent-gradient w-14 h-14 rounded-full flex items-center justify-center">
                      <Play className="w-6 h-6 text-white ml-0.5" fill="currentColor" aria-hidden />
                    </div>
                  </div>
                  {rec.pinned ? (
                    <div className="absolute top-3 left-3 flex items-center gap-1 px-2 py-1 rounded bg-emerald-600/90 text-[10px] font-bold text-white uppercase tracking-wider">
                      <CheckCircle2 className="w-3 h-3" aria-hidden />
                      {rec.cache_state === "complete" ? "Cached" : `${Math.round(rec.cache_progress * 100)}%`}
                    </div>
                  ) : rec.cache_state === "complete" ? (
                    <div className="absolute top-3 left-3 px-2 py-1 rounded bg-accent/80 text-[10px] font-bold text-white uppercase tracking-wider">
                      Ready
                    </div>
                  ) : rec.cache_progress > 0 ? (
                    // Watching transcodes as it goes, so a recording nobody
                    // asked to keep is often substantially on disk already.
                    // Deliberately not emerald and without the tick: that badge
                    // means the copy is kept and outlives the Tablo deleting
                    // it, and an incidental cache makes no such promise. The
                    // colour carries the distinction now that both say cached.
                    <div className="absolute top-3 left-3 px-2 py-1 rounded bg-black/80 text-[10px] font-bold text-white/70 uppercase tracking-wider tabular-nums"
                         title="Transcoded so far. Keep it offline to fill in the rest.">
                      {Math.max(1, Math.round(rec.cache_progress * 100))}% cached
                    </div>
                  ) : null}
                  {rec.offline_only && (
                    <div className="absolute top-3 right-3 flex items-center gap-1 px-2 py-1 rounded bg-black/80 text-[10px] font-bold text-white/70 uppercase tracking-wider"
                         title="Kept here — the Tablo no longer has this recording">
                      <CloudOff className="w-3 h-3" aria-hidden />
                      Only here
                    </div>
                  )}
                  <div className="absolute bottom-3 right-3 px-2 py-1 rounded bg-black/80 text-[10px] font-bold text-white tabular-nums">
                    {formatDuration(rec.duration)}
                  </div>

                  {/* Fill progress along the bottom edge — the corner badge
                      alone was too easy to miss. Shown for anything part-cached,
                      not only for kept copies, so the bar and the badge above
                      never disagree about whether there is work on disk. */}
                  {rec.cache_state !== "complete" && rec.cache_progress > 0 && (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
                      <div
                        className={`h-full transition-[width] duration-1000 ease-linear
                                    ${!rec.pinned ? "bg-white/30"
                                      : rec.paused ? "bg-white/40" : "bg-emerald-400"}`}
                        style={{ width: `${Math.max(1, rec.cache_progress * 100)}%` }}
                      />
                    </div>
                  )}
                </button>

                <div className="p-5 flex flex-col gap-1">
                  <h3 className="font-bold text-white truncate leading-tight">{rec.title || "Untitled Recording"}</h3>
                  {rec.subtitle && (
                    <p className="text-xs font-medium text-accent/70 truncate">{rec.subtitle}</p>
                  )}
                  {(rec.channel || rec.scan) && (
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] font-bold
                                    tracking-wide normal-case">
                      {rec.channel && (
                        <span className="px-1.5 py-0.5 rounded bg-white/5 text-white/45">
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
                              ? "bg-amber-400/10 text-amber-300/80"
                              : "bg-white/5 text-white/45"
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
                  <p className="text-xs text-white/40 line-clamp-2 leading-relaxed min-h-[2.5rem]">
                    {rec.description || "No description available"}
                  </p>
                  {rec.pinned && rec.cache_state !== "complete" && (
                    <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-widest">
                      {rec.paused ? (
                        <span className="text-white/40">Paused</span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-emerald-400">
                          <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
                          Downloading
                        </span>
                      )}
                      {/* normal-case: the units carry meaning here, and the
                          line's uppercasing turns "3h 35m" into "3H 35M". */}
                      <span className="text-white/35 tabular-nums normal-case">
                        {Math.round(rec.cache_progress * 100)}% ·{" "}
                        {formatDuration(rec.cached_seconds)} of {formatDuration(rec.duration)}
                        {!rec.paused && rec.rate?.mbps > 0 && (
                          <>
                            {" · "}
                            <span
                              className="text-emerald-400/70"
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
                      className="text-[10px] font-black text-white/20 uppercase tracking-widest"
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
                          className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center
                                     text-white/50 hover:bg-white/10 hover:text-white transition disabled:opacity-30"
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
                          className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center
                                     text-white/50 hover:bg-white/10 hover:text-white transition"
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
                          className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center
                                     text-white/40 hover:bg-red-500/20 hover:text-red-300 transition disabled:opacity-30"
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
                        disabled={!playable || keep.isPending}
                        title={rec.pinned ? "Kept offline — click to stop keeping" : "Keep offline"}
                        aria-label={rec.pinned ? `Stop keeping ${rec.title ?? "recording"}` : `Keep ${rec.title ?? "recording"} offline`}
                        className={`w-8 h-8 rounded-full flex items-center justify-center transition disabled:opacity-30
                          ${rec.pinned
                            ? "bg-emerald-600/25 text-emerald-300 hover:bg-emerald-600/40"
                            : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70"}`}
                      >
                        {keep.isPending && keep.variables?.id === rec.object_id
                          ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                          : rec.pinned
                            ? <CheckCircle2 className="w-4 h-4" aria-hidden />
                            : <Download className="w-4 h-4" aria-hidden />}
                      </button>
                      <button
                        onClick={() => playable && setPlaying(rec)}
                        disabled={!playable}
                        className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center hover:bg-accent hover:text-white transition text-white/40 disabled:opacity-30 disabled:hover:bg-white/5"
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
