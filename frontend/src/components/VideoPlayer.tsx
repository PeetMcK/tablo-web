import { useEffect, useRef, useState, useCallback } from "react";
import { X, Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Maximize } from "lucide-react";
import { usePlayer } from "../hooks/usePlayer";
import { api } from "../api/tablo";
import type { Channel, Recording, CacheState } from "../api/tablo";

/**
 * What the player is showing. Live and recordings share the whole transport —
 * only the title block, the badge, and which API starts the stream differ.
 */
export type PlaybackSource =
  | { kind: "live"; channel: Channel }
  | { kind: "recording"; recording: Recording };

interface Props {
  source: PlaybackSource;
  onClose: () => void;
}

/** Must not exceed the backend's LIVE_DVR_MINUTES window (default 60). */
const LIVE_DVR_SECONDS = 3600;

/** Within this many seconds of the seekable end counts as "at the live edge". */
const LIVE_EDGE_THRESHOLD = 12;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function VideoPlayer({ source, onClose }: Props) {
  const isLive = source.kind === "live";
  const videoRef = useRef<HTMLVideoElement>(null);

  const { load, destroy, error: playerError } = usePlayer(videoRef, {
    // Live keeps the DVR window buffered so rewind has something to land on;
    // a cached recording is fully on disk, so nothing needs evicting.
    backBufferLength: isLive ? LIVE_DVR_SECONDS : Infinity,
    // Recordings start at the beginning. Live follows the edge.
    startPosition: isLive ? -1 : 0,
  });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [position, setPosition] = useState(0);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [cacheState, setCacheState] = useState<CacheState | null>(null);
  const [progress, setProgress] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const combinedError = apiError || playerError;
  const title = isLive ? source.channel.display_name : (source.recording.title ?? "Recording");
  const subtitle = isLive
    ? (source.channel.network || source.channel.kind.toUpperCase())
    : (source.recording.subtitle ?? "");
  const atLiveEdge = isLive && rangeEnd - position < LIVE_EDGE_THRESHOLD;

  // ---------------------------------------------------------------- start
  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      try {
        if (source.kind === "live") {
          // OTA broadcasts are MPEG-2. No browser's MSE implementation decodes
          // MPEG-2 video — hls.js demuxes the container but the video track is
          // unrenderable, leaving audio only. Always transcode OTA to H.264.
          const transcode = source.channel.kind === "ota" ? true : undefined;
          const r = await api.startStream(source.channel.identifier, transcode);
          if (cancelled) return;
          setSessionId(r.session_id);
          load(r.stream_url);
        } else {
          const r = await api.watchRecording(source.recording.object_id);
          if (cancelled) return;
          setCacheState(r.state);
          setProgress(r.progress);
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
  }, [source, load, destroy]);

  // Live sessions hold a tuner, so they must be released. Recording transcodes
  // are shared and cached — tearing one down on close would throw away work
  // another viewer may still want.
  useEffect(() => {
    return () => {
      if (sessionId) api.stopStream(sessionId).catch(() => {});
    };
  }, [sessionId]);

  // ------------------------------------------------- transcode progress poll
  useEffect(() => {
    if (isLive || cacheState !== "running") return;
    const id = setInterval(async () => {
      try {
        const s = await api.recordingStatus(source.recording.object_id);
        setCacheState(s.state);
        setProgress(s.progress);
        if (s.state !== "running") clearInterval(id);
      } catch {
        /* transient - keep polling */
      }
    }, 2000);
    return () => clearInterval(id);
  }, [isLive, cacheState, source]);

  // ------------------------------------------------------------ transport
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const sync = () => {
      setPosition(video.currentTime);
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

    video.addEventListener("timeupdate", sync);
    video.addEventListener("progress", sync);
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    video.addEventListener("durationchange", sync);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("progress", sync);
      video.removeEventListener("play", sync);
      video.removeEventListener("pause", sync);
      video.removeEventListener("durationchange", sync);
    };
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

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowControls(false), 3500);
  }, []);

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
  const pct = Math.min(100, Math.max(0, ((position - rangeStart) / span) * 100));

  return (
    <div
      className="fixed inset-0 z-50 bg-black flex items-center justify-center"
      onMouseMove={resetHideTimer}
      onClick={resetHideTimer}
    >
      <video ref={videoRef} className="w-full h-full object-contain" playsInline autoPlay muted />

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

      <div
        className={`absolute inset-0 flex flex-col justify-between p-6 transition-opacity duration-300 pointer-events-none
          ${showControls ? "opacity-100" : "opacity-0"}`}
        style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.8) 100%)" }}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between pointer-events-auto">
          <div className="min-w-0">
            {subtitle && (
              <p className="text-xs font-semibold tracking-widest text-white/50 uppercase mb-0.5 truncate">{subtitle}</p>
            )}
            <p className="text-2xl font-bold truncate">{title}</p>
          </div>
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
          {/* Still-encoding notice. Playback runs against the EVENT playlist
              while FFmpeg works ahead, so seeking is bounded by `rangeEnd`. */}
          {!isLive && cacheState === "running" && (
            <div className="flex items-center gap-3 text-xs text-white/60">
              <div className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
              <span>Preparing • {Math.round(progress * 100)}%</span>
              <div className="flex-1 h-0.5 rounded bg-white/10 overflow-hidden">
                <div className="h-full bg-accent/60 transition-all" style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <span className="text-[11px] tabular-nums text-white/60 w-14 text-right shrink-0">
              {formatTime(isLive ? position - rangeEnd : position - rangeStart)}
            </span>
            <input
              aria-label="Seek"
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={pct}
              onChange={(e) => seekTo(rangeStart + (Number(e.target.value) / 100) * span)}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 h-1 accent-accent cursor-pointer"
            />
            <span className="text-[11px] tabular-nums text-white/60 w-14 shrink-0">
              {isLive ? "LIVE" : formatTime(rangeEnd - rangeStart)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                className="w-9 h-9 rounded-lg glass flex items-center justify-center hover:bg-white/10 transition"
                title={paused ? "Play (Space)" : "Pause (Space)"}
              >
                {paused ? (
                  <Play className="w-4 h-4" fill="currentColor" aria-hidden />
                ) : (
                  <Pause className="w-4 h-4" fill="currentColor" aria-hidden />
                )}
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
                {muted ? (
                  <VolumeX className="w-4 h-4" aria-hidden />
                ) : (
                  <Volume2 className="w-4 h-4" aria-hidden />
                )}
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
