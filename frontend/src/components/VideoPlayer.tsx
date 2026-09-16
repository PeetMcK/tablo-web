import { useEffect, useRef, useState, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQuery } from "@tanstack/react-query";
import {
  X, Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Maximize,
  PictureInPicture2,
} from "lucide-react";
import { PictureInPictureExit } from "./icons";
import { usePlayer } from "../hooks/usePlayer";
import { api, previewUrl } from "../api/tablo";
import type {
  Channel, Program, Recording, CacheState, EncodingProgress,
} from "../api/tablo";
import { log, fmt, isCached, rangesLabel, timeRangesToArray, installSnapshot } from "../lib/debug";
import {
  airingAt, clampSkip, covers, LIVE_EDGE_MARGIN, LIVE_EDGE_THRESHOLD,
  programWindow, readyRange, type LiveAnchor,
} from "../lib/playback";

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

/**
 * How long to wait after releasing the scrubber before actually seeking.
 *
 * Long enough that a fumbled release can be corrected, short enough not to feel
 * like lag. Only matters on cold regions, where the seek commits an encoder.
 */
const COMMIT_DEBOUNCE_MS = 280;

/**
 * How long a stall must last before it earns the waiting overlay.
 *
 * The media element reports a stall the instant the playhead moves, so a skip
 * into buffered video announces one and takes it back a millisecond later.
 * Painting on the event itself strobed the panel on every press of the skip
 * buttons — dozens of times a minute during normal watching, each one lasting
 * a few frames. A real wait, the kind this overlay exists to explain, is a
 * window being encoded and runs for seconds; it still shows, a beat late.
 */
const STALL_GRACE_MS = 1000;

/** Must not exceed the backend's LIVE_DVR_MINUTES window (default 60). */
const LIVE_DVR_SECONDS = 3600;

/**
 * Encoder lead a live stream needs before playback starts, in seconds.
 *
 * Two segments at the backend's HLS_TIME of 6s: hls.js will not start on one.
 * Used as the denominator of the progress shown while the stream is blocked.
 */
const LIVE_LEAD_SECONDS = 12;

/**
 * How often a live session says it is still wanted, in milliseconds.
 *
 * Well inside the backend's LIVE_IDLE_SECONDS (default 120), which is what
 * reaps a transcode whose player is gone — several heartbeats have to be missed
 * before a session that is merely slow is taken for an abandoned one.
 */
const KEEPALIVE_MS = 30_000;

/**
 * Seeking into an un-encoded window makes the backend transcode it before
 * responding. A cold window is ~30s on CPU, and landing on its last segment
 * means waiting for the whole thing, so the 20s default is far too tight.
 */
const RECORDING_FRAG_TIMEOUT = 120_000;

/**
 * How far ahead to buffer a recording.
 *
 * hls.js defaults to 30s, tuned for a network you do not control. These
 * segments come off local disk in 20-50ms, so a deep buffer is nearly free and
 * covers any window that takes a moment to encode. Kept to a few minutes rather
 * than the whole recording: on a partially cached one, pulling far ahead would
 * demand cold windows the viewer may never reach.
 */
const RECORDING_BUFFER_SECONDS = 180;

/**
 * How far up from the bottom of a pop-out window summons the transport.
 *
 * Generous enough to catch a pointer on its way down without being so tall
 * that half a small window counts as the control area.
 */
const PIP_BAR_REACH = 96;

/**
 * Legibility halo for chrome that sits bare on the gradient scrim.
 *
 * The scrim only reaches full strength at the very edge of the frame: at the
 * scrubber row it is about a third of its peak, which over dark video lands on
 * a mid grey that neither theme's text clears — the light theme's ink measures
 * 1.2:1 there and the dark theme's white 1.5:1 over bright video.
 *
 * The halo is the scrim colour itself, so it always pushes the immediate
 * surround away from the glyphs: near-white behind ink in light, black behind
 * white in dark. Over the near-black the dark theme already sits on it is
 * invisible, so dark's common case is unchanged — this is the same trick the
 * title block plays with `WebkitTextStroke`, at a weight that suits 11px text.
 */
const SCRIM_HALO = {
  textShadow:
    "0 0 2px rgb(var(--c-player-scrim) / 0.9), 0 0 6px rgb(var(--c-player-scrim) / 0.75)",
} as const;

/**
 * The same halo for an SVG glyph, which `text-shadow` does not reach.
 *
 * Only the Close button needs it: it sits high in the top band, where the scrim
 * has already faded to about a third, while the transport buttons sit deep
 * enough in the bottom band to clear AA on their own.
 */
const SCRIM_HALO_ICON = {
  filter:
    "drop-shadow(0 0 2px rgb(var(--c-player-scrim) / 0.9)) drop-shadow(0 0 5px rgb(var(--c-player-scrim) / 0.75))",
} as const;

/**
 * A hard outline for chrome that sits bare on the video.
 *
 * `ring-shade` could not do this job. `shade` is the SHADOW colour, and light
 * deliberately keeps its shadows weak (a 12% ink wash), so over mid-grey video
 * the handle's ring measured 1.2:1 against the frame behind it while the accent
 * fill measured 2.2:1 — the handle simply disappeared. A shadow colour is asked
 * to sit *under* chrome; an outline has to sit *against video*, and only one of
 * those jobs has a right answer per theme.
 *
 * Both tones are here rather than one, because one is provably not enough. The
 * scrim tints everything behind the transport toward itself — in light it lifts
 * even black video to a mid grey, in dark it drops white video to one — so the
 * ground is only ever *biased*, never fixed, and a single outline loses at one
 * end of it. Measured on the three extremes of video (black / mid grey / white)
 * under the ~34% scrim the scrubber row actually sits on:
 *
 *   light, scrim-coloured ring alone:  6.5  2.1  1.1   <- loses on bright video
 *   light, player-fg ring alone:       2.2  6.4 13.1   <- loses on dark video
 *   dark,  scrim-coloured ring alone:  1.0  2.8  8.6   <- loses on dark video
 *   dark,  player-fg ring alone:      16.8  6.4  2.2   <- loses on bright video
 *
 * Stacking them means the two rings are adjacent and 12-19:1 apart from each
 * other, so whichever one the video swallows, the other draws the edge:
 * 6.4:1 worst case in both themes. This is the same move SCRIM_HALO
 * makes for text, with the second tone added because the fill between the rings
 * is the accent — a mid tone that belongs to neither end.
 */
const MEDIA_OUTLINE = {
  boxShadow:
    "0 0 0 2px rgb(var(--c-player-scrim) / 0.95)," +
    " 0 0 0 3.5px rgb(var(--c-player-fg) / 0.9)",
} as const;

/**
 * The hover marker's outline: one ring, at 1px.
 *
 * It needs only one tone because the marker itself is `player-fg`, so the mark
 * and its scrim-coloured ring are already the two-tone pair the handle has to
 * build out of rings. Worst case 6.5:1 light, 7.4:1 dark.
 */
const MEDIA_OUTLINE_THIN = {
  boxShadow: "0 0 0 1px rgb(var(--c-player-scrim) / 0.95)",
} as const;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** The three invisible click targets across the picture. */
type SurfaceZone = "back" | "play" | "forward";

/**
 * Which zone a point across the frame falls in: two fifths, one, two.
 *
 * One definition for both the click and the highlight that previews it. Two
 * copies of these fractions would be free to drift, and a button that lights
 * up without being the one that fires is worse than no highlight at all.
 */
function zoneAtEvent(e: React.MouseEvent<HTMLDivElement>): SurfaceZone | null {
  const rect = e.currentTarget.getBoundingClientRect();
  if (!rect.width) return null;
  const x = (e.clientX - rect.left) / rect.width;
  if (x < 0.4) return "back";
  if (x > 0.6) return "forward";
  return "play";
}

/**
 * What `Stage` renders from. Assembled by VideoPlayer, handed across
 * unchanged, and destructured back into the same names on arrival.
 */
interface PlayerView {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  rootRef: React.RefObject<HTMLDivElement | null>;
  // No host ref here, deliberately. Each stage keeps its own — see `Stage`.
  placeVideo: (host: HTMLDivElement, forPip: boolean) => void;
  barRef: React.RefObject<HTMLDivElement | null>;
  showControls: boolean;
  resetHideTimer: () => void;
  handleSurfaceClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  holdControls: (held: boolean) => void;
  loading: boolean;
  combinedError: string | null;
  onClose: () => void;
  waiting: boolean;
  waitPct: number | null;
  /**
   * Whether this stage is the one in the popped-out window.
   *
   * The markup is the same either side, so anything that differs between the
   * two has to be told which side it is on: the chrome sizes down to the
   * smaller window, and the picture-in-picture button turns around — out of
   * the tab there, back into it here.
   */
  poppedOut: boolean;
  togglePictureInPicture: () => void;
  enterFullscreen: () => void;
  paused: boolean;
  togglePlay: () => void;
  skip: (delta: number) => void;
  muted: boolean;
  toggleMute: () => void;
  isLive: boolean;
  atLiveEdge: boolean;
  goLive: () => void;
  title: string;
  subtitle: string | null;
  program: Program | null | undefined;
  programRemaining: number;
  barStart: number;
  barEnd: number;
  span: number;
  pct: number;
  shownPos: number;
  rangeEnd: number;
  readyBands: { key: string; left: number; width: number }[];
  hoverAt: number | null;
  scrubbing: boolean;
  shownPreview: string | null;
  fineFactor: number;
  onBarPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onBarPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onBarPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onBarKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  setHoverAt: (t: number | null) => void;
  formatTime: (seconds: number) => string;
  clockTime: (iso: string) => string;
  clockAt: (t: number) => string;
  onProgramBar: boolean;
  position: number;
  previewAt: number | null;
  rangeStart: number;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function VideoPlayer({ source, onClose, startAt = 0, autoPlay = true, onPosition }: Props) {
  const isLive = source.kind === "live";
  /**
   * The one video element, made here rather than rendered.
   *
   * Two React roots render the stage — the tab's and the picture-in-picture
   * window's — and each would build a `<video>` of its own from the same JSX.
   * Only one element can carry the stream: hls.js attaches a MediaSource to
   * it, and a second element would start from nothing. So it is created once,
   * owned by nobody, and appended to whichever host is mounted.
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  if (!videoRef.current) {
    const video = document.createElement("video");
    video.className = "w-full h-full object-contain";
    video.playsInline = true;
    // Suppresses the browser's own floating picture-in-picture button, which
    // sits in the middle of the frame in browser chrome rather than ours. It
    // also closes off `requestPictureInPicture`, which is why the pop-out
    // goes through the Document Picture-in-Picture API instead.
    //
    // Only where that API exists to replace it. Safari implements no Document
    // Picture-in-Picture, so our own button never renders there; taking the
    // native one away as well would leave that browser with no
    // picture-in-picture at all, which is a loss rather than a trade.
    if ("documentPictureInPicture" in window) video.disablePictureInPicture = true;
    videoRef.current = video;
  }
  /** The whole player. What goes fullscreen, so the chrome goes with it. */
  const rootRef = useRef<HTMLDivElement>(null);

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
    maxBufferLength: isLive ? undefined : RECORDING_BUFFER_SECONDS,
  });

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [muted, setMuted] = useState(false);
  /** True while the stage is mounted on a picture-in-picture window instead. */
  const [poppedOut, setPoppedOut] = useState(false);
  const [paused, setPaused] = useState(!openPlaying);
  const [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState(0);
  // Where the user is dragging, independent of where playback actually is.
  // Rendering the real position during a drag made the thumb fight the pointer.
  const [scrubAt, setScrubAt] = useState<number | null>(null);
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  /**
   * Where playback has been told to go but has not arrived yet.
   *
   * Seeking into an un-encoded region waits on a transcode. Falling straight
   * back to the video's currentTime meanwhile snapped the playhead back to
   * where the scrub started, so the bar disagreed with what was about to play.
   */
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [fineFactor, setFineFactor] = useState(1);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; base: number } | null>(null);
  /** Throttles preview seeks during a drag. */
  const lastPreviewRef = useRef(0);
  /** Pending commit, so a re-grab can replace it instead of queueing another. */
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [cacheState, setCacheState] = useState<CacheState | null>(null);
  const [cachedRanges, setCachedRanges] = useState<[number, number][]>([]);
  /** Progress of the window playback is waiting on, when one is being encoded. */
  const [encodingAt, setEncodingAt] = useState<EncodingProgress | null>(null);
  /**
   * Ties this session's media clock to the wall clock, so the bar can be drawn
   * over a broadcast schedule. Set once, from the first playlist that exists.
   */
  const [anchor, setAnchor] = useState<LiveAnchor | null>(null);
  /** True while a live channel is served through FFmpeg rather than proxied raw. */
  const [liveTranscoded, setLiveTranscoded] = useState(false);
  /** Seconds of live video the encoder has produced, null before its first frame. */
  const [liveEncoded, setLiveEncoded] = useState<number | null>(null);
  /** Last scrub-preview frame that finished decoding. */
  const [shownPreview, setShownPreview] = useState<string | null>(null);
  // Media listeners are attached once on mount, so they need a live view of the
  // ranges rather than the value captured in that first closure.
  const cachedRangesRef = useRef<[number, number][]>([]);
  const [now, setNow] = useState(() => Date.now());
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const resetHideTimerRef = useRef<(() => void) | null>(null);
  const onPositionRef = useRef(onPosition);

  const combinedError = apiError || playerError;

  /**
   * The channel's schedule, so the bar can re-scale when one show ends and the
   * next begins. Read from the stored guide, so it costs no device round trip;
   * a channel the mirror has never seen comes back empty and the airing the
   * player was opened with carries on.
   */
  const { data: schedule } = useQuery({
    queryKey: ["channel-airings", isLive ? source.channel.identifier : null],
    queryFn: () => api.channelAirings((source as { channel: Channel }).channel.identifier),
    enabled: isLive,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });

  // `now` ticks every 20s, which is what moves the bar on at the top of the
  // hour: the airing covering the clock changes, and everything derived from it
  // follows.
  //
  // The airing the player was opened with is the last candidate rather than an
  // unconditional fallback: it is put through the same "does it cover now"
  // test, so a channel the mirror knows nothing about keeps it until it ends
  // and then hands the bar back to the DVR window. Kept unconditionally it
  // outlived its own broadcast - at 9:05 the bar still read "8:00 PM" and the
  // title still named the finished show.
  const openedWith = isLive ? source.program ?? null : null;
  /**
   * The wall-clock instant being watched.
   *
   * Identical to now at the live edge, and the whole point anywhere else: a
   * viewer paused or rewound across the top of the hour is still watching the
   * earlier programme, and the bar has to describe that one. Picked by the
   * clock instead, the bar re-scaled to a show the viewer was not watching,
   * stranding the thumb at the far left of it with the wrong title above.
   *
   * The real playhead, not `shownPos`: a bar that re-scaled mid-drag would
   * move the target out from under the pointer.
   */
  const watchedMs = anchor ? anchor.wallMs + (position - anchor.media) * 1000 : now;
  const program = isLive
    ? airingAt(schedule?.airings ?? [], watchedMs)
      ?? (covers(openedWith, watchedMs) ? openedWith : null)
    : null;

  const title = isLive
    ? (program?.title || source.channel.display_name)
    : (source.recording.title ?? "Recording");
  const subtitle = isLive
    ? source.channel.display_name
    : (source.recording.subtitle ?? "");

  const atLiveEdge = isLive && rangeEnd - position < LIVE_EDGE_THRESHOLD;

  /**
   * What the bar is drawn over, in media seconds.
   *
   * For live with a known airing this is the airing itself — 8:00 to 9:00 —
   * so the playhead reads as a position inside the programme rather than
   * against a buffer that grows a second per second.
   *
   * Everything below stays in media seconds. Only what the bar is scaled by
   * changes; what playback may *reach* is still `[rangeStart, rangeEnd]`.
   */
  const liveWindow = isLive ? programWindow(program, anchor) : null;
  const barStart = liveWindow ? liveWindow[0] : rangeStart;
  // An airing that runs long must not push the live edge off its own bar.
  const barEnd = liveWindow ? Math.max(liveWindow[1], rangeEnd) : rangeEnd;
  /** True when the bar spans a broadcast, so its ends are clock times. */
  const onProgramBar = Boolean(liveWindow && anchor);

  /**
   * A point on the media timeline, written as the clock time it airs at.
   *
   * Only meaningful on a programme bar - elsewhere there is no wall clock to
   * map onto, and the label falls back to elapsed time.
   */
  const clockAt = (mediaSeconds: number): string =>
    anchor
      ? new Date(anchor.wallMs + (mediaSeconds - anchor.media) * 1000)
          .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "";

  // The parent builds `source` as an object literal, so it is a new reference on
  // every one of its renders. Keying the start effect on the object would tear
  // the player down and reload it from the beginning whenever the parent
  // re-rendered - a React Query refetch was enough to do it mid-playback.
  const sourceKey = isLive
    ? `live:${source.channel.identifier}`
    : `rec:${source.recording.object_id}`;
  const sourceRef = useRef(source);

  /**
   * Everything tied to one stream, cleared when a different one opens.
   *
   * A new source means a new encoder and a new media clock: carried over, the
   * old numbers showed the incoming channel as fully transcoded before it had
   * produced a frame, and would place its programme an arbitrary distance from
   * where the bar thinks zero is. Done during render rather than in an effect —
   * React's own prescription for state that follows a prop, and the effect
   * version cost a second render on every open.
   */
  // Declared before the start effect so the ref is current by the time it runs.
  useEffect(() => { sourceRef.current = source; });
  useEffect(() => { onPositionRef.current = onPosition; }, [onPosition]);
  useEffect(() => { cachedRangesRef.current = cachedRanges; }, [cachedRanges]);

  // A new source means a new encoder, so the previous one's numbers must not
  // carry over — they showed the incoming channel as fully transcoded before it
  // had produced a frame.
  //
  // Reset during render rather than from the start effect below. Setting state
  // in an effect body queues a second render with the stale values already
  // painted, and React flags it (`react-hooks/set-state-in-effect`) because
  // that cascade is exactly what made this player tear itself down and reload
  // on earlier occasions. Comparing the key here is React's documented way to
  // adjust state when a prop changes: the re-render happens before anything
  // reaches the screen.
  // The anchor goes with them: it ties a media clock to the wall clock, and a
  // new stream has a new media clock, so keeping the old one would place the
  // incoming channel's programme an arbitrary distance from where the bar
  // thinks zero is.
  const [renderedSource, setRenderedSource] = useState(sourceKey);
  if (renderedSource !== sourceKey) {
    setRenderedSource(sourceKey);
    setLiveTranscoded(false);
    setLiveEncoded(null);
    setAnchor(null);
  }

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
          //
          // Anything not known to be OTT counts as a broadcast: a guide row
          // that arrives without a kind used to fall through to the raw stream,
          // which parses no fragment and buffers forever. Transcoding an OTT
          // channel needlessly only costs CPU.
          const transcode = current.channel.kind === "ott" ? undefined : true;
          const r = await api.startStream(current.channel.identifier, transcode);
          if (cancelled) return;
          log.player(`open live ${current.channel.display_name}`, {
            kind: current.channel.kind, transcode: !!transcode,
            session: r.session_id, url: r.stream_url,
          });
          setSessionId(r.session_id);
          setLiveTranscoded(!!r.transcoded);
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

  // Scrub preview target. Declared here rather than beside the other
  // render-time values because the preloading effect below depends on it.
  // Live has no stored thumbnail pack; recordings do.
  const previewId = isLive ? null : source.recording.object_id;
  const previewAt = scrubAt ?? hoverAt;
  const previewSrc = previewId !== null && previewAt !== null
    ? previewUrl(previewId, previewAt)
    : null;

  /**
   * Hold the last frame that finished decoding.
   *
   * Pointing an <img> straight at the moving URL blanks it on every change, and
   * keying it by src was worse still - React remounted the element each time.
   * Decoding off-screen first and swapping only on success means the strip
   * never goes empty, and a timestamp with no stored frame simply leaves the
   * previous one up instead of flashing a broken image.
   */
  useEffect(() => {
    if (!previewSrc) return;
    let live = true;
    const img = new Image();
    img.onload = () => { if (live) setShownPreview(previewSrc); };
    img.src = previewSrc;
    return () => { live = false; };
  }, [previewSrc]);

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
        setEncodingAt(s.encoding ?? null);
        if (s.state === "complete") clearInterval(id);
      } catch {
        /* transient - keep polling */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [isLive, cacheState, sourceKey]);

  // ------------------------------------------------- live encoder progress
  /**
   * Live opens on an encoder that has produced nothing yet: FFmpeg writes its
   * first segment only after HLS_TIME seconds of video, so the player sits on a
   * black frame with no idea how long it will last. Polling how much video
   * exists turns that into a real percentage of the lead it needs.
   *
   * It keeps polling once the picture arrives, a great deal slower, because the
   * call is also this session's heartbeat. The backend kills a live transcode
   * nobody has asked about — the tuner it holds is real and a closed laptop
   * sends no goodbye — and segment fetches alone are the wrong thing for it to
   * listen to: a player paused on live fills its buffer and then asks for
   * nothing, while being watched in every sense that matters.
   */
  useEffect(() => {
    if (!isLive || !liveTranscoded || !sessionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.transcodeStatus(sessionId);
        if (!cancelled) setLiveEncoded(s.encoded_seconds);
      } catch {
        /* transient — keep polling */
      }
    };
    tick();
    const id = setInterval(tick, waiting || loading ? 1000 : KEEPALIVE_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [isLive, liveTranscoded, sessionId, waiting, loading]);

  // Live program progress is wall-clock driven, not stream driven. Runs for any
  // live source, not only one that already has an airing: this tick is also
  // what picks the airing up when the schedule arrives, and what hands the bar
  // over to the next show at the top of the hour.
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, [isLive]);

  // ------------------------------------------------------------ transport
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const sync = () => {
      setPosition(video.currentTime);
      // Arrived (or the player moved on its own) — stop overriding the bar.
      setPendingSeek((want) =>
        want !== null && Math.abs(video.currentTime - want) < 1.5 ? null : want,
      );
      onPositionRef.current?.(video.currentTime);
      setPaused(video.paused);
      const sk = video.seekable;
      if (sk.length > 0) {
        setRangeStart(sk.start(0));
        setRangeEnd(sk.end(sk.length - 1));
        // The one reading that ties this session's media clock to the wall
        // clock. Taken when a playlist first exists and never again — the live
        // edge is now, so the two can be converted from here on. Keeping the
        // first reading rather than the latest is what holds the bar still;
        // re-anchoring would slide the programme under the playhead.
        setAnchor((held) => held ?? { wallMs: Date.now(), media: sk.end(sk.length - 1) });
      } else if (Number.isFinite(video.duration)) {
        setRangeStart(0);
        setRangeEnd(video.duration);
      }
    };
    const onVolume = () => setMuted(video.muted);
    let stalledAt = 0;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const onWait = () => {
      // Already counting: a seek fires `seeking` and `waiting` back to back,
      // and re-arming on the second would push the overlay a grace further out
      // every time the element twitched.
      if (grace !== undefined) return;
      stalledAt = performance.now();
      const t = video.currentTime;
      log.warn(`stalled at ${fmt(t)}`, {
        cachedHere: isCached(t, cachedRangesRef.current),
        buffered: timeRangesToArray(video.buffered).map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(", ") || "none",
        readyState: video.readyState,
      });
      grace = setTimeout(() => setWaiting(true), STALL_GRACE_MS);
    };
    const onPlaying = () => {
      clearTimeout(grace);
      grace = undefined;
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
    return () => {
      clearTimeout(grace);
      events.forEach(([e, h]) => video.removeEventListener(e, h));
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
    const target = Math.max(rangeStart, Math.min(t, rangeEnd));
    setPendingSeek(target);
    video.currentTime = target;
  }, [rangeStart, rangeEnd]);

  /**
   * Jump by `delta`, held inside what is playable right now.
   *
   * Live is the whole DVR window, ending at the live edge; a partially cached
   * recording is the run the playhead stands in, across both the encoder's
   * report and the browser's own buffer. The buffer has to be in there: it is
   * read fresh here while the report is a 3s poll of 60s windows, and playback
   * routinely runs minutes past the last window the report knows about. The
   * scrubber is still free to go anywhere and wait.
   */
  const skip = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const from = video.currentTime;
    const range = readyRange(from, {
      ranges: cachedRangesRef.current,
      buffered: timeRangesToArray(video.buffered),
      start: rangeStart,
      end: rangeEnd,
      whole: isLive || cacheState === "complete",
    });
    // A live edge is a frontier the encoder is still extending, so a skip has
    // to stop well short of it. Anywhere else `hi` is a settled end.
    const target = clampSkip(from, delta, range, isLive ? LIVE_EDGE_MARGIN : undefined);
    // Already as far that way as there is anything to go. Seeking again would
    // land on the spot it is already on, and every one of those announces
    // itself as a stall — thirteen in a row, in the log that found this.
    if (Math.abs(target - from) < 0.25) return;
    seekTo(target);
  }, [seekTo, isLive, cacheState, rangeStart, rangeEnd]);

  /**
   * Back to the live edge — stopping the same distance short of it as a skip.
   *
   * Seeking onto the frontier itself lands where the encoder has not reached,
   * so Go Live bought a stall every time, most visibly after a pause. Ten
   * seconds behind still reads as live: the badge's own threshold for "at the
   * edge" is wider than this, so the button correctly greys out on arrival.
   */
  const goLive = useCallback(
    () => seekTo(Math.max(rangeStart, rangeEnd - LIVE_EDGE_MARGIN)),
    [seekTo, rangeStart, rangeEnd],
  );

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
    if (!el) return barStart;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    // The bar's own domain, which on live is the airing. What comes back is a
    // wish, not a destination: `seekTo` clamps it to what exists, so a pointer
    // in the part of the hour that has not been broadcast snaps to the live
    // edge rather than seeking into nothing.
    return barStart + f * (barEnd - barStart);
  }, [barStart, barEnd]);

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

  /**
   * Show the frame under the playhead while dragging, where that is free.
   *
   * Seeking on every pointer move is exactly what the commit-on-release design
   * avoids: on a cold region each intermediate position would start its own
   * window transcode. Inside an already-encoded region there is no such cost -
   * cached segments serve from disk in 22-55ms - so the preview is limited to
   * those, and a drag across uncached territory simply shows the last frame it
   * could reach until release.
   */
  const previewSeek = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    const cached = isLive || cachedRanges.some(([a, b]) => t >= a && t <= b);
    if (!cached) return;
    // A seek per pointer event would queue faster than they can complete.
    const now = performance.now();
    if (now - lastPreviewRef.current < 120) return;
    if (Math.abs(video.currentTime - t) < 0.5) return;
    lastPreviewRef.current = now;
    video.currentTime = t;
  }, [cachedRanges, isLive]);

  const onBarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // Supersede a commit that has not fired yet.
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Held to what exists, exactly as the drag below is. `timeAtX` speaks the
    // bar's domain, which on a programme bar runs past the live edge into time
    // that has not been broadcast; without this a click out there threw the
    // thumb into the future for the length of the commit debounce, and drove
    // `liveLead` negative, which reads on screen as "Buffering 0%".
    const t = Math.min(rangeEnd, Math.max(rangeStart, timeAtX(e.clientX)));
    dragRef.current = { x: e.clientX, base: t };
    setFineFactor(1);
    setScrubAt(t);
    setHoverAt(null);
  }, [timeAtX, rangeStart, rangeEnd]);

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
    const perPx = (barEnd - barStart) / Math.max(1, r.width);
    const t = drag.base + (e.clientX - drag.x) * perPx * f;
    const target = Math.min(rangeEnd, Math.max(rangeStart, t));
    setScrubAt(target);
    previewSeek(target);
    // The clamp stays on what exists, never on the bar's wider domain.
  }, [timeAtX, rangeStart, rangeEnd, barStart, barEnd, previewSeek]);

  /**
   * Seek once, shortly after release, rather than on every pointer move.
   *
   * Scrubbing a 3.5 hour timeline would otherwise start a transcode per
   * intermediate point. The short delay matters as much: landing on a cold spot
   * commits the encoder to it, so releasing a few pixels off and grabbing again
   * used to mean waiting out a transcode of somewhere you did not want. Within
   * the window a re-grab simply replaces the target.
   */
  const commitScrub = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      setScrubAt((at) => {
        if (at !== null) seekTo(at);
        return null;
      });
    }, COMMIT_DEBOUNCE_MS);
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

  /**
   * Fullscreen the player, not the picture inside it.
   *
   * Calling this on the `<video>` promotes that element alone, so the browser
   * supplies its own transport and every part of ours — the programme-spanning
   * bar, the cached bands, thumbnail scrubbing, the skip buttons — is left
   * outside the fullscreen element and simply vanishes. Promoting the
   * container takes the whole player up with it, and the chrome is the same
   * chrome at both sizes.
   *
   * iOS is the exception and has to stay one: Safari there implements only
   * `webkitEnterFullscreen`, on the video element, with its native controls.
   * There is no arbitrary-element fullscreen to reach for.
   */
  const enterFullscreen = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (video?.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
    (rootRef.current ?? video)?.requestFullscreen?.();
  }, []);

  /**
   * Pop the picture out into its own always-on-top window, and back.
   *
   * The browser already offered this, as a floating button of its own in the
   * middle of the frame — browser chrome rather than ours, and a moving target
   * to hit. The only way a page can take that button away is
   * `disablePictureInPicture`, which also closes the ordinary
   * `requestPictureInPicture` door, so the pop-out goes through the Document
   * Picture-in-Picture API: it hands back an empty always-on-top window and
   * the page furnishes it.
   *
   * What we put in it is the video element itself, moved. Re-rendering it
   * there instead would build a second element, and the stream is attached to
   * this one — hls.js feeds it through a MediaSource, so a fresh element would
   * start over from nothing. Moving keeps the buffer, the playhead and the
   * attachment; the window is furnished with the picture and nothing else,
   * which is what the browser's own version showed too.
   */

  /**
   * Put the one video element in `host`, and make it work there.
   *
   * Three things, and all three are needed. The move itself, which no React
   * root can do because the element belongs to none of them. Rebinding the
   * stream, because hls.js publishes its MediaSource as a `blob:` URL owned
   * by the document that made it — carried across and back, that URL stops
   * resolving and the next append kills the stream outright. And resuming,
   * because taking a media element out of a document pauses it.
   */
  /**
   * A second video element showing the same picture, for the pop-out window.
   *
   * Carrying the real element across was tried and cannot be made to work.
   * Two independent walls: hls.js feeds it through a MediaSource published as
   * a `blob:` URL owned by the document that created it, so the stream dies
   * on arrival with a fatal bufferAppendError; and a picture-in-picture
   * window is a fresh document with no user activation, so `play()` there is
   * refused outright however it is timed.
   *
   * A mirror has neither problem. `captureStream` hands out the tracks the
   * element is already decoding, the mirror plays them with no MediaSource of
   * its own, and it is muted — the one case the autoplay policy allows
   * without a gesture. The sound stays on the original, in the tab, where the
   * gesture happened. The controls drive the original too; this element only
   * ever shows.
   */
  const mirrorRef = useRef<HTMLVideoElement | null>(null);

  const openMirror = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & {
      captureStream?: () => MediaStream;
    }) | null;
    if (!video?.captureStream) return false;
    const mirror = document.createElement("video");
    mirror.className = "w-full h-full object-contain";
    mirror.playsInline = true;
    mirror.muted = true;
    mirror.autoplay = true;
    mirror.srcObject = video.captureStream();
    mirrorRef.current = mirror;
    return true;
  }, []);

  const closeMirror = useCallback(() => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    (mirror.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    mirror.srcObject = null;
    mirror.remove();
    mirrorRef.current = null;
  }, []);

  /**
   * Put the right element in `host`: the real one in the tab, the mirror in
   * the pop-out. Neither ever crosses between documents.
   */
  const placeVideo = useCallback((host: HTMLDivElement, forPip: boolean) => {
    const el = forPip ? mirrorRef.current : videoRef.current;
    if (el && el.parentElement !== host) host.append(el);
  }, []);

  const pipWindow = useRef<Window | null>(null);
  /** The live shortcut handler, so a new pop-out can be given it too. */
  const keyHandler = useRef<((e: KeyboardEvent) => void) | null>(null);
  const pipRoot = useRef<Root | null>(null);
  /**
   * The latest view, for the popped-out root to render.
   *
   * A ref because the effect that re-renders that root is declared before the
   * view is built, and effects run after the render that fills this in.
   */
  const viewRef = useRef<PlayerView | null>(null);

  const togglePictureInPicture = useCallback(async () => {
    const video = videoRef.current;
    const dpip = (window as unknown as { documentPictureInPicture?: {
      requestWindow: (o?: { width?: number; height?: number }) => Promise<Window>;
    } }).documentPictureInPicture;
    if (!video || !dpip) return;

    if (pipWindow.current) { pipWindow.current.close(); return; }

    try {
      // No size, no position: the browser reopens the window where the viewer
      // last left it, and neither is ours to set — `resizeTo` is refused on a
      // picture-in-picture window and there are no coordinates to pass.
      const w = await dpip.requestWindow();
      pipWindow.current = w;

      // The window arrives with no styles at all, so every class the stage
      // uses has to be carried over or it lands there unstyled.
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const css = Array.from(sheet.cssRules).map((r) => r.cssText).join("");
          const style = w.document.createElement("style");
          style.textContent = css;
          w.document.head.append(style);
        } catch {
          // A sheet we are not allowed to read. Ours are same-origin, so
          // there is nothing here worth failing the pop-out over.
        }
      }
      w.document.title = title;
      w.document.body.style.cssText = "margin:0;overflow:hidden";

      // A React root of the window's own. This is the whole point: React
      // delegates events to the root container, so a stage merely moved into
      // this document would fire its clicks where nothing is listening —
      // which is exactly what happened. A root here listens here.
      const mount = w.document.createElement("div");
      w.document.body.append(mount);
      openMirror();
      pipRoot.current = createRoot(mount);
      if (keyHandler.current) w.addEventListener("keydown", keyHandler.current);
      setPoppedOut(true);

      // However it closes — our button, the window's own, the tab going away
      // — the root has to come down and the video come home, or the player is
      // left with nothing to show.
      w.addEventListener("pagehide", () => {
        pipRoot.current?.unmount();
        closeMirror();
        pipRoot.current = null;
        pipWindow.current = null;
        setPoppedOut(false);
        // The stage puts the picture back when it remounts in the tab, and it
        // does that as one step with resuming playback — the move pauses the
        // element whichever way it goes. Appending here as well would move it
        // first and leave that remount with nothing to notice, so the video
        // would come home stopped.
      }, { once: true });
    } catch (e) {
      // Refused for want of a user gesture, or not implemented here after all.
      log.warn("picture-in-picture rejected", e);
    }
  }, [title]);

  // A player torn down while popped out would leave the window orphaned,
  // holding a video element that no longer belongs to anything.
  useEffect(() => () => pipWindow.current?.close(), []);

  // Keep the popped-out root in step. It renders the same stage from the same
  // view, so every state change in here reaches that window too — without
  // this it would show the moment it was opened at, frozen.
  useEffect(() => {
    const view = viewRef.current;
    if (pipRoot.current && view) pipRoot.current.render(<Stage view={view} pip />);
  });

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
    const zone = zoneAtEvent(e);
    if (zone === "back") skip(-10);
    else if (zone === "forward") skip(30);
    else if (zone === "play") togglePlay();
  }, [skip, togglePlay]);

  /**
   * Keeps the chrome up while the cursor is resting on the transport.
   *
   * Fading out from under a hand that is on its way to the scrubber is the
   * complaint; a pointer parked there is a viewer mid-decision, not an idle
   * one. Held in a ref rather than state because the timer closure reads it
   * and nothing renders from it.
   *
   * The region is the transport cluster itself, which sits inside the overlay's
   * own gutter — so the true corners of the frame, outside the controls, go on
   * timing out as before.
   */
  const cursorOnTransport = useRef(false);

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (cursorOnTransport.current) return;
    hideTimer.current = setTimeout(() => setShowControls(false), 3500);
  }, []);

  const holdControls = useCallback((held: boolean) => {
    cursorOnTransport.current = held;
    resetHideTimer();
  }, [resetHideTimer]);

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

  // The opening fade, scheduled through the same timer every other reset uses.
  // It used to keep a timer of its own, which knew nothing about the cursor
  // resting on the transport and hid the controls out from under it — and
  // which no reset could cancel, so it fired once whatever the viewer did.
  useEffect(() => {
    resetHideTimerRef.current?.();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Bare-key shortcuts ("q" to close, space/"k" to play/pause, and so
      // on) are normal for a media player, but this listener is global — it
      // fires no matter what has focus. Without this guard, typing into any
      // text field anywhere on the page (the topbar search box, the Cmd-K
      // palette) is read as player shortcuts: "q" in "Quantico" closes the
      // video out from under the typist, and a space anywhere in the query
      // toggles play/pause instead of reaching the input. Anything that
      // looks like text entry gets the keystroke to itself instead.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      // Escape dismisses the nearest thing, and while the picture is out in
      // its own window that is the window — not the player behind it. Closing
      // the player from here would take away a pop-out the viewer was
      // watching and the programme with it.
      if (e.key === "Escape" || e.key === "q") {
        if (poppedOut) togglePictureInPicture();
        else onClose();
      }
      if (e.key === "f") enterFullscreen();
      // Symmetrical with the button: out if it is in, in if it is out.
      if (e.key === "p") togglePictureInPicture();
      if (e.key === "m") toggleMute();
      if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
      if (e.key === "ArrowLeft") skip(-10);
      if (e.key === "ArrowRight") skip(10);
      resetHideTimer();
    };
    window.addEventListener("keydown", handler);
    // The pop-out is a window of its own: while it has focus its keys go to
    // it and never reach this one, so it is given the same handler. Added
    // here for a window already open, and at open time for one that is not.
    pipWindow.current?.addEventListener("keydown", handler);
    keyHandler.current = handler;
    return () => {
      window.removeEventListener("keydown", handler);
      pipWindow.current?.removeEventListener("keydown", handler);
      if (keyHandler.current === handler) keyHandler.current = null;
    };
  }, [onClose, enterFullscreen, toggleMute, togglePlay, skip, resetHideTimer,
      poppedOut, togglePictureInPicture]);

  const span = Math.max(1, barEnd - barStart);
  // Priority: the live drag, then a seek in flight, then where playback is.
  const shownPos = scrubAt ?? pendingSeek ?? position;
  const pct = Math.min(100, Math.max(0, ((shownPos - barStart) / span) * 100));
  const scrubbing = scrubAt !== null;
  /**
   * Percent of the blocking window that exists, or null when there is nothing
   * real to show - a stall with no encode behind it keeps the spinner.
   */
  const encodePct = encodingAt && encodingAt.segments_total > 0
    ? Math.min(99, Math.round(
        (encodingAt.segments_ready / encodingAt.segments_total) * 100))
    : null;
  /**
   * How much of the lead a live stream needs before it can play, as a percent.
   *
   * Playback resumes once there is enough video ahead of the playhead, so that
   * gap — not wall-clock time — is the honest thing to show while waiting.
   *
   * Two different measures of it, because neither covers both cases. Before the
   * first playlist there is no timeline to measure against, so the lead is
   * everything FFmpeg has encoded. Once a playlist exists the frontier is read
   * from the timeline itself: FFmpeg's clock counts from the start of the
   * session, which after an hour of sliding window is no longer the same origin
   * as the player's, and subtracting across the two would read a stall as 100%.
   */
  const liveLead = rangeEnd > 0 ? rangeEnd - shownPos : liveEncoded;
  const livePct = isLive && liveTranscoded && liveLead !== null
    ? Math.min(100, Math.max(0, Math.round((liveLead / LIVE_LEAD_SECONDS) * 100)))
    : null;
  const waitPct = encodePct ?? livePct;
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
    .map(([from, to]) => {
      // Clipped to the bar: on live, the DVR window can reach back before the
      // airing began, and that part belongs to the previous programme.
      const a = ((Math.max(from, barStart) - barStart) / span) * 100;
      const b = ((Math.min(to, barEnd) - barStart) / span) * 100;
      return { key: `c${from}`, left: a, width: b - a };
    })
    .filter(x => x.width > 0);

  let programRemaining = 0;
  if (program) {
    const start = new Date(program.start).getTime();
    const dur = (program.duration || 0) * 1000;
    programRemaining = Math.max(0, Math.round((start + dur - now) / 60000));
  }

  /**
   * Everything the stage renders from, as one object.
   *
   * The stage is rendered by two React roots — the tab's, and one mounted on
   * the picture-in-picture window — and a second root cannot reach the first
   * one's context. So the whole view is handed over explicitly and
   * destructured back into the same names on the other side, which is what
   * keeps the markup itself identical in both places.
   */
  const view: PlayerView = {
    videoRef, rootRef, barRef, placeVideo,
    showControls, resetHideTimer, handleSurfaceClick, holdControls,
    loading, combinedError, onClose, waiting, waitPct,
    poppedOut, togglePictureInPicture, enterFullscreen,
    paused, togglePlay, skip, muted, toggleMute,
    isLive, atLiveEdge, goLive, title, subtitle, program, programRemaining,
    barStart, barEnd, span, pct, shownPos, rangeEnd,
    readyBands, hoverAt, scrubbing, shownPreview, fineFactor,
    onBarPointerDown, onBarPointerMove, onBarPointerUp, onBarKeyDown, setHoverAt,
    formatTime, clockTime, clockAt, onProgramBar, position, previewAt, rangeStart,
  };

  viewRef.current = view;

  // Popped out, the stage stays mounted here but hands the picture over and
  // steps behind the way back.
  //
  // Mounted, not removed: unmounting it takes the host out of the document,
  // and with nowhere for the element to be between one root's commit and the
  // other's the browser pauses it — a media element removed from a document
  // is paused on the next task unless it is back in one by then. Two hosts,
  // both always present, make every hand-over a move rather than a removal.
  return (
    <>
      {poppedOut && (
        <div className="dark fixed inset-0 z-[60] bg-media flex flex-col items-center
                        justify-center gap-4">
          <button
            onClick={togglePictureInPicture}
            className="w-20 h-20 rounded-full glass text-player-fg flex items-center
                       justify-center hover:bg-fill transition"
            title="Close picture-in-picture"
            aria-label="Close picture-in-picture"
          >
            <PictureInPictureExit className="w-9 h-9" aria-hidden />
          </button>
          <p className="text-player-fg-muted text-sm">Close picture-in-picture</p>
        </div>
      )}
      <Stage view={view} pip={false} />
    </>
  );
}

/**
 * The player's whole surface, rendered from a view rather than its own state.
 *
 * Separated for one reason: it has to be mountable inside a
 * picture-in-picture window, on a React root of that window's own, because
 * React delegates its events to the root container and a subtree merely moved
 * into another document fires them where nothing is listening. Everything in
 * here is presentation; the state and the handlers belong to VideoPlayer.
 */
function Stage({ view, pip }: { view: PlayerView; pip: boolean }) {
  const {
    rootRef, barRef, placeVideo,
    showControls, resetHideTimer, handleSurfaceClick, holdControls,
    loading, combinedError, onClose, waiting, waitPct,
    poppedOut, togglePictureInPicture, enterFullscreen,
    paused, togglePlay, skip, muted, toggleMute,
    isLive, atLiveEdge, goLive, title, subtitle, program, programRemaining,
    barStart, barEnd, span, pct, shownPos, rangeEnd,
    readyBands, hoverAt, scrubbing, shownPreview, fineFactor,
    onBarPointerDown, onBarPointerMove, onBarPointerUp, onBarKeyDown, setHoverAt,
    formatTime, clockTime, clockAt, onProgramBar, position, previewAt, rangeStart,
  } = view;

  /**
   * Where this stage puts the picture — one host per stage, never shared.
   *
   * Sharing a single ref across both stages is what broke pop-in: the two
   * hosts write to the same ref, the pop-out mounts second and so wins it,
   * and the tab's stage then reads that ref on its next render and appends
   * the real element into the *pop-out's* host. Closing the window destroyed
   * the document with the picture still inside it, which reset the element to
   * time zero and left hls.js appending into it — a fatal bufferAppendError
   * at fragment 0, every time.
   */
  const videoHostRef = useRef<HTMLDivElement>(null);

  /**
   * Whether the pop-out's controls are showing.
   *
   * A window of a few hundred pixels is nearly all picture, and chrome that
   * appears because the pointer moved anywhere in it would be up almost
   * permanently. So there it is the bottom strip alone that summons the
   * transport, and the rest of the frame leaves the programme alone. Local to
   * the stage because it is presentation and nothing outside needs it.
   */
  const [barHover, setBarHover] = useState(false);
  const chromeUp = poppedOut ? barHover : showControls;

  /**
   * Read from the pointer's height, not from entering and leaving a strip.
   *
   * A strip would sit under the transport it summons, so the controls
   * appearing on top of it would fire its own mouseleave and take them away
   * again. Measuring against the frame cannot contradict itself that way.
   */
  const trackBottomHover = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setBarHover(rect.height > 0 && rect.bottom - e.clientY <= PIP_BAR_REACH);
  }, []);

  /**
   * Lights the button that a click on the picture would press.
   *
   * The zones are deliberately invisible — no overlay, no icon — which leaves
   * nothing to say they exist or which one the pointer is in. Borrowing the
   * matching button's own hover state answers both, in the place the viewer
   * is already looking, and costs the frame nothing.
   */
  const [hoverZone, setHoverZone] = useState<SurfaceZone | null>(null);

  const trackZone = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const zone = zoneAtEvent(e);
    // Returning the held value makes React bail out of the render, so a
    // pointer crossing the frame renders three times rather than per pixel.
    setHoverZone((held) => (held === zone ? held : zone));
  }, []);

  const onStageMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (poppedOut) trackBottomHover(e);
    else resetHideTimer();
    trackZone(e);
  }, [poppedOut, trackBottomHover, resetHideTimer, trackZone]);

  const onStageLeave = useCallback(() => {
    setBarHover(false);
    setHoverZone(null);
  }, []);

  /** Crossing onto the controls surrenders the borrowed highlight. */
  const holdAndRelease = useCallback((held: boolean) => {
    holdControls(held);
    if (held) setHoverZone(null);
  }, [holdControls]);

  /** The hover a zone lends a button, matching its own `hover:bg-fill`. */
  const lent = (zone: SurfaceZone) => (hoverZone === zone ? "bg-fill" : "");

  // Whichever root mounted this stage, the one video element belongs in its
  // host. Called from here rather than done in VideoPlayer so it cannot race
  // the other root's commit: by the time this runs, the host below exists.
  useEffect(() => {
    const host = videoHostRef.current;
    // The tab hosts the real element and the pop-out hosts the mirror, so
    // each stage fills its own host and nothing is ever taken from the other.
    if (host) placeVideo(host, pip);
  });

  // The tab's stage while the picture is out: all it owes anyone is a home
  // for the real element, which keeps playing there and feeds the mirror.
  // Drawing its chrome too would put a second set of controls in the document
  // — duplicates that answer queries, take clicks, and read as a bug.
  if (!pip && poppedOut) {
    return (
      <div className="dark fixed inset-0 z-50 bg-media flex items-center justify-center">
        <div ref={videoHostRef} className="w-full h-full" />
      </div>
    );
  }

  return (
    // `dark`, unconditionally. The player is the one surface that does not
    // follow the theme: it is a fullscreen media UI sitting on frames we do not
    // control, and light chrome around video reads as a rendering fault rather
    // than a theme. Every other player in the category does the same.
    //
    // This works because the token blocks in index.css are written as `:root`
    // and `.dark` — a plain class selector, not `:root.dark`. Putting `dark` on
    // this subtree redeclares all 104 custom properties for it, and custom
    // properties inherit, so the entire player resolves to dark values. That
    // covers the page-palette tokens it uses (bg-fill, accent, danger, shade)
    // as well as its own player-* family, which pinning the player tokens alone
    // would have missed. No call site in this file needs to know.
    <div
      ref={rootRef}
      // The pointer goes with the chrome. A cursor left sitting over the
      // picture is the one piece of interface that never faded, and on a
      // fullscreen frame it is the only thing on screen that is not the
      // programme. Any movement brings both back.
      className={`dark fixed inset-0 z-50 bg-media flex items-center justify-center
        ${showControls ? "" : "cursor-none"}`}
      onMouseMove={onStageMove}
      onMouseLeave={onStageLeave}
      onClick={handleSurfaceClick}
    >
      {/* An empty host. The video element is not rendered here — it is made
          once, imperatively, and moved into whichever host is currently
          mounted (see `ensureVideo`). It has to be, because this stage is
          rendered by two different React roots — the tab's and the
          picture-in-picture window's — and a JSX `<video>` would give each
          root an element of its own. The stream is attached to one element
          through a MediaSource; a second would start from nothing. */}
      <div ref={videoHostRef} className="w-full h-full" />

      {/* A blocking sheet, not a see-through veil: it carries text and a button,
          so it uses the player's own panel rather than a scrim. In light that is
          a frosted white plate with ink text; in dark it is the same near-black
          wash it always was. */}
      {(loading || combinedError) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-player-panel">
          {loading && (
            <>
              <div className="w-10 h-10 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              <p className="text-player-fg-muted text-sm">Starting stream…</p>
            </>
          )}
          {combinedError && (
            <>
              <p className="text-danger text-sm max-w-xs text-center">{combinedError}</p>
              <button onClick={onClose} className="px-4 py-2 rounded-lg glass text-sm text-player-fg hover:bg-fill transition">
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
          <div className="flex flex-col gap-2 px-4 py-3 rounded-2xl bg-player-panel backdrop-blur-sm
                          min-w-[190px]">
            <div className="flex items-center gap-2.5">
              {/* Only spin when there is nothing real to report. */}
              {waitPct === null && (
                <div className="w-4 h-4 rounded-full border-2 border-accent
                                border-t-transparent animate-spin" />
              )}
              <span className="text-player-fg-muted text-[11px] uppercase tracking-widest">
                {/* Always the viewer's word for it. Whether the wait is an
                    encoder working or bytes arriving is our distinction, not
                    theirs — both look like a paused picture, and "Buffering"
                    is the one everyone already knows. */}
                Buffering
              </span>
              {/* Full muted weight, not a dimmed one: the player ladder has no
                  rung below `muted`, and thinning it with an opacity modifier
                  put an 11px readout at 2.9:1 on the light panel. The label
                  beside it is already set apart by its tracking and case. */}
              {waitPct !== null && (
                <span className="ml-auto text-player-fg-muted text-[11px] tabular-nums">
                  {waitPct}%
                </span>
              )}
            </div>
            {/* Segments of the blocking window land in order, so this is real
                progress toward playback rather than a decorative animation.
                On live it is the encoder's lead instead, which fills the same
                way and means the same thing: how close playback is to starting. */}
            {waitPct !== null && (
              <div className="h-1 rounded-full bg-player-track overflow-hidden">
                <div
                  className="accent-gradient-x h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.max(4, waitPct)}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className={`absolute inset-0 flex flex-col transition-opacity duration-300 pointer-events-none
          ${poppedOut ? "justify-end p-2" : "justify-between p-6"}
          ${chromeUp ? "opacity-100" : "opacity-0"}`}
        style={{
          // Sized in pixels to the two bands that actually hold content — the
          // title block and the transport — rather than as a percentage, which
          // darkened a third of the frame at each end.
          //
          // The scrim is a theme token, not a fixed black: it is what makes the
          // controls legible over arbitrary video, so in light it lays down a
          // near-white plate for the ink chrome exactly as dark lays down a
          // black one for the white chrome.
          //
          // Popped out there is nothing along the top to make legible — no
          // close button, no title — so the wash there would only be a shadow
          // over the picture.
          background: poppedOut
            ? "linear-gradient(to bottom," +
              " rgb(var(--c-player-scrim) / 0) calc(100% - 96px)," +
              " rgb(var(--c-player-scrim) / var(--c-player-scrim-a)) 100%)"
            : "linear-gradient(to bottom," +
              " rgb(var(--c-player-scrim) / var(--c-player-scrim-soft-a)) 0," +
              " rgb(var(--c-player-scrim) / 0) 88px," +
              " rgb(var(--c-player-scrim) / 0) calc(100% - 132px)," +
              " rgb(var(--c-player-scrim) / var(--c-player-scrim-a)) 100%)",
        }}
      >
        {/* Top bar — just the close affordance; the title sits under the bar.
            Not in a pop-out: that window has its own close button, and ours
            would only sit over the picture offering to shut the whole player
            when all the viewer wanted was the window gone. */}
        {!poppedOut && (
          <div className="flex items-start justify-end pointer-events-auto">
            <button
              onClick={onClose}
              className="w-10 h-10 shrink-0 rounded-full glass text-player-fg flex items-center justify-center hover:bg-fill transition"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" aria-hidden style={SCRIM_HALO_ICON} />
            </button>
          </div>
        )}

        {/* Bottom: scrubber + transport. Resting the cursor anywhere in here
            holds the chrome up — see `cursorOnTransport`. */}
        <div
          className="flex flex-col gap-3 pointer-events-auto"
          onMouseEnter={() => holdAndRelease(true)}
          onMouseLeave={() => holdAndRelease(false)}
        >

          <div className="flex items-center gap-3">
            <span
              className="text-[11px] tabular-nums text-player-fg-muted w-16 text-right shrink-0"
              style={SCRIM_HALO}
            >
              {onProgramBar
                ? clockAt(barStart)
                : formatTime(isLive ? position - rangeEnd : position - rangeStart)}
            </span>

            {/* The slider announces the bar's own domain, so the value it
                reports stays inside the bounds it reports. Against the seekable
                range a programme bar read out positions well past its own
                maximum - an hour-long airing on a fifteen-minute buffer
                announced 3600 out of 900. */}
            <div
              ref={barRef}
              role="slider"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={barStart}
              aria-valuemax={barEnd}
              aria-valuenow={Math.round(Math.min(barEnd, Math.max(barStart, shownPos)))}
              aria-valuetext={onProgramBar ? clockAt(shownPos) : formatTime(shownPos - rangeStart)}
              // The focus ring has to read on video we do not control, and at
              // `ring-accent/60` it did not: the accent diluted into whatever
              // was behind it, measuring 1.2-2.5:1 in light and 1.3-2.8:1 in
              // dark across black, mid-grey and white video. Undiluting it is
              // not enough on its own — full accent over a blue frame is still
              // 1.4:1 — so the ring keeps its accent identity and gains a
              // scrim-coloured offset band between itself and the video. That
              // is the handle's two-tone trick in Tailwind's own vocabulary:
              // the band/ring edge is 4.77:1 in light and 6.40:1 in dark on
              // every ground, and on the grounds where the band disappears
              // (white video in light, black in dark) the ring itself is at
              // 5.0:1 / 6.4:1 against the video instead.
              className="relative flex-1 h-5 flex items-center group/bar touch-none cursor-pointer
                         outline-none rounded focus-visible:ring-2 focus-visible:ring-accent
                         focus-visible:ring-offset-2
                         focus-visible:ring-offset-[color:rgb(var(--c-player-scrim))]"
              onPointerDown={onBarPointerDown}
              onPointerMove={onBarPointerMove}
              onPointerUp={onBarPointerUp}
              onPointerCancel={onBarPointerUp}
              onPointerLeave={() => !scrubbing && setHoverAt(null)}
              onKeyDown={onBarKeyDown}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Untouched: neither played nor transcoded */}
              <div className="absolute inset-x-0 h-1.5 rounded-full bg-player-track" />

              {/* Played but not transcoded */}
              <div
                className="absolute left-0 h-1.5 rounded-full bg-accent/35"
                style={{ width: `${pct}%` }}
              />

              {/* Transcoded extent. This is the only thing that grows on its
                  own, so it is the only thing that eases - it advances in
                  window-sized jumps as encoding completes, and easing hides
                  the step.

                  Width only. Where a band *starts* is not something that grows:
                  it changes when the DVR window rolls or the bar it is measured
                  against moves under it, and easing that read as the cached
                  region sliding along the timeline of its own accord - a
                  motion nothing in the recording corresponds to. Snapping the
                  position and gliding only the edge leaves the one animation
                  that describes something real. */}
              {readyBands.map((b) => (
                <div
                  key={b.key}
                  className={`absolute h-1.5 rounded-full bg-player-buffered
                              ${scrubbing ? "" : "transition-[width] duration-[2800ms] ease-linear"}`}
                  style={{ left: `${b.left}%`, width: `${b.width}%` }}
                />
              ))}

              {/* The watched part of it, drawn over the top. Its right edge is
                  the playhead, so it must track exactly - easing this made the
                  fill visibly lag behind where playback actually was. */}
              {readyBands.map((b) => {
                const width = Math.min(b.left + b.width, pct) - b.left;
                return width > 0 ? (
                  <div
                    key={`w${b.key}`}
                    className="accent-gradient-x absolute h-1.5 rounded-full"
                    style={{ left: `${b.left}%`, width: `${width}%` }}
                  />
                ) : null;
              })}

              {/* Hover target, before committing to it */}
              {hoverAt !== null && !scrubbing && (
                <div
                  className="absolute w-0.5 h-3 bg-player-fg -translate-x-1/2 pointer-events-none rounded"
                  // Full weight plus the handle's outline, for the handle's
                  // reason: at 60% the marker composited into the scrimmed
                  // frame and went with it — 1.7:1 over black video in light,
                  // 1.7:1 over white video in dark. Thinning a 2px mark with an
                  // opacity modifier was never buying anything a quieter token
                  // could not. Now 6.5:1 worst case light, 7.4:1 dark.
                  style={{
                    left: `${((hoverAt - barStart) / span) * 100}%`,
                    ...MEDIA_OUTLINE_THIN,
                  }}
                />
              )}

              {/* Thumb. Its two outline tones are one stacked box-shadow — see
                  MEDIA_OUTLINE — which is why there is no `shadow ring-2
                  ring-*` here any more: an inline box-shadow would have
                  overridden both of them anyway, and neither was earning its
                  place. The `shadow` it replaces was a 1px ink drop; the outer
                  tone does that job now, in whichever direction the theme
                  needs. */}
              <div
                className={`absolute w-3.5 h-3.5 rounded-full bg-accent
                            -translate-x-1/2 pointer-events-none transition-transform
                            group-hover/bar:scale-125 ${scrubbing ? "scale-150" : ""}`}
                style={{ left: `${pct}%`, ...MEDIA_OUTLINE }}
              />

              {/* Readout: follows the drag, or previews the hover target. At ~10
                  seconds per pixel on a long recording the bar alone cannot be
                  aimed, so the number is the actual control surface. */}
              {/* w-40 is fixed on purpose, not shrink-to-fit: an absolutely
                  positioned box with no width narrows as it nears its
                  container's right edge, which made the thumbnail visibly
                  shrink as it was dragged rightwards. */}
              {(scrubbing || hoverAt !== null) && (
                <div
                  className="absolute -translate-x-1/2 pointer-events-none
                             flex flex-col items-center gap-1 w-40"
                  style={{
                    left: `${scrubbing ? pct : ((hoverAt! - barStart) / span) * 100}%`,
                    bottom: "calc(100% + 10px)",
                  }}
                >
                  {/* The device renders these itself and serves them as a BIF
                      pack, so this works over un-encoded stretches too - which
                      is the whole point, since those are the places you cannot
                      preview by seeking. */}
                  {shownPreview && previewAt !== null && (
                    <img
                      src={shownPreview}
                      alt=""
                      draggable={false}
                      className="w-full aspect-video object-cover rounded-md
                                 border border-player-border shadow-xl bg-player-panel-soft"
                    />
                  )}
                  <div className="px-2 py-1 rounded-md bg-player-panel-strong text-[11px]
                                  tabular-nums text-player-fg whitespace-nowrap shadow-lg">
                    {onProgramBar
                      ? clockAt(scrubbing ? shownPos : hoverAt!)
                      : formatTime((scrubbing ? shownPos : hoverAt!) - rangeStart)}
                    {scrubbing && fineFactor < 1 && (
                      <span className="ml-1.5 text-accent">1/{Math.round(1 / fineFactor)}</span>
                    )}
                  </div>
                </div>
              )}
            </div>

            <span
              className="text-[11px] tabular-nums text-player-fg-muted w-16 shrink-0"
              style={SCRIM_HALO}
            >
              {onProgramBar
                ? clockAt(barEnd)
                : isLive ? "LIVE" : formatTime(rangeEnd - rangeStart)}
            </span>
          </div>

          <div className="relative flex items-center justify-between">
            {/* What is playing, on the left. The transport is centered over it
                absolutely, so a long title cannot push the controls off centre. */}
            <div
              // Nothing to gain from it in a pop-out: the window is named
              // after the programme, and at that width the name and the
              // controls are fighting over the same strip of picture. The
              // element stays in place rather than being dropped, so the row
              // keeps three cells and the transport stays centred.
              className={`max-w-[30%] text-left pointer-events-none select-none
                ${poppedOut ? "invisible" : ""}`}
              // A crisp outline rather than a blurred shadow: over flat white
              // content a soft shadow reads as a smudge. `paint-order: stroke`
              // draws the stroke beneath the fill, so the glyphs keep their
              // weight instead of bulking the way a plain text-stroke would.
              //
              // The halo is the scrim colour, so it always contrasts the text
              // it surrounds: black behind white glyphs in dark, near-white
              // behind ink ones in light. Its alpha is a per-theme knob rather
              // than a shared constant — see `--c-player-scrim-halo-a`; the two
              // directions need very different strengths to read the same.
              style={{
                WebkitTextStroke:
                  "3px rgb(var(--c-player-scrim) / var(--c-player-scrim-halo-a))",
                paintOrder: "stroke fill",
              }}
            >
              {subtitle && (
                <p className="text-[10px] font-semibold tracking-widest text-player-fg-muted uppercase truncate">
                  {subtitle}
                </p>
              )}
              <p className="text-sm font-bold truncate leading-tight text-player-fg">{title}</p>
              {program && (
                <p className="text-[10px] text-player-fg-muted tabular-nums mt-0.5">
                  {clockTime(program.start)} · {programRemaining}m left
                </p>
              )}
            </div>

            {/* Transport, centered on the frame. Play sits between the two jumps
                so the hand travels the same distance either way. */}
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); skip(-10); }}
                className={`flex items-center gap-1 rounded-lg glass text-player-fg hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8 justify-center" : "px-2.5 h-9"} ${lent("back")}`}
                title="Back 10s (Left arrow)"
                aria-label="Back 10 seconds"
              >
                <RotateCcw className="w-4 h-4" aria-hidden />
                {!poppedOut && <span className="text-[10px] font-black tabular-nums">10</span>}
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                className={`rounded-lg glass text-player-fg flex items-center justify-center hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8" : "w-9 h-9"} ${lent("play")}`}
                title={paused ? "Play (Space)" : "Pause (Space)"}
              >
                {paused
                  ? <Play className="w-4 h-4" fill="currentColor" aria-hidden />
                  : <Pause className="w-4 h-4" fill="currentColor" aria-hidden />}
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); skip(30); }}
                className={`flex items-center gap-1 rounded-lg glass text-player-fg hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8 justify-center" : "px-2.5 h-9"} ${lent("forward")}`}
                title="Forward 30s (Right arrow)"
                aria-label="Forward 30 seconds"
              >
                <RotateCw className="w-4 h-4" aria-hidden />
                {!poppedOut && <span className="text-[10px] font-black tabular-nums">30</span>}
              </button>
            </div>

            <div className="flex items-center gap-2">
              {isLive && (
                <button
                  onClick={(e) => { e.stopPropagation(); if (!atLiveEdge) goLive(); }}
                  disabled={atLiveEdge}
                  className={`flex items-center gap-2 px-3 h-9 rounded-lg transition text-sm font-medium
                    ${atLiveEdge
                      ? "text-player-fg-muted cursor-default"
                      : "bg-player-panel-strong text-accent hover:text-accent-strong"}`}
                  // The disabled state is bare on the scrim, so it needs the
                  // halo the way the timecodes either side of the scrubber do.
                  // The enabled state used to be bare too, on `.glass` - a 4.5%
                  // wash that contributes nothing - which left the accent label
                  // at 4.36:1 in light, because the scrim has decayed to ~0.61
                  // of its peak by the transport row and composites to a mid
                  // grey that defeats ink and white alike. A real panel fixes
                  // it at the source: 5.4:1 worst case across both themes over
                  // any video. The halo is harmless on an opaque panel.
                  style={SCRIM_HALO}
                  title={atLiveEdge ? "At live edge" : "Jump to live"}
                >
                  {/* The live dot is semantic red in both themes. */}
                  <span className={`w-2 h-2 rounded-full ${atLiveEdge ? "bg-danger-solid animate-pulse" : "bg-player-fg/40"}`} />
                  {atLiveEdge ? "LIVE" : "GO LIVE"}
                </button>
              )}

              <button
                onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                className={`rounded-lg glass text-player-fg flex items-center justify-center hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8" : "w-9 h-9"}`}
                title={muted ? "Unmute (M)" : "Mute (M)"}
              >
                {muted
                  ? <VolumeX className="w-4 h-4" aria-hidden />
                  : <Volume2 className="w-4 h-4" aria-hidden />}
              </button>

              {/* Only where the API exists. Safari has no Document
                  Picture-in-Picture, so the button would promise nothing
                  there — better absent than dead. */}
              {"documentPictureInPicture" in window && (
                <button
                  onClick={(e) => { e.stopPropagation(); togglePictureInPicture(); }}
                  className={`rounded-lg glass text-player-fg flex items-center justify-center hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8" : "w-9 h-9"}`}
                  title={poppedOut ? "Close picture-in-picture" : "Picture in picture"}
                  aria-label={poppedOut ? "Close picture-in-picture" : "Picture in picture"}
                >
                  {/* The same button either side of the pop-out, so the icon
                      carries which way it goes: the plain frame out of the
                      tab, the arrow back into it. */}
                  {poppedOut
                    ? <PictureInPictureExit className="w-4 h-4" aria-hidden />
                    : <PictureInPicture2 className="w-4 h-4" aria-hidden />}
                </button>
              )}

              {/* Not offered from a pop-out. A picture-in-picture window
                  cannot take itself fullscreen — the request is refused there
                  — so the button could only ever have done nothing. */}
              {!poppedOut && (
                <button
                  onClick={(e) => { e.stopPropagation(); enterFullscreen(); }}
                  className="w-9 h-9 rounded-lg glass text-player-fg flex items-center
                             justify-center hover:bg-fill transition"
                  title="Fullscreen (F)"
                >
                  <Maximize className="w-4 h-4" aria-hidden />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
