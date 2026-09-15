import { useEffect, useRef, useState, useCallback } from "react";
import { X, Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Maximize } from "lucide-react";
import { usePlayer } from "../hooks/usePlayer";
import { api } from "../api/tablo";
import type { Channel, Program, Recording, CacheState } from "../api/tablo";
import { log, fmt, isCached, rangesLabel, timeRangesToArray, installSnapshot } from "../lib/debug";

/**
 * What the player is showing. Live and recordings share the whole transport —
 * they differ in the title block, the badge, and which API starts the stream.
 */
export type PlaybackSource =
  | { kind: "live"; channel: Channel; program?: Program | null }
  | { kind: "recording"; recording: Recording };

interface Props {
  source: PlaybackSource;
  onClose: () => void;
  /** Resume point, in seconds. Used when restoring after a refresh. */
  startAt?: number;
  /** False when restoring: start paused so audio is not blocked. */
  autoPlay?: boolean;
  /** Playhead updates, so the caller can keep it in the URL. */
  onPosition?: (seconds: number) => void;
}

/** Must not exceed the backend's LIVE_DVR_MINUTES window (default 60). */
const LIVE_DVR_SECONDS = 3600;

/** Within this many seconds of the seekable end counts as "at the live edge". */
const LIVE_EDGE_THRESHOLD = 12;

/**
 * Seeking into an un-encoded window makes the backend transcode it before
 * responding. A cold window is ~30s on CPU, and landing on its last segment
 * means waiting for the whole thing, so the 20s default is far too tight.
 */
const RECORDING_FRAG_TIMEOUT = 120_000;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function VideoPlayer({ source, onClose, startAt = 0, autoPlay = true, onPosition }: Props) {
  const isLive = source.kind === "live";
  const videoRef = useRef<HTMLVideoElement>(null);

  // Latched at mount. These decide how the stream is opened; letting a later
  // value through would change `load`'s identity and restart playback.
  const [openAt] = useState(startAt);
  const [openPlaying] = useState(autoPlay);

  const { load, destroy, error: playerError } = usePlayer(videoRef, {
    // Live keeps the DVR window buffered so rewind has something to land on;
    // a cached recording is fully addressable server-side, so nothing needs
    // holding in memory.
    backBufferLength: isLive ? LIVE_DVR_SECONDS : Infinity,
    // Recordings start at the beginning, or wherever we are resuming from.
    // Live follows the edge.
    startPosition: isLive ? -1 : openAt,
    autoplay: openPlaying,
    fragLoadingTimeOut: isLive ? undefined : RECORDING_FRAG_TIMEOUT,
  });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(!openPlaying);
  const [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState(0);
  // Where the user is dragging, independent of where playback actually is.
  // Rendering the real position during a drag made the thumb fight the pointer.
  const [scrubAt, setScrubAt] = useState<number | null>(null);
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  const [fineFactor, setFineFactor] = useState(1);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; base: number } | null>(null);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [cacheState, setCacheState] = useState<CacheState | null>(null);
  const [cachedRanges, setCachedRanges] = useState<[number, number][]>([]);
  // Media listeners are attached once on mount, so they need a live view of the
  // ranges rather than the value captured in that first closure.
  const cachedRangesRef = useRef<[number, number][]>([]);
  const [now, setNow] = useState(() => Date.now());
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const resetHideTimerRef = useRef<(() => void) | null>(null);
  const onPositionRef = useRef(onPosition);

  const combinedError = apiError || playerError;
  const program = isLive ? source.program ?? null : null;

  const title = isLive
    ? (program?.title || source.channel.display_name)
    : (source.recording.title ?? "Recording");
  const subtitle = isLive
    ? source.channel.display_name
    : (source.recording.subtitle ?? "");

  const atLiveEdge = isLive && rangeEnd - position < LIVE_EDGE_THRESHOLD;

  // The parent builds `source` as an object literal, so it is a new reference on
  // every one of its renders. Keying the start effect on the object would tear
  // the player down and reload it from the beginning whenever the parent
  // re-rendered - a React Query refetch was enough to do it mid-playback.
  const sourceKey = isLive
    ? `live:${source.channel.identifier}`
    : `rec:${source.recording.object_id}`;
  const sourceRef = useRef(source);
  // Declared before the start effect so the ref is current by the time it runs.
  useEffect(() => { sourceRef.current = source; });
  useEffect(() => { onPositionRef.current = onPosition; }, [onPosition]);
  useEffect(() => { cachedRangesRef.current = cachedRanges; }, [cachedRanges]);

  // ---------------------------------------------------------------- start
  useEffect(() => {
    let cancelled = false;

    const current = sourceRef.current;
    const start = async () => {
      try {
        if (current.kind === "live") {
          // OTA broadcasts are MPEG-2. No browser's MSE implementation decodes
          // MPEG-2 video — hls.js demuxes the container but the video track is
          // unrenderable, leaving audio only. Always transcode OTA to H.264.
          const transcode = current.channel.kind === "ota" ? true : undefined;
          const r = await api.startStream(current.channel.identifier, transcode);
          if (cancelled) return;
          log.player(`open live ${current.channel.display_name}`, {
            kind: current.channel.kind, transcode: !!transcode,
            session: r.session_id, url: r.stream_url,
          });
          setSessionId(r.session_id);
          load(r.stream_url);
        } else {
          const t0 = performance.now();
          const r = await api.watchRecording(current.recording.object_id);
          if (cancelled) return;
          log.player(`open recording ${current.recording.object_id} "${current.recording.title}"`, {
            ms: Math.round(performance.now() - t0),
            duration: fmt(r.duration),
            cacheState: r.state,
            cached: fmt(r.cached_seconds ?? 0),
            ranges: rangesLabel(r.cached_ranges ?? []),
            url: r.stream_url,
            resumeAt: openAt ? fmt(openAt) : "start",
            autoplay: openPlaying,
          });
          setCacheState(r.state);
          setCachedRanges(r.cached_ranges ?? []);
          load(r.stream_url);
        }
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setApiError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    };

    start();
    return () => {
      cancelled = true;
      destroy();
    };
    // startAt/autoPlay are read once when the stream opens; changing them
    // later must not tear down and reload playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, load, destroy]);

  // Live sessions hold a tuner and must be released.
  useEffect(() => {
    return () => {
      if (sessionId) api.stopStream(sessionId).catch(() => {});
    };
  }, [sessionId]);

  // Closing a recording stops its transcode. Encoded windows are kept — only the
  // work stops. Without this the server kept encoding the whole recording long
  // after playback ended, pinning every core.
  useEffect(() => {
    if (isLive) return;
    const objectId = source.kind === "recording" ? source.recording.object_id : 0;
    return () => {
      log.net(`release recording ${objectId} — transcoding stops, cache kept`);
      api.releaseRecording(objectId).catch(() => {});
    };
  }, [isLive, sourceKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------- transcode progress poll
  useEffect(() => {
    if (isLive || cacheState === "complete") return;
    const id = setInterval(async () => {
      try {
        const cur = sourceRef.current;
        if (cur.kind !== "recording") return;
        // Position is the heartbeat: it tells the server someone is still here
        // and where to keep the lookahead.
        const s = await api.recordingStatus(
          cur.recording.object_id,
          videoRef.current?.currentTime ?? 0,
        );
        setCacheState(s.state);
        const secs = s.cached_seconds ?? 0;
        log.cache(`${s.state} — ${fmt(secs)} of ${fmt(s.duration)} (${Math.round(s.progress * 100)}%)`, {
          playhead: fmt(videoRef.current?.currentTime ?? 0),
          ahead: fmt(Math.max(0, (s.cached_ranges ?? []).reduce(
            (m, [a, b]) => ((videoRef.current?.currentTime ?? 0) >= a &&
                            (videoRef.current?.currentTime ?? 0) < b ? b : m), 0)
            - (videoRef.current?.currentTime ?? 0))),
          ranges: rangesLabel(s.cached_ranges ?? []),
          error: s.error,
        });
        setCachedRanges(s.cached_ranges ?? []);
        if (s.state === "complete") clearInterval(id);
      } catch {
        /* transient - keep polling */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [isLive, cacheState, sourceKey]);

  // Live program progress is wall-clock driven, not stream driven.
  useEffect(() => {
    if (!program) return;
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, [program]);

  // ------------------------------------------------------------ transport
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const sync = () => {
      setPosition(video.currentTime);
      onPositionRef.current?.(video.currentTime);
      setPaused(video.paused);
      const sk = video.seekable;
      if (sk.length > 0) {
        setRangeStart(sk.start(0));
        setRangeEnd(sk.end(sk.length - 1));
      } else if (Number.isFinite(video.duration)) {
        setRangeStart(0);
        setRangeEnd(video.duration);
      }
    };
    const onVolume = () => setMuted(video.muted);
    let stalledAt = 0;
    const onWait = () => {
      stalledAt = performance.now();
      const t = video.currentTime;
      log.warn(`stalled at ${fmt(t)}`, {
        cachedHere: isCached(t, cachedRangesRef.current),
        buffered: timeRangesToArray(video.buffered).map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(", ") || "none",
        readyState: video.readyState,
      });
      setWaiting(true);
    };
    const onPlaying = () => {
      if (stalledAt) {
        log.player(`resumed after ${Math.round(performance.now() - stalledAt)}ms at ${fmt(video.currentTime)}`);
        stalledAt = 0;
      }
      setWaiting(false);
    };
    const onSeeked = () => {
      const t = video.currentTime;
      log.player(`seeked → ${fmt(t)}`, {
        cached: isCached(t, cachedRangesRef.current) ? "warm" : "COLD — will transcode",
      });
    };

    const events: [string, EventListener][] = [
      ["timeupdate", sync], ["progress", sync], ["play", sync], ["pause", sync],
      ["durationchange", sync], ["seeked", sync], ["seeked", onSeeked],
      ["volumechange", onVolume],
      ["waiting", onWait], ["seeking", onWait],
      ["playing", onPlaying], ["canplay", onPlaying],
    ];
    events.forEach(([e, h]) => video.addEventListener(e, h));
    return () => events.forEach(([e, h]) => video.removeEventListener(e, h));
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);

  const seekTo = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(rangeStart, Math.min(t, rangeEnd));
  }, [rangeStart, rangeEnd]);

  const skip = useCallback((delta: number) => {
    const video = videoRef.current;
    if (video) seekTo(video.currentTime + delta);
  }, [seekTo]);

  const goLive = useCallback(() => seekTo(rangeEnd), [seekTo, rangeEnd]);

  /**
   * Seek once, when the drag ends.
   *
   * Seeking on every pointer move made hls.js flush and refetch continuously,
   * and on an un-transcoded region each intermediate position kicked off a
   * window encode.
   */
  /** Time under a clientX, clamped to the seekable range. */
  const timeAtX = useCallback((clientX: number) => {
    const el = barRef.current;
    if (!el) return rangeStart;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    return rangeStart + f * (rangeEnd - rangeStart);
  }, [rangeStart, rangeEnd]);

  /**
   * Vertical distance from the bar slows the drag, the way long-form players do
   * it. A 3.5-hour recording is ~10s per pixel, so a 1:1 drag cannot be aimed.
   */
  const factorForY = (dy: number) => {
    const d = Math.abs(dy);
    if (d < 40) return 1;
    if (d < 100) return 0.25;
    if (d < 180) return 0.1;
    return 0.04;
  };

  const onBarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const t = timeAtX(e.clientX);
    dragRef.current = { x: e.clientX, base: t };
    setFineFactor(1);
    setScrubAt(t);
    setHoverAt(null);
  }, [timeAtX]);

  const onBarPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      setHoverAt(timeAtX(e.clientX));
      return;
    }
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dy = e.clientY - (r.top + r.height / 2);
    const f = factorForY(dy);
    setFineFactor(f);
    const perPx = (rangeEnd - rangeStart) / Math.max(1, r.width);
    const t = drag.base + (e.clientX - drag.x) * perPx * f;
    setScrubAt(Math.min(rangeEnd, Math.max(rangeStart, t)));
  }, [timeAtX, rangeStart, rangeEnd]);

  // Seek once, on release, rather than on every pointer move: scrubbing a
  // 3.5 hour timeline would otherwise start a transcode per intermediate point.
  const commitScrub = useCallback(() => {
    setScrubAt((at) => {
      if (at !== null) seekTo(at);
      return null;
    });
  }, [seekTo]);

  const onBarPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setFineFactor(1);
    commitScrub();
  }, [commitScrub]);

  const onBarKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Arrows nudge precisely; shift makes it coarse.
    const steps: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: 1, ArrowDown: -1,
      PageUp: 60, PageDown: -60,
    };
    const dir = steps[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const mag = Math.abs(dir) === 60 ? 60 : (e.shiftKey ? 30 : 5);
    seekTo((videoRef.current?.currentTime ?? 0) + Math.sign(dir) * mag);
  }, [seekTo]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  // iOS Safari uses webkitEnterFullscreen on the video element itself;
  // standard requestFullscreen() is not supported on iOS.
  const enterFullscreen = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!video) return;
    if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else video.requestFullscreen?.();
  }, []);

  /**
   * Click zones across the video surface: left two fifths rewind, middle fifth
   * toggles play, right two fifths skip forward. Deliberately invisible — no
   * overlay or icon feedback.
   *
   * Controls sit above this and stop propagation, so buttons and the scrubber
   * are unaffected.
   */
  const handleSurfaceClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    resetHideTimerRef.current?.();
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.4) skip(-10);
    else if (x > 0.6) skip(30);
    else togglePlay();
  }, [skip, togglePlay]);

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowControls(false), 3500);
  }, []);

  useEffect(() => { resetHideTimerRef.current = resetHideTimer; }, [resetHideTimer]);

  // `tabloDebug()` in the console dumps everything at once, mid-problem.
  useEffect(() => installSnapshot(() => {
    const v = videoRef.current;
    return {
      source: isLive ? "live" : `recording ${('recording' in source) ? source.recording.object_id : ""}`,
      title,
      position: fmt(v?.currentTime ?? 0),
      duration: fmt(v?.duration ?? 0),
      paused: v?.paused, readyState: v?.readyState, muted: v?.muted,
      seekable: timeRangesToArray(v?.seekable).map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(", "),
      buffered: timeRangesToArray(v?.buffered).map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(", "),
      cacheState,
      cachedRanges: rangesLabel(cachedRangesRef.current),
      atCachedPoint: isCached(v?.currentTime ?? 0, cachedRangesRef.current),
      mediaError: v?.error?.message ?? null,
    };
  }), [isLive, source, title, cacheState]);

  useEffect(() => {
    const timer = setTimeout(() => setShowControls(false), 3500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "q") onClose();
      if (e.key === "f") enterFullscreen();
      if (e.key === "m") toggleMute();
      if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
      if (e.key === "ArrowLeft") skip(-10);
      if (e.key === "ArrowRight") skip(10);
      resetHideTimer();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, enterFullscreen, toggleMute, togglePlay, skip, resetHideTimer]);

  const span = Math.max(1, rangeEnd - rangeStart);
  const shownPos = scrubAt ?? position;
  const pct = Math.min(100, Math.max(0, ((shownPos - rangeStart) / span) * 100));
  const scrubbing = scrubAt !== null;
  const encoding = !isLive && cacheState !== "complete";
  // Drawn from the real encoded ranges. A single bar scaled by percent-complete
  // would be wrong the moment the viewer seeks: jumping an hour in leaves the
  // opening cached and starts a separate island further along.
  /**
   * Cached regions, each split at the playhead.
   *
   * The played fill is drawn over the bar, so a single band per region left the
   * cached parts of the past invisible. Splitting gives four readable states:
   * played+cached, played-only, cached-ahead, and untouched track.
   *
   * Keyed by position rather than array index — indices shift when a new island
   * appears, which would make React reuse a node and animate a band sliding
   * across the bar instead of growing in place.
   */
  const readyBands = (isLive ? [[rangeStart, rangeEnd] as [number, number]] : cachedRanges)
    .flatMap(([from, to]) => {
      const a = ((from - rangeStart) / span) * 100;
      const b = ((to - rangeStart) / span) * 100;
      const out: { key: string; left: number; width: number; played: boolean }[] = [];
      if (a < pct) {
        out.push({ key: `p${from}`, left: a, width: Math.min(b, pct) - a, played: true });
      }
      if (b > pct) {
        out.push({ key: `f${from}`, left: Math.max(a, pct), width: b - Math.max(a, pct), played: false });
      }
      return out.filter(x => x.width > 0);
    });

  let programRemaining = 0;
  if (program) {
    const start = new Date(program.start).getTime();
    const dur = (program.duration || 0) * 1000;
    programRemaining = Math.max(0, Math.round((start + dur - now) / 60000));
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black flex items-center justify-center"
      onMouseMove={resetHideTimer}
      onClick={handleSurfaceClick}
    >
      {/* No autoPlay attribute: usePlayer starts playback explicitly. Leaving it
          on let the browser resume by itself whenever the element received data
          after a stall, so pause would not stick and playback could jump. */}
      <video ref={videoRef} className="w-full h-full object-contain" playsInline />

      {(loading || combinedError) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/70">
          {loading && (
            <>
              <div className="w-10 h-10 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              <p className="text-white/60 text-sm">Starting stream…</p>
            </>
          )}
          {combinedError && (
            <>
              <p className="text-red-400 text-sm max-w-xs text-center">{combinedError}</p>
              <button onClick={onClose} className="px-4 py-2 rounded-lg glass text-sm hover:bg-white/10 transition">
                Close
              </button>
            </>
          )}
        </div>
      )}

      {/* Landing in a window that has not been encoded yet blocks until the
          backend finishes it. Say so rather than showing a frozen frame. */}
      {waiting && !loading && !combinedError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-sm">
            <div className="w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            {encoding && (
              <span className="text-white/80 text-[11px] uppercase tracking-widest">Transcoding</span>
            )}
          </div>
        </div>
      )}

      <div
        className={`absolute inset-0 flex flex-col justify-between p-6 transition-opacity duration-300 pointer-events-none
          ${showControls ? "opacity-100" : "opacity-0"}`}
        style={{
          // Sized in pixels to the two bands that actually hold content — the
          // title block and the transport — rather than as a percentage, which
          // darkened a third of the frame at each end.
          background:
            "linear-gradient(to bottom," +
            " rgba(0,0,0,0.62) 0, rgba(0,0,0,0) 88px," +
            " rgba(0,0,0,0) calc(100% - 132px), rgba(0,0,0,0.88) 100%)",
        }}
      >
        {/* Top bar — just the close affordance; the title sits under the bar */}
        <div className="flex items-start justify-end pointer-events-auto">
          <button
            onClick={onClose}
            className="w-10 h-10 shrink-0 rounded-full glass flex items-center justify-center hover:bg-white/10 transition"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>

        {/* Bottom: scrubber + transport */}
        <div className="flex flex-col gap-3 pointer-events-auto">

          <div className="flex items-center gap-3">
            <span className="text-[11px] tabular-nums text-white/60 w-16 text-right shrink-0">
              {formatTime(isLive ? position - rangeEnd : position - rangeStart)}
            </span>

            <div
              ref={barRef}
              role="slider"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={rangeStart}
              aria-valuemax={rangeEnd}
              aria-valuenow={Math.round(shownPos)}
              aria-valuetext={formatTime(shownPos - rangeStart)}
              className="relative flex-1 h-5 flex items-center group/bar touch-none cursor-pointer
                         outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded"
              onPointerDown={onBarPointerDown}
              onPointerMove={onBarPointerMove}
              onPointerUp={onBarPointerUp}
              onPointerCancel={onBarPointerUp}
              onPointerLeave={() => !scrubbing && setHoverAt(null)}
              onKeyDown={onBarKeyDown}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Untouched: neither played nor transcoded */}
              <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/15" />

              {/* Played but not transcoded */}
              <div
                className="absolute left-0 h-1.5 rounded-full bg-accent/35"
                style={{ width: `${pct}%` }}
              />

              {/* Transcoded: solid accent behind the playhead, white ahead of it */}
              {readyBands.map((b) => (
                <div
                  key={b.key}
                  className={`absolute h-1.5 rounded-full ${scrubbing ? "" : "transition-[width,left] duration-[2800ms] ease-linear"}
                              ${b.played ? "bg-accent" : "bg-white/50"}`}
                  style={{ left: `${b.left}%`, width: `${b.width}%` }}
                />
              ))}

              {/* Hover target, before committing to it */}
              {hoverAt !== null && !scrubbing && (
                <div
                  className="absolute w-0.5 h-3 bg-white/60 -translate-x-1/2 pointer-events-none rounded"
                  style={{ left: `${((hoverAt - rangeStart) / span) * 100}%` }}
                />
              )}

              {/* Thumb */}
              <div
                className={`absolute w-3.5 h-3.5 rounded-full bg-accent shadow ring-2 ring-black/40
                            -translate-x-1/2 pointer-events-none transition-transform
                            group-hover/bar:scale-125 ${scrubbing ? "scale-150" : ""}`}
                style={{ left: `${pct}%` }}
              />

              {/* Readout: follows the drag, or previews the hover target. At ~10
                  seconds per pixel on a long recording the bar alone cannot be
                  aimed, so the number is the actual control surface. */}
              {(scrubbing || hoverAt !== null) && (
                <div
                  className="absolute -top-8 -translate-x-1/2 px-2 py-1 rounded-md
                             bg-black/90 text-[11px] tabular-nums text-white
                             pointer-events-none whitespace-nowrap shadow-lg"
                  style={{ left: `${scrubbing ? pct : ((hoverAt! - rangeStart) / span) * 100}%` }}
                >
                  {formatTime((scrubbing ? shownPos : hoverAt!) - rangeStart)}
                  {scrubbing && fineFactor < 1 && (
                    <span className="ml-1.5 text-accent">1/{Math.round(1 / fineFactor)}</span>
                  )}
                </div>
              )}
            </div>

            <span className="text-[11px] tabular-nums text-white/60 w-16 shrink-0">
              {isLive ? "LIVE" : formatTime(rangeEnd - rangeStart)}
            </span>
          </div>

          <div className="relative flex items-center justify-between">
            {/* What is playing — centered between the transport groups. Absolute
                so its width cannot shift the controls either side of it. */}
            <div
              className="absolute left-1/2 -translate-x-1/2 max-w-[44%] text-center
                         pointer-events-none select-none"
              // A crisp outline rather than a blurred shadow: over flat white
              // content a soft shadow reads as a smudge. `paint-order: stroke`
              // draws the stroke beneath the fill, so the glyphs keep their
              // weight instead of bulking the way a plain text-stroke would.
              style={{
                WebkitTextStroke: "3px rgba(0,0,0,0.45)",
                paintOrder: "stroke fill",
              }}
            >
              {subtitle && (
                <p className="text-[10px] font-semibold tracking-widest text-white/80 uppercase truncate">
                  {subtitle}
                </p>
              )}
              <p className="text-sm font-bold truncate leading-tight">{title}</p>
              {program && (
                <p className="text-[10px] text-white/80 tabular-nums mt-0.5">
                  {clockTime(program.start)} · {programRemaining}m left
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                className="w-9 h-9 rounded-lg glass flex items-center justify-center hover:bg-white/10 transition"
                title={paused ? "Play (Space)" : "Pause (Space)"}
              >
                {paused
                  ? <Play className="w-4 h-4" fill="currentColor" aria-hidden />
                  : <Pause className="w-4 h-4" fill="currentColor" aria-hidden />}
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); skip(-10); }}
                className="flex items-center gap-1 px-2.5 h-9 rounded-lg glass hover:bg-white/10 transition"
                title="Back 10s (Left arrow)"
                aria-label="Back 10 seconds"
              >
                <RotateCcw className="w-4 h-4" aria-hidden />
                <span className="text-[10px] font-black tabular-nums">10</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); skip(30); }}
                className="flex items-center gap-1 px-2.5 h-9 rounded-lg glass hover:bg-white/10 transition"
                title="Forward 30s (Right arrow)"
                aria-label="Forward 30 seconds"
              >
                <RotateCw className="w-4 h-4" aria-hidden />
                <span className="text-[10px] font-black tabular-nums">30</span>
              </button>

              {isLive && (
                <button
                  onClick={(e) => { e.stopPropagation(); if (!atLiveEdge) goLive(); }}
                  disabled={atLiveEdge}
                  className={`flex items-center gap-2 px-3 h-9 rounded-lg transition text-sm font-medium
                    ${atLiveEdge ? "text-white/80 cursor-default" : "glass hover:bg-white/10 text-accent"}`}
                  title={atLiveEdge ? "At live edge" : "Jump to live"}
                >
                  <span className={`w-2 h-2 rounded-full ${atLiveEdge ? "bg-red-500 animate-pulse" : "bg-white/40"}`} />
                  {atLiveEdge ? "LIVE" : "GO LIVE"}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                className="w-9 h-9 rounded-lg glass flex items-center justify-center hover:bg-white/10 transition"
                title={muted ? "Unmute (M)" : "Mute (M)"}
              >
                {muted
                  ? <VolumeX className="w-4 h-4" aria-hidden />
                  : <Volume2 className="w-4 h-4" aria-hidden />}
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); enterFullscreen(); }}
                className="w-9 h-9 rounded-lg glass flex items-center justify-center hover:bg-white/10 transition"
                title="Fullscreen (F)"
              >
                <Maximize className="w-4 h-4" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
