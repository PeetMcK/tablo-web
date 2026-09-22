import { useEffect, useRef, useState, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X, Play, Pause, RotateCcw, RotateCw, Volume1, Volume2, VolumeX, Maximize,
  PictureInPicture2, ClosedCaption,
} from "lucide-react";
import { PictureInPictureExit } from "./icons";
import { usePlayer } from "../hooks/usePlayer";
import { api, previewUrl } from "../api/tablo";
import type {
  Channel, Program, Recording, CacheState, EncodingProgress,
} from "../api/tablo";
import {
  log, fmt, isCached, rangesLabel, installSnapshot, timeRangesToArray,
} from "../lib/debug";
import {
  airingAt, covers, describeSkipBurst, LIVE_EDGE_MARGIN, LIVE_EDGE_THRESHOLD,
  planSkip, programWindow, readyRange, RECORDING_EDGE_MARGIN,
  SKIP_BADGE_LINGER_MS, SKIP_DEBOUNCE_MS,
  type LiveAnchor, type SkipBurst,
} from "../lib/playback";
import { nowPlayingArtwork } from "../lib/nowPlaying";
import { cardArt } from "../lib/recording";
import {
  loadSkipForward, loadSkipBack, SKIP_CONFIG_EVENT,
} from "../lib/skip";
import { clampVolume, loadVolume, saveVolume } from "../lib/volume";
import {
  createHlsSurface, DOCUMENT_FRAMES, type CaptionSource, type PlaybackSurface,
} from "../lib/playbackSurface";
import { chooseLivePath, wasmLiveEligible } from "../lib/wasmlive/capability";
import { openWasmSurface } from "../lib/wasmlive/open";
import { CaptionOverlay } from "./CaptionOverlay";
import { captionCompareRequested } from "../lib/captions/compareMode";
import { CaptionSettings } from "./CaptionSettings";
import {
  loadCaptionPreferences, saveCaptionPreferences, type CaptionPreferences,
} from "../lib/captions/preferences";
import { CHROME_BOTTOM_BAND_PX } from "../lib/playerChrome";
import { SeriesEndCard, type CardReason } from "./SeriesEndCard";

/**
 * What the player is showing. Live and recordings share the whole transport —
 * they differ in the title block, the badge, and which API starts the stream.
 */
export type PlaybackSource =
  | { kind: "live"; channel: Channel; program?: Program | null }
  | { kind: "recording"; recording: Recording };

/**
 * Ask to open at the newest thing that exists, rather than at a known second.
 *
 * For a recording still being written, "now" is not a number the caller has:
 * how much exists is only known once the stream is open, and it has moved on
 * by then anyway. Negative so it can never collide with a real position, and
 * the same convention hls.js already uses for `startPosition`.
 */
export const LIVE_EDGE = -1;

interface Props {
  source: PlaybackSource;
  onClose: () => void;
  /** Resume point in seconds, or `LIVE_EDGE` for the newest thing recorded. */
  startAt?: number;
  /** False when restoring: start paused so audio is not blocked. */
  autoPlay?: boolean;
  /** Playhead updates, so the caller can keep it in the URL. */
  onPosition?: (seconds: number) => void;
  /**
   * Play something else, chosen from the card shown at the end of a recording.
   *
   * Handed up rather than done here: which recording is open is the caller's
   * state — it is what keys this component — so switching from inside would
   * leave the two disagreeing.
   *
   * Without it the end card still appears and still closes; it just offers no
   * next episode.
   */
  onPlayRecording?: (recording: Recording) => void;
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
/**
 * How long a stream gets to produce its first caption before the CC button
 * admits there are none.
 *
 * Long, deliberately. Captions announce themselves within a second or two of
 * speech, but a programme can open on music, a title card or a silent
 * establishing shot, and greying the control out during one of those would be
 * wrong about a captioned stream. Ninety seconds is past any of that and
 * still short enough that a viewer looking for captions is not left waiting
 * on a control that will never work.
 */
const CAPTION_SILENCE_MS = 90_000;

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
 * How long the pop-out's transport stays after the pointer leaves its reach.
 *
 * Matched to the chrome's own 300ms fade with room either side: short enough
 * that a window left alone is a picture again, long enough to cross the
 * boundary without the bar strobing.
 */
const PIP_BAR_LINGER = 750;

/**
 * One rung of the volume, on the arrow keys and on the slider.
 *
 * A twentieth: twenty presses from silence to full, which is the step every
 * other player uses and fine enough that no single press is a jolt.
 */
const VOLUME_STEP = 0.05;

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
  /**
   * Captions, and the controls for them.
   *
   * `captionSource` is null wherever the surface has none — a transcode — and
   * `captionsAvailable` stays false until a cue has actually been seen, which
   * is what the button is rendered on. `surfaceTime` is a getter rather than a
   * number because the overlay reads it once per animation frame.
   */
  captionSourceAt: () => CaptionSource | null;
  captionsAvailable: boolean;
  /** Whether the stream has stayed silent long enough to say it has none. */
  captionsSilent: boolean;
  /** Placement and standard, and the panel that changes them. */
  captionPreferences: CaptionPreferences;
  changeCaptionPreferences: (next: CaptionPreferences) => void;
  captionMenuOpen: boolean;
  setCaptionMenuOpen: (open: boolean) => void;
  captionsOn: boolean;
  toggleCaptions: () => void;
  surfaceTime: () => number;
  paused: boolean;
  togglePlay: () => void;
  skip: (delta: number) => void;
  /** The run of taps being queued, or the one just committed while it lingers. */
  skipBurst: SkipBurst | null;
  muted: boolean;
  toggleMute: () => void;
  volume: number;
  changeVolume: (level: number) => void;
  /** False where the platform owns the level and ignores ours — see below. */
  volumeSettable: boolean;
  isLive: boolean;
  atLiveEdge: boolean;
  goLive: () => void;
  title: string;
  subtitle: string | null;
  program: Program | null | undefined;
  programRemaining: number;
  /**
   * Show the rest of this programme's series. Null when there is none to show.
   *
   * A live channel has no series, and the popped-out window cannot host the
   * card at all — see where it is rendered — so in both the name is text and
   * nothing more.
   */
  openSeriesCard: (() => void) | null;
  /** The sound is waiting on a tap, and nothing on screen would say so. */
  needsGesture: boolean;
  /** Where the picture is coming from, when that is worth saying. */
  sourceNote: string | null;
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

/**
 * The one video element, made here rather than rendered.
 *
 * Two React roots render the stage — the tab's and the picture-in-picture
 * window's — and each would build a `<video>` of its own from the same JSX.
 * Only one element can carry the stream: hls.js attaches a MediaSource to it,
 * and a second element would start from nothing. So it is created once, owned
 * by nobody, and appended to whichever host is mounted.
 */
function createStageVideo(): HTMLVideoElement {
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
  return video;
}

/**
 * Puts the remembered level on a fresh element, and says whether it took.
 *
 * iOS hands volume to the hardware and treats the property as read-only: the
 * write is accepted silently and the value stays at 1. So the level is probed
 * with something that cannot be mistaken for that — a slider which does
 * nothing is worse than no slider — and the answer decides whether one is
 * offered at all. Mute is unaffected; that one the platform honours.
 *
 * Done at creation rather than in an effect so the first audio a viewer hears
 * is already at the level they left, with no moment at full blast.
 */
function applyStoredVolume(video: HTMLVideoElement): boolean {
  try {
    video.volume = 0.5;
    if (video.volume !== 0.5) return false;
  } catch {
    return false;
  }
  video.volume = loadVolume();
  return true;
}

/**
 * The stage's canvas, where MPEG-2 decoded in WASM is drawn.
 *
 * Built once and moved between hosts for the same reason the video is: two
 * React roots render this stage, and a JSX canvas would give each of them one
 * of its own while the decoder holds a WebGL context on exactly one.
 */
function createStageCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "w-full h-full object-contain";
  canvas.hidden = true;
  return canvas;
}

export function VideoPlayer({
  source, onClose, startAt = 0, autoPlay = true, onPosition, onPlayRecording,
}: Props) {
  const isLive = source.kind === "live";
  /** The stage's video element, built once on the first render. */
  /**
   * Built once, in a lazy initialiser rather than during the render body.
   *
   * The element and its two facts arrive together because the second is
   * learned by probing the first: whether this platform lets us set a level
   * can only be answered by trying. A `useState` initialiser is where that
   * belongs — it runs exactly once and, unlike assigning through refs mid
   * render, it is a thing React guarantees rather than a thing that happens
   * to work.
   */
  const [stage] = useState(() => {
    const video = createStageVideo();
    const volumeSettable = applyStoredVolume(video);
    return { video, volumeSettable, volume: video.volume };
  });
  const videoRef = useRef<HTMLVideoElement | null>(stage.video);
  /** The whole player. What goes fullscreen, so the chrome goes with it. */
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * What playback is actually happening on.
   *
   * Everything below reads the clock and the seekable range through this
   * rather than from the element, so a second implementation — MPEG-2 decoded
   * in WASM onto a canvas — can stand in the same place without the bar, the
   * scrubber or the anchor knowing about it.
   *
   * A ref, not state: the controls read it synchronously from click handlers,
   * and a state update lands a render later than the surface exists.
   */
  const surfaceRef = useRef<PlaybackSurface | null>(null);
  /** Detaches the transport from the surface currently held. */
  const detachRef = useRef<(() => void) | null>(null);
  /** Where the WASM path draws. Shown instead of the element while it plays. */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  if (canvasRef.current == null) canvasRef.current = createStageCanvas();
  const [usingWasm, setUsingWasm] = useState(false);

  /**
   * Captions on or off, remembered between sessions.
   *
   * Read defensively: a browser blocking site data throws on access, and that
   * reads as off — the same answer everyone else starts from.
   */
  const [captionsOn, setCaptionsOn] = useState(() => {
    try { return localStorage.getItem("tablo.cc") === "1"; } catch { return false; }
  });
  /** Whether a caption has actually been seen on this stream. */
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  /** Placement and standard, as the viewer last left them. */
  const [captionPreferences, setCaptionPreferences] =
    useState<CaptionPreferences>(loadCaptionPreferences);
  const [captionMenuOpen, setCaptionMenuOpen] = useState(false);

  const changeCaptionPreferences = useCallback((next: CaptionPreferences) => {
    setCaptionPreferences(next);
    saveCaptionPreferences(next);
  }, []);
  /**
   * Whether this stream has been given long enough to prove it has captions.
   *
   * The control starts live and stays live: captions take a second or two to
   * announce themselves on a good stream and longer on a quiet passage, and a
   * viewer who presses CC before the first cue should get captions when they
   * arrive rather than a dead button. Only after a stretch of silence does it
   * grey out and say so - by then the answer really is "this stream has
   * none", and saying nothing would leave a live-looking control that does
   * nothing.
   */
  const [captionsSilent, setCaptionsSilent] = useState(false);
  /** Bumped per surface, so the silence clock restarts on a new stream. */
  const [captionEpoch, setCaptionEpoch] = useState(0);

  useEffect(() => {
    if (captionsAvailable) { setCaptionsSilent(false); return; }
    const timer = setTimeout(() => setCaptionsSilent(true), CAPTION_SILENCE_MS);
    return () => clearTimeout(timer);
  }, [captionsAvailable, captionEpoch]);

  /**
   * Where the overlay reads the playhead.
   *
   * A getter, and a stable one: passing the number would re-render the overlay
   * on every tick of the player's own clock, and the overlay wants a fresher
   * reading than that anyway.
   */
  const surfaceTime = useCallback(() => surfaceRef.current?.currentTime ?? 0, []);

  /**
   * The current surface's captions, read when asked rather than held.
   *
   * A getter for the same reason as the clock above: the player swaps
   * surfaces - a rebuild, a fallback, a different recording - and a source
   * captured in state goes on answering about the session the playhead has
   * left. That drew nothing at all, with a cue lookup that was correct and
   * a queue that belonged to somewhere else.
   */
  const captionSourceAt = useCallback(() => surfaceRef.current?.captions ?? null, []);

  const toggleCaptions = useCallback(() => {
    setCaptionsOn((was) => {
      const next = !was;
      try { localStorage.setItem("tablo.cc", next ? "1" : "0"); } catch { /* not worth failing over */ }
      return next;
    });
  }, []);

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
  // Seeded from the element, which already carries the remembered level.
  const [volume, setVolume] = useState(stage.volume);
  /** True while the stage is mounted on a picture-in-picture window instead. */
  const [poppedOut, setPoppedOut] = useState(false);
  const [paused, setPaused] = useState(!openPlaying);
  const [waiting, setWaiting] = useState(false);
  /**
   * The card listing the rest of the show, and why it is up.
   *
   * Null most of the time. "ended" when the programme ran out and the card
   * came up by itself; "browsing" when it was summoned from the show's name
   * mid-programme, which is the quick way to the rest of the same thing.
   *
   * Only ever set for a recording: a live channel has no series to list, and
   * `ended` reaches one from nowhere anyway.
   */
  const [card, setCard] = useState<CardReason | null>(null);
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
  // Where a run of skip taps has got to, and the timer that will commit it.
  // A ref rather than state: every tap reads the last target to build the
  // next, and a render between two fast taps would hand the second a stale one.
  const skipTargetRef = useRef<number | null>(null);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The burst the badge reports: where this run of taps began, and where it
   * has got to.
   *
   * Its own state rather than something derived from `pendingSeek`, because it
   * has to outlive the queue. The seek commits the moment the taps stop, and a
   * badge that went with it would blink out just as the picture began to move
   * — so it lingers, and the origin it is measured against has to linger too.
   */
  const [skipBurst, setSkipBurst] = useState<SkipBurst | null>(null);
  const burstFromRef = useRef<number | null>(null);
  const badgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once playback has actually begun. Lets the surface-click unlock guard
  // tell a never-started startup (suspended context, swallow the first tap)
  // from a deliberate pause (also suspends the context, but the resume tap must
  // get through).
  const hasStartedRef = useRef(false);
  const [fineFactor, setFineFactor] = useState(1);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; base: number } | null>(null);
  /** Throttles preview seeks during a drag. */
  const lastPreviewRef = useRef(0);
  /** Pending commit, so a re-grab can replace it instead of queueing another. */
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  // For the OS hub's seek: it speaks in offsets from the start of the range
  // (that is what `setPositionState` below tells it), while `seekTo` takes
  // the surface's own time. A ref, because the range start moves every
  // second on a live ring and the handlers must not re-register with it.
  const rangeStartRef = useRef(0);
  rangeStartRef.current = rangeStart;
  /**
   * The sound is waiting for a gesture, and the viewer cannot know that.
   *
   * Chrome will not start an AudioContext without user activation, so a page
   * opened or refreshed into a recording sits silent with a still frame until
   * something is touched. Saying so is the whole fix — the policy is the
   * browser's and the page cannot bypass it.
   */
  const [needsGesture, setNeedsGesture] = useState(false);
  const [cacheState, setCacheState] = useState<CacheState | null>(null);
  const [cachedRanges, setCachedRanges] = useState<[number, number][]>([]);
  /** Seconds of the local copy that exist, for the partial-copy notice. */
  const [cachedSeconds, setCachedSeconds] = useState(0);
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
  /**
   * Whether this recording has thumbnails at all.
   *
   * Not every one does: a damaged capture never gets a snap grid built on the
   * device (`clean: false`, `size: 0`), and one still being written has no pack
   * until minutes after it ends. The status poll reports it, and a frame that
   * fails to load says the same thing sooner — a browser cannot read the 404
   * off an `<img>`, only that nothing arrived.
   */
  const [previewState, setPreviewState] =
    useState<"ready" | "absent" | "unknown">("unknown");
  // Media listeners are attached once on mount, so they need a live view of the
  // ranges rather than the value captured in that first closure.
  const cachedRangesRef = useRef<[number, number][]>([]);
  const [now, setNow] = useState(() => Date.now());
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const resetHideTimerRef = useRef<(() => void) | null>(null);
  const onPositionRef = useRef(onPosition);
  /** So reaching the end twice in one playback writes the flag once. */
  const markedWatchedRef = useRef(false);
  // Through a ref for the same reason the position callback is: the transport
  // is wired once, on mount, so anything it reaches for has to be read live
  // rather than captured in that first closure.
  const queryClientRef = useRef(useQueryClient());

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

  /**
   * What is playing, when it is not the device's own MPEG-2.
   *
   * Silent on the ordinary path, because saying "this is the good one" on
   * every recording is noise. It speaks for the local copy: a complete one is
   * worth knowing about, since it plays when the device is off and explains
   * why the picture is softer than usual — and a partial one is worth knowing
   * about urgently, because it simply stops early, which without this reads
   * as the player breaking.
   */
  const sourceNote = isLive || usingWasm || source.kind !== "recording" ? null
    : cacheState === "complete" ? "Offline copy"
    : source.recording.offline_only
      ? `Offline copy · only ${fmt(cachedSeconds)} of ${fmt(source.recording.duration)}`
      : null;

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

  // Watched rather than assumed: the context can be resumed by a touch
  // anywhere on the page, including one this player never sees.
  useEffect(() => {
    setNeedsGesture(false);
    const id = setInterval(() => {
      const state = surfaceRef.current?.diagnostics?.().audioContext;
      if (state === undefined) return;
      setNeedsGesture(state === "suspended");
      if (state !== "suspended") clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [sourceKey]);

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

  // ------------------------------------------------------------ transport
  //
  // Wired when a surface is created rather than from an effect watching state:
  // an effect attaches a render late, which loses the surface's first events —
  // including the seekable range the whole bar is scaled by. Returns its own
  // unsubscribe, so a surface swap (a WASM session giving up mid-playback and
  // handing the channel back to the transcode) is a detach and a re-attach.
  const attachTransport = useCallback((surface: PlaybackSurface) => {
    const sync = (initial = false) => {
      setPosition(surface.currentTime);
      // Arrived (or the player moved on its own) — stop overriding the bar.
      setPendingSeek((want) =>
        want !== null && Math.abs(surface.currentTime - want) < 1.5 ? null : want,
      );
      onPositionRef.current?.(surface.currentTime);
      // Not on the first pass. Attaching happens before playback has actually
      // begun, so the surface still reports itself paused; taking that reading
      // puts a Play button under a frame that is about to start, until the
      // first event corrects it. What the eager pass is for is the seekable
      // range, which the bar is scaled by and which arrives before any event.
      if (!initial) setPaused(surface.paused);
      const sk = surface.seekable;
      if (sk) {
        setRangeStart(sk[0]);
        setRangeEnd(sk[1]);
        // The one reading that ties this session's media clock to the wall
        // clock. Taken when a playlist first exists and never again — the live
        // edge is now, so the two can be converted from here on. Keeping the
        // first reading rather than the latest is what holds the bar still;
        // re-anchoring would slide the programme under the playhead.
        setAnchor((held) => held ?? { wallMs: Date.now(), media: sk[1] });
      } else if (surface.duration !== null) {
        setRangeStart(0);
        setRangeEnd(surface.duration);
      }
    };
    // One event covers both, and reading the surface rather than trusting our
    // own last write keeps the slider honest about what actually happened to
    // the level — a platform that refuses it, or something changing it behind
    // our back.
    const onVolume = () => { setMuted(surface.muted); setVolume(surface.volume); };
    let stalledAt = 0;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const onWait = () => {
      // Already counting: a seek fires `seeking` and `waiting` back to back,
      // and re-arming on the second would push the overlay a grace further out
      // every time the player twitched.
      if (grace !== undefined) return;
      stalledAt = performance.now();
      const t = surface.currentTime;
      log.warn(`stalled at ${fmt(t)}`, {
        cachedHere: isCached(t, cachedRangesRef.current),
        ...surface.diagnostics(),
      });
      // A stall earns the overlay rather than being given it: most are shorter
      // than the time it takes to read one.
      grace = setTimeout(() => setWaiting(true), STALL_GRACE_MS);
    };
    const onPlaying = () => {
      // Playback has begun at least once, so the context has run — a later
      // pause that re-suspends it must not be mistaken for the startup state.
      hasStartedRef.current = true;
      clearTimeout(grace);
      grace = undefined;
      if (stalledAt) {
        log.player(`resumed after ${Math.round(performance.now() - stalledAt)}ms at ${fmt(surface.currentTime)}`);
        stalledAt = 0;
      }
      setWaiting(false);
    };

    /**
     * The recording ran out, which is not the same as the decoder stopping.
     *
     * Nothing listened for this on any surface until now, so the end of a
     * recording was whatever each path happened to do when it got there: the
     * `<video>` element simply stopped, and the WASM session's picture went
     * still, was mistaken for a wedged decoder six seconds later, and the whole
     * session was failed as a decode error.
     *
     * Holding on the last frame, paused, is the least it can do — and it is
     * what the overlay of the rest of the series will sit on top of.
     */
    const onEnded = () => {
      log.player(`reached the end at ${fmt(surface.currentTime)}`);
      clearTimeout(grace);
      grace = undefined;
      setWaiting(false);
      surface.pause();
      sync();
      const current = sourceRef.current;
      if (current.kind !== "recording") return;
      setCard("ended");
      // Reaching the end is the one unambiguous case, and the device never
      // works it out for itself: one played to 43% read `watched: false`, and
      // so did one played right through. Written once per playback — a viewer
      // who rewinds and watches the ending again has not unwatched it.
      if (!markedWatchedRef.current) {
        markedWatchedRef.current = true;
        api.setRecordingWatched(current.recording.object_id, true)
          // The list the card draws carries `watched` for every row, so it has
          // to be re-read for the flag just written to show up on it.
          .then(() => queryClientRef.current.invalidateQueries({ queryKey: ["recordings"] }))
          .catch((e) => log.warn("could not mark it watched", String(e)));
      }
    };

    const offs = [
      surface.on("timeupdate", sync),
      surface.on("ready", sync),
      surface.on("paused", sync),
      surface.on("volumechange", onVolume),
      surface.on("waiting", onWait),
      surface.on("playing", onPlaying),
      surface.on("ended", onEnded),
    ];

    /**
     * Whether this surface has captions to offer, which decides whether the
     * viewer is shown a CC button at all.
     *
     * A stream announces itself as captioned the first time a cue arrives,
     * roughly a second in — so the button appears then and not before, and
     * never appears on a transcode, which has no caption source at all.
     */
    const captions = surface.captions ?? null;
    setCaptionsAvailable(captions?.available ?? false);
    // A new stream gets the benefit of the doubt again, and its own clock.
    setCaptionsSilent(false);
    setCaptionEpoch((n) => n + 1);
    if (captions) {
      offs.push(captions.on("change", () => setCaptionsAvailable(captions.available)));
    }

    sync(true);
    return () => offs.forEach((off) => off());
  }, []);

  // ---------------------------------------------------------------- start
  useEffect(() => {
    let cancelled = false;
    const current = sourceRef.current;

    /** Install a surface, replacing whatever was playing. */
    const hold = (next: PlaybackSurface) => {
      detachRef.current?.();
      surfaceRef.current?.destroy();
      surfaceRef.current = next;
      // Every surface starts loud: the element carries the remembered level
      // only because it was set on the element itself, and a gain node opens
      // at unity knowing nothing. Applied here, where every path installs its
      // surface, rather than at each of the three that build one — including
      // the hand-back to FFmpeg partway through a session, which would
      // otherwise jump back to full volume mid-programme.
      next.setVolume(loadVolume());
      detachRef.current = attachTransport(next);
    };

    /** Put a stream on the `<video>` element and wire the transport to it. */
    const openSurface = (url: string) => {
      const video = videoRef.current;
      if (!video) return;
      hold(createHlsSurface(video, load, url));
    };

    /**
     * Tell the server a WASM session failed, as well as the console.
     *
     * The reason exists only in the browser, and whoever needs it is usually
     * not at that browser — which has meant reading consoles back a line at a
     * time for every diagnosis of this path. Fire and forget: a failure to
     * report a failure must not become one.
     */
    const reportWasmFailure = (reason: string, outcome: "rebuilding" | "gave up") => {
      const diagnostics = surfaceRef.current?.diagnostics?.();
      void fetch("/api/debug/wasm-fallback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          outcome,
          detail: diagnostics?.failureDetail ?? null,
          diagnostics,
        }),
      }).catch(() => {});
    };

    /**
     * One rebuild per player session, for either kind of source.
     *
     * The transcode used to catch these. That swapped the picture the device
     * actually broadcast for a re-encode of it and said nothing, and it hid
     * real faults besides: a path that starves is never seen starving if the
     * player quietly stops using it. A rebuild costs a rebuffer; a second
     * failure is reported rather than papered over.
     */
    let rebuilt = false;

    /** Open the ring and decode it here. Also the rebuild path. */
    const openLiveWasm = async (channel: Channel, staleSession?: string) => {
      // A ring session nothing is reading is still holding a tuner and still
      // copying segments to disk for the life of the process — an hour of
      // 1080i per abandoned channel — and its id is about to be forgotten.
      if (staleSession) {
        api.stopStream(staleSession).catch((e) => {
          log.warn(`could not release the ring session ${staleSession}`, String(e));
        });
      }
      const r = await api.startStream(channel.identifier, false, "ring");
      // Closed, or reopened, while the request was in flight. The session
      // exists on the server and holds a tuner, and nothing else will ever
      // learn its id — so it has to be released here.
      if (cancelled) {
        api.stopStream(r.session_id).catch(() => {});
        return;
      }
      log.player(`open live ${channel.display_name}`, {
        kind: channel.kind, mode: "ring", wasm: true,
        session: r.session_id, url: r.stream_url,
      });
      setSessionId(r.session_id);
      setLiveTranscoded(false);
      setUsingWasm(true);
      const surface = await openWasmSurface({
        playlistUrl: r.stream_url,
        originMs: Date.parse(r.started_at ?? new Date().toISOString()),
        canvas: canvasRef.current,
        onFailure: (reason) => void onLiveFailure(channel, reason, r.session_id),
      });
      if (cancelled) { surface.destroy(); return; }
      hold(surface);
    };

    const onLiveFailure = async (channel: Channel, reason: string, staleSession?: string) => {
      if (rebuilt) {
        reportWasmFailure(reason, "gave up");
        log.warn(`wasm live gave up (${reason})`, { staleSession });
        if (staleSession) api.stopStream(staleSession).catch(() => {});
        if (!cancelled) setApiError(`Live decoding stopped: ${reason}`);
        return;
      }
      rebuilt = true;
      reportWasmFailure(reason, "rebuilding");
      // At the live edge rather than where it died: reopening onto the packet
      // that killed it is the one place certain to fail the same way. The
      // rewind position is the price, and it is cheaper than the programme.
      log.warn(`wasm live failed (${reason}) — rebuilding at the live edge`, { staleSession });
      try {
        await openLiveWasm(channel, staleSession);
      } catch (e) {
        if (!cancelled) setApiError(e instanceof Error ? e.message : String(e));
      }
    };

    const start = async () => {
      try {
        if (current.kind === "live") {
          // OTA broadcasts are MPEG-2, which no browser's media stack decodes.
          // Either this browser can decode it in WASM onto a canvas, or the
          // backend transcodes it to H.264 the way it always has — and the
          // transcode is now only for browsers that cannot do the first,
          // never a rescue for one that tried and failed.
          //
          // Anything not known to be OTT counts as a broadcast: a guide row
          // that arrives without a kind used to fall through to the raw stream,
          // which parses no fragment and buffers forever.
          const eligibility = wasmLiveEligible(window, localStorage, current.channel.kind);
          const { mode, wasm } = chooseLivePath(eligibility, current.channel.kind);

          if (wasm) {
            await openLiveWasm(current.channel);
          } else {
            const r = await api.startStream(
              current.channel.identifier, mode === "transcode", mode,
            );
            if (cancelled) {
              api.stopStream(r.session_id).catch(() => {});
              return;
            }
            log.player(`open live ${current.channel.display_name}`, {
              kind: current.channel.kind, mode, wasm,
              why: eligibility.reason || "eligible",
              session: r.session_id, url: r.stream_url,
            });
            setSessionId(r.session_id);
            setLiveTranscoded(mode === "transcode");
            setUsingWasm(false);
            openSurface(r.stream_url);
          }
        } else {
          // A recording is *usually* the same MPEG-2 and AC-3 the live path
          // decodes — the exception is one the box encoded itself, which is
          // H.264 and handled above by `wasmLiveEligible` refusing it. For the
          // MPEG-2 ones, a browser that can decode has no reason to transcode:
          // it plays from what the device already has, costs no encoder, and
          // keeps its own sample aspect rather than relying on one to carry it.
          // The transcode is what *caching* is for.
          // A copy kept offline wins over everything: it is complete, it is
          // local, and it plays when the device is off or no longer has the
          // recording — which is the entire reason for keeping one. An
          // incidental partial cache is not that, and must not pre-empt
          // MPEG-2: it is only there because something fell back to the
          // transcode once.
          const keptOffline = current.recording.offline_only
            || (current.recording.pinned && current.recording.cache_state === "complete");

          const eligibility = wasmLiveEligible(
            window, localStorage, "ota", current.recording.codec);
          if (eligibility.eligible && !keptOffline) {
            try {
              // Every recording is an index, finished or not: the device
              // publishes both from their first segment, and a finished one
              // differs only by carrying EXT-X-ENDLIST. So both start at the
              // first frame and seek across whatever exists.
              //
              // One still being written used to go to the ring instead, which
              // joins at the live edge on purpose - opening a show forty
              // minutes in began forty minutes in, with no way back. That was
              // on the belief that the device published no reachable beginning
              // for it. Measured 2026-09-17: it does, and it simply appends.
              const raw = await api.watchRecordingVod(current.recording.object_id);
              if (cancelled) {
                api.stopStream(raw.session_id).catch(() => {});
                return;
              }
              log.player(`open recording ${current.recording.object_id} as mpeg-2`, {
                session: raw.session_id, url: raw.stream_url,
                mode: raw.growing ? "vod (still recording)" : "vod",
                duration: fmt(raw.duration),
                segments: raw.segments,
              });
              setSessionId(raw.session_id);
              setUsingWasm(true);
              const surface = await openWasmSurface({
                playlistUrl: raw.stream_url,
                originMs: Date.now(),
                vod: { durationSeconds: raw.duration, growing: raw.growing },
                canvas: canvasRef.current,
                onFailure: (reason) => {
                  // Where the viewer actually was, read before anything is
                  // torn down. `openAt` is captured at mount, so rebuilding
                  // from that would restart a recording from wherever this
                  // session *opened* — which is zero unless it was resumed,
                  // and is how a failure twenty-one minutes in came back as
                  // the first frame. A rebuild costs a rebuffer, not the
                  // viewer's place.
                  //
                  // At the playhead rather than the live edge, unlike live:
                  // VOD can seek anywhere, and the packet that failed is not
                  // necessarily the one the viewer is sitting on.
                  const at = surfaceRef.current?.currentTime ?? 0;

                  // A codec this build does not have is not a fault to report:
                  // it is this routing being wrong about what the recording
                  // is, which happens when the device labelled it nothing at
                  // all. Rebuilding the decoder only asks the same question
                  // again and gets the same answer, so correct the route
                  // instead — the device's own stream is the same picture the
                  // WASM path was trying to decode, not a worse one, and this
                  // is where a viewer would otherwise be left with
                  // "Decoding stopped: decode error" over a black frame.
                  const detail = String(
                    surfaceRef.current?.diagnostics?.().failureDetail ?? "");
                  if (/codec not found/i.test(detail)) {
                    reportWasmFailure(reason, "gave up");
                    log.warn(`recording ${current.recording.object_id} is not `
                      + `mpeg-2 after all (${detail}) — playing the device's `
                      + "own stream", { at: fmt(at) });
                    api.stopStream(raw.session_id).catch(() => {});
                    surface.destroy();
                    if (surfaceRef.current === surface) surfaceRef.current = null;
                    setUsingWasm(false);
                    // Asking for the converted audio outright: the decoder
                    // just proved this is not MPEG-2, and a session opened on
                    // the device's label alone would serve AC-3 nothing here
                    // can decode — picture back, sound silently gone.
                    void api.watchRecordingVod(current.recording.object_id,
                                               { swapAudio: true })
                      .then((again) => {
                        if (cancelled) {
                          api.stopStream(again.session_id).catch(() => {});
                          return;
                        }
                        setSessionId(again.session_id);
                        openSurface(again.stream_url);
                        if (at > 0) surfaceRef.current?.seek(at);
                      })
                      .catch((e) => {
                        if (!cancelled) {
                          setApiError(e instanceof Error ? e.message : String(e));
                        }
                      });
                    return;
                  }

                  if (rebuilt) {
                    reportWasmFailure(reason, "gave up");
                    log.warn(`recording wasm gave up (${reason})`, { at: fmt(at) });
                    api.stopStream(raw.session_id).catch(() => {});
                    // Tear the dead surface down so its poll timer dies with
                    // the session — otherwise it keeps requesting segments the
                    // stopped backend no longer has, a 404 storm with no end.
                    surface.destroy();
                    if (surfaceRef.current === surface) surfaceRef.current = null;
                    if (!cancelled) setApiError(`Decoding stopped: ${reason}`);
                    return;
                  }
                  rebuilt = true;
                  reportWasmFailure(reason, "rebuilding");
                  log.warn(`recording wasm failed (${reason}) — rebuilding`, {
                    resumingAt: fmt(at),
                  });
                  api.stopStream(raw.session_id).catch(() => {});
                  void api.watchRecordingVod(current.recording.object_id)
                    .then(async (again) => {
                      if (cancelled) {
                        api.stopStream(again.session_id).catch(() => {});
                        return;
                      }
                      setSessionId(again.session_id);
                      const next = await openWasmSurface({
                        playlistUrl: again.stream_url,
                        originMs: Date.now(),
                        vod: { durationSeconds: again.duration, growing: again.growing },
                        canvas: canvasRef.current,
                        onFailure: (why) => {
                          reportWasmFailure(why, "gave up");
                          log.warn(`recording wasm gave up (${why})`);
                          api.stopStream(again.session_id).catch(() => {});
                          // Same teardown as the first give-up: stop the dead
                          // session's poll timer so it cannot 404-storm.
                          next.destroy();
                          if (surfaceRef.current === next) surfaceRef.current = null;
                          if (!cancelled) setApiError(`Decoding stopped: ${why}`);
                        },
                      });
                      if (cancelled) { next.destroy(); return; }
                      hold(next);
                      if (at > 0) next.seek(at);
                    })
                    .catch((e) => {
                      if (!cancelled) {
                        setApiError(e instanceof Error ? e.message : String(e));
                      }
                    });
                },
              });
              if (cancelled) { surface.destroy(); return; }
              hold(surface);

              // Open somewhere other than the first frame.
              //
              // The MPEG-2 path ignored `openAt` entirely, so a recording
              // resumed from a saved position or a reopened URL started over
              // from the beginning — `startPosition` below reaches only the
              // transcode. A seek costs one wasted segment fetch, since the
              // session has already begun feeding from zero, which is cheap
              // against silently discarding where the viewer was.
              //
              // LIVE_EDGE means the newest thing recorded, which is only known
              // now: `raw.duration` is what existed when the session opened.
              // Landing a margin short of it, for the same reason Go Live does
              // — the frontier is still being written and seeking onto it waits.
              const target = openAt === LIVE_EDGE
                ? Math.max(0, raw.duration - LIVE_EDGE_MARGIN)
                : openAt;
              if (target > 0) {
                log.player(`opening at ${fmt(target)}`, {
                  reason: openAt === LIVE_EDGE ? "live edge" : "resume",
                  recorded: fmt(raw.duration),
                });
                surface.seek(target);
              }
              setLoading(false);
              return;
            } catch (e) {
              const why = e instanceof Error ? e.message : String(e);
              // The transcode is not a rescue any more. It runs here only
              // when what it would play is a copy worth playing: one that is
              // complete, or the only one left because the device no longer
              // holds the recording. Otherwise this is a failure, and saying
              // so beats quietly serving a worse picture.
              const worthPlaying = current.recording.cache_state === "complete"
                || current.recording.offline_only;
              if (!worthPlaying) {
                log.warn(`recording mpeg-2 unavailable (${why}) — nothing else to play`);
                if (!cancelled) {
                  setApiError(`This recording could not be decoded: ${why}`);
                  setLoading(false);
                }
                return;
              }
              log.warn(`recording mpeg-2 unavailable (${why}) — using the local copy`);
            }
          }
          setUsingWasm(false);

          // H.264 needs no encoder at all. The browser decodes the picture the
          // device already wrote - measured 2026-09-22, hls.js plays its
          // segments and seeks across them untouched - and the backend
          // converts only the AC-3 that no browser but Safari will decode.
          // Transcoding here would decode H.264 to re-encode it as worse
          // H.264, spend a core doing it, and lose the original.
          if (current.recording.codec === "h264") {
            const raw = await api.watchRecordingVod(current.recording.object_id);
            if (cancelled) {
              api.stopStream(raw.session_id).catch(() => {});
              return;
            }
            log.player(`open recording ${current.recording.object_id} as h264`, {
              session: raw.session_id, url: raw.stream_url,
              duration: fmt(raw.duration), segments: raw.segments,
              audio: "swapped to aac",
            });
            setSessionId(raw.session_id);
            openSurface(raw.stream_url);
            setLoading(false);
            return;
          }

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
          setCachedSeconds(r.cached_seconds ?? 0);
          setCachedRanges(r.cached_ranges ?? []);
          openSurface(r.stream_url);
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
      detachRef.current?.();
      detachRef.current = null;
      surfaceRef.current?.destroy();
      surfaceRef.current = null;
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
  // Nothing is asked for once the server has said there is no pack. A scrub
  // otherwise requests a frame every few pixels for the whole length of a
  // recording that has none - forty 404s in ten seconds, each one answered from
  // a device session that could only ever say no.
  const previewSrc = previewId !== null && previewAt !== null && previewState !== "absent"
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
    // A frame that does not arrive is taken as "this recording has none", which
    // the next status poll either confirms or undoes. Optimistic on purpose:
    // the poll is three seconds away and a drag asks for dozens of frames in
    // that time.
    img.onerror = () => { if (live) setPreviewState("absent"); };
    img.src = previewSrc;
    return () => { live = false; };
  }, [previewSrc]);

  // Whether thumbnails exist is a property of the recording, so a new one
  // starts out unknown rather than inheriting the last one's answer.
  useEffect(() => { setPreviewState("unknown"); }, [sourceKey]);

  // ------------------------------------------------- transcode progress poll
  useEffect(() => {
    if (isLive || cacheState === "complete") return;
    const id = setInterval(async () => {
      try {
        const cur = sourceRef.current;
        if (cur.kind !== "recording") return;
        // Position is the heartbeat: it tells the server someone is still here
        // and where to keep the lookahead.
        const at = surfaceRef.current?.currentTime ?? 0;
        const s = await api.recordingStatus(cur.recording.object_id, at);
        setCacheState(s.state);
        const secs = s.cached_seconds ?? 0;
        log.cache(`${s.state} — ${fmt(secs)} of ${fmt(s.duration)} (${Math.round(s.progress * 100)}%)`, {
          playhead: fmt(at),
          ahead: fmt(Math.max(0, (s.cached_ranges ?? []).reduce(
            (m, [a, b]) => (at >= a && at < b ? b : m), 0) - at)),
          ranges: rangesLabel(s.cached_ranges ?? []),
          error: s.error,
        });
        setCachedRanges(s.cached_ranges ?? []);
        setCachedSeconds(secs);
        setEncodingAt(s.encoding ?? null);
        // The authority on whether there are thumbnails: it also undoes a
        // latch made from a frame that failed for some other reason, and picks
        // up the pack a recording gets minutes after it finishes.
        if (s.preview) setPreviewState(s.preview);
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

  const togglePlay = useCallback(() => {
    const s = surfaceRef.current;
    if (!s) return;
    // Pressing play at the end is a decision about the card as much as about
    // the picture: someone who wants the last few seconds again should get
    // them, not a list sitting on top of them. A card summoned on purpose is
    // left alone — pausing and resuming behind it is not a request to dismiss
    // it.
    if (s.paused) {
      setCard((why) => (why === "ended" ? null : why));
      s.play().catch(() => {});
    } else {
      s.pause();
    }
  }, []);

  // Pause when the headphones come out, the way a native player does.
  //
  // A `<video>` playing its own audio is paused by the OS on an output-route
  // change, which is where YouTube's behaviour comes from. The MPEG-2/WASM path
  // has no such element — its sound is on a Web Audio graph, which keeps playing
  // straight out the speakers when AirPods leave the ear. So watch the device
  // list: an audio *output* disappearing is an unplug, and we pause. Pause
  // only, never resume — reinserting should not blare the room, same as every
  // native player. The count is the signal because `devicechange` says nothing
  // about what changed, and labels need a permission we do not want.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.addEventListener || !md.enumerateDevices) return;
    let prevOutputs = -1;
    let stopped = false;
    const outputs = async () => {
      try {
        const devices = await md.enumerateDevices();
        return devices.filter((d) => d.kind === "audiooutput").length;
      } catch {
        return -1;
      }
    };
    void outputs().then((n) => { if (!stopped) prevOutputs = n; });
    const onChange = async () => {
      const n = await outputs();
      if (prevOutputs >= 0 && n >= 0 && n < prevOutputs) {
        const s = surfaceRef.current;
        if (s && !s.paused) { s.pause(); setPaused(true); }
      }
      if (n >= 0) prevOutputs = n;
    };
    md.addEventListener("devicechange", onChange);
    return () => { stopped = true; md.removeEventListener("devicechange", onChange); };
  }, []);

  /**
   * Show the rest of this programme's series, without waiting for it to end.
   *
   * The picture is paused behind it. A list of other episodes is something to
   * read and decide from, and a programme playing on underneath — heard but
   * not seen — is a few seconds of it missed by whoever comes back.
   *
   * Only for a recording. A live channel has no series to list.
   */
  const openSeriesCard = useCallback(() => {
    if (sourceRef.current.kind !== "recording") return;
    surfaceRef.current?.pause();
    setCard("browsing");
  }, []);

  /** Put it away and carry on from where the picture stopped. */
  const closeCard = useCallback(() => {
    setCard(null);
    surfaceRef.current?.play().catch(() => {});
  }, []);

  /**
   * Drop a queued burst of skips — something else has taken the playhead.
   *
   * `keepBadge` is for the one caller that is not "something else": committing
   * the queue also seeks, and that seek must not wipe the badge describing the
   * very jump it is making. Every other path — a scrub, Go Live, a resume —
   * has moved the playhead somewhere the badge's origin says nothing about, so
   * the badge goes with the queue.
   */
  const cancelSkip = useCallback((keepBadge = false) => {
    if (skipTimerRef.current !== null) clearTimeout(skipTimerRef.current);
    skipTimerRef.current = null;
    skipTargetRef.current = null;
    if (keepBadge) return;
    if (badgeTimerRef.current !== null) clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = null;
    burstFromRef.current = null;
    setSkipBurst(null);
  }, []);

  useEffect(() => cancelSkip, [cancelSkip]);

  const seekTo = useCallback((t: number, fromSkip = false) => {
    const s = surfaceRef.current;
    if (!s) return;
    // A scrub, a Go Live, a resume: all of them override whatever the skip
    // buttons had queued, rather than letting it land a moment later and drag
    // the playhead back. The queue committing itself is the exception — that
    // seek *is* the burst, so it keeps the badge (see `cancelSkip`).
    cancelSkip(fromSkip);
    // Going anywhere puts the card away. Cleared here rather than on the
    // session saying it is playing again: pausing at the end flips the stall
    // state, which emits `playing` without anything having moved, and the card
    // would vanish the instant it arrived.
    setCard(null);
    const target = Math.max(rangeStart, Math.min(t, rangeEnd));
    setPendingSeek(target);
    s.seek(target);
    log.player(`seek → ${fmt(target)}`, {
      cached: isCached(target, cachedRangesRef.current) ? "warm" : "COLD — will transcode",
    });
    // `cancelSkip` holds no deps of its own, so naming it here changes nothing
    // about how often this is rebuilt - it only stops the omission reading as
    // an oversight.
  }, [rangeStart, rangeEnd, cancelSkip]);

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
  /**
   * Commit whatever the skip buttons have queued up.
   *
   * Runs once the taps stop. Re-reads the playhead because playback has
   * carried on during the burst, so a target gathered a moment ago may now be
   * where we already are.
   */
  const commitSkip = useCallback(() => {
    skipTimerRef.current = null;
    const target = skipTargetRef.current;
    skipTargetRef.current = null;
    // The burst is over either way, so the badge starts its count down here —
    // before the early returns below, which end a burst just as finally as a
    // seek does and would otherwise leave it on screen for good.
    burstFromRef.current = null;
    if (badgeTimerRef.current !== null) clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = setTimeout(() => {
      badgeTimerRef.current = null;
      setSkipBurst(null);
    }, SKIP_BADGE_LINGER_MS);
    if (target === null) return;
    const s = surfaceRef.current;
    if (!s) return;
    // Already as far that way as there is anything to go. Seeking again would
    // land on the spot it is already on, and every one of those announces
    // itself as a stall — thirteen in a row, in the log that found this.
    if (Math.abs(target - s.currentTime) < 0.25) {
      setPendingSeek(null);
      return;
    }
    seekTo(target, true);
  }, [seekTo]);

  const skip = useCallback((delta: number) => {
    const s = surfaceRef.current;
    if (!s) return;
    const from = s.currentTime;
    const range = readyRange(from, {
      ranges: cachedRangesRef.current,
      buffered: timeRangesToArray(videoRef.current?.buffered),
      start: rangeStart,
      end: rangeEnd,
      // MPEG-2 has no cache to gate on: the device serves any byte range of the
      // recording on demand, which is why seeking in it is instant. Without
      // this, skip was silently dead on that path - `cacheState` is null and
      // `cachedRanges` empty, because the wasm branch returns before either is
      // set, and `buffered` belongs to the hidden <video> a canvas does not
      // use. `readyRange` then found no run containing the playhead, returned
      // [t, t], and the guard below saw a jump of zero and returned.
      //
      // Transcoded live is the exception that must NOT be `whole`: its segments
      // exist only as far as ffmpeg has produced and the player has buffered,
      // so gating on `[start, end]` let a skip land past the cached edge and
      // stall — the player then thrashed, buffering both directions around a
      // position it did not have. Skip is meant to move only through what is
      // cached; the scrubber stays free to go anywhere and wait. So here it
      // clamps to the buffered run. Raw live (OTT, `!liveTranscoded`) and the
      // wasm ring keep `whole`: they have no `buffered` to gate on.
      whole: usingWasm || cacheState === "complete" || (isLive && !liveTranscoded),
    });
    // A live edge is a frontier the encoder is still extending, so a skip has
    // to stop well short of it. Anywhere else `hi` is a settled end.
    //
    // Accumulated from the pending target, not the playhead: twenty fast taps
    // are one jump of ten minutes and one decoder rebuild, rather than twenty
    // of each landing thirty seconds away. `planSkip` clamps every step, so
    // holding the button down cannot run past either boundary and turning
    // round starts from where it actually landed.
    const target = planSkip(
      skipTargetRef.current, from, delta, range,
      isLive ? LIVE_EDGE_MARGIN : RECORDING_EDGE_MARGIN,
    );
    // Pressed into a clamped edge: nothing to queue and nothing to redraw.
    if (target === skipTargetRef.current) return;
    if (skipTargetRef.current === null && Math.abs(target - from) < 0.25) return;
    skipTargetRef.current = target;
    // Every input the clamp used, because a skip that lands somewhere absurd
    // is almost always a bad origin rather than bad arithmetic: `from` is read
    // from the surface, and a surface whose clock has not re-anchored after a
    // seek can report a position it is not at.
    log.player(`skip ${delta > 0 ? "+" : ""}${delta} → ${fmt(target)}`, {
      from: fmt(from),
      queued: skipTargetRef.current === null ? "first" : "accumulating",
      range: `${fmt(range[0])}–${fmt(range[1])}`,
      seekable: s.seekable ? `${fmt(s.seekable[0])}–${fmt(s.seekable[1])}` : "none",
    });
    // The bar and the timecode follow immediately, so the control answers at
    // once while the decoder is left alone until the taps stop.
    setPendingSeek(target);
    // Where this run began, kept until the run ends. Taken from the playhead
    // on the first tap only: every later tap in the burst reads a
    // `currentTime` that has not moved yet, so measuring from the latest one
    // would report each tap's own step instead of the whole jump.
    if (burstFromRef.current === null) burstFromRef.current = from;
    if (badgeTimerRef.current !== null) clearTimeout(badgeTimerRef.current);
    badgeTimerRef.current = null;
    setSkipBurst({ from: burstFromRef.current, target });
    if (skipTimerRef.current !== null) clearTimeout(skipTimerRef.current);
    skipTimerRef.current = setTimeout(commitSkip, SKIP_DEBOUNCE_MS);
  }, [commitSkip, isLive, liveTranscoded, usingWasm, cacheState, rangeStart, rangeEnd]);

  // Hardware media keys — the headphone/keyboard play-pause and seek — reach a
  // page only through the Media Session API (or a <video> the browser adopts on
  // its own). The MPEG-2 path draws to a canvas with WebAudio and has no such
  // element, so without this the keys hit nothing there; wiring it explicitly
  // makes them work on both the HLS and WASM surfaces. Handlers are stable
  // (togglePlay handles play and pause off the surface's own paused state), so
  // this registers once and tears down on unmount.
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      ms.setActionHandler("play", () => togglePlay());
      ms.setActionHandler("pause", () => togglePlay());
      ms.setActionHandler("seekbackward", (d) => skip(-(d.seekOffset ?? loadSkipBack())));
      ms.setActionHandler("seekforward", (d) => skip(d.seekOffset ?? loadSkipForward()));
      // AirPods (and most headphone remotes) map their gestures to
      // next/previous track, not seek — a double squeeze is "next track", a
      // triple is "previous track". For a DVR: double jumps a commercial
      // (+30s), triple nudges back for a missed line (-10s). Same skip path as
      // the on-screen buttons.
      ms.setActionHandler("nexttrack", () => skip(loadSkipForward()));
      ms.setActionHandler("previoustrack", () => skip(-loadSkipBack()));
      ms.setActionHandler("seekto", (d) => {
        if (typeof d.seekTime === "number") {
          seekTo(rangeStartRef.current + d.seekTime);
        }
      });
    } catch {
      // A browser may not support every action; the ones it took still work.
    }
    return () => {
      for (const a of ["play", "pause", "seekbackward", "seekforward",
                       "nexttrack", "previoustrack", "seekto"] as const) {
        try { ms.setActionHandler(a, null); } catch { /* ignore */ }
      }
    };
  }, [togglePlay, skip, seekTo]);

  // Name what is playing for the OS now-playing surface, and keep its
  // play/pause state honest so the key toggles in the right direction.
  //
  // The picture beside the name: for a recording the episode still
  // (`thumbnail`, the per-episode grab) is preferred over the series cover, so
  // the hub shows what this episode looked like; it falls back to `cardArt`
  // (chosen frame → cover) if a still is somehow absent. On a live channel it
  // is the airing's poster. Without any, `nowPlayingArtwork` puts the app's
  // mark there rather than nothing.
  const artUrl = isLive
    ? (program?.poster_image_id != null
        ? `/api/channels/image/${program.poster_image_id}`
        : null)
    : (source.recording.thumbnail ?? cardArt(source.recording));
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || !("MediaMetadata" in window)) return;
    ms.metadata = new MediaMetadata({
      title,
      artist: subtitle || undefined,
      artwork: nowPlayingArtwork(artUrl),
    });
  }, [title, subtitle, artUrl]);

  useEffect(() => {
    const ms = navigator.mediaSession;
    if (ms) ms.playbackState = paused ? "paused" : "playing";
  }, [paused]);

  // The hub's scrubber. Without this it shows what the element underneath
  // reports: on the WASM path that is the sink's ten-second loop of silence
  // (see audioSink), on HLS a time within the buffer rather than the
  // programme. Offsets from the start of the range, matching what `seekto`
  // hands back. Whole seconds: the browser interpolates between updates from
  // the rate, so sending every tick buys nothing.
  const wholePosition = Math.floor(position);
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms || typeof ms.setPositionState !== "function") return;
    const duration = rangeEnd - rangeStart;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const at = Math.min(duration, Math.max(0, wholePosition - rangeStart));
    try {
      ms.setPositionState({ duration, position: at, playbackRate: 1 });
    } catch {
      // A pair the browser rejects (the range moved under a seek) is not
      // worth a crash; the next tick sends a consistent one.
    }
  }, [wholePosition, rangeStart, rangeEnd]);

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
    const s = surfaceRef.current;
    if (!s) return;
    const cached = isLive || cachedRanges.some(([a, b]) => t >= a && t <= b);
    if (!cached) return;
    // A seek per pointer event would queue faster than they can complete.
    const now = performance.now();
    if (now - lastPreviewRef.current < 120) return;
    if (Math.abs(s.currentTime - t) < 0.5) return;
    lastPreviewRef.current = now;
    s.seek(t);
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
    seekTo((surfaceRef.current?.currentTime ?? 0) + Math.sign(dir) * mag);
  }, [seekTo]);

  const toggleMute = useCallback(() => {
    const s = surfaceRef.current;
    if (!s) return;
    s.setMuted(!s.muted);
    setMuted(s.muted);
  }, []);

  /**
   * Set the level, and take that as wanting to hear something.
   *
   * Mute and the level stay separate states — unmuting gives back the level
   * that was set, which is the whole reason zero on the slider is not the
   * same thing as muted. But reaching for the slider while muted has only one
   * meaning, so a level above zero lifts the mute with it. Below zero it does
   * not: silencing by dragging to the end should not leave the button lit.
   */
  const changeVolume = useCallback((next: number) => {
    const level = clampVolume(next);
    // Through the surface, so a level set here reaches whichever pipeline is
    // playing: the element on the HLS path, a gain node on the WASM one. The
    // element is the fallback rather than the target, for the window before a
    // surface exists — it already carries the remembered level, and writing
    // to it there keeps the slider from being dead on a player still opening.
    const s = surfaceRef.current;
    if (s) {
      s.setVolume(level);
      if (level > 0 && s.muted) {
        s.setMuted(false);
        setMuted(false);
      }
    } else if (videoRef.current) {
      videoRef.current.volume = level;
      if (level > 0 && videoRef.current.muted) {
        videoRef.current.muted = false;
        setMuted(false);
      }
    }
    setVolume(level);
    saveVolume(level);
  }, []);

  /** One rung of the arrow keys — a twentieth, as every other player uses. */
  const nudgeVolume = useCallback((delta: number) => {
    const held = surfaceRef.current?.volume ?? videoRef.current?.volume ?? 1;
    changeVolume(held + delta);
  }, [changeVolume]);

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
    // Whichever element is drawing the picture. `captureStream` is the same
    // method on both, handing out a MediaStream of one video track, and a
    // mirror cannot tell the two apart — so the WASM path pops out the canvas
    // and the transcode path pops out the element, with nothing downstream
    // learning which it got. Mirroring the (hidden, empty) video element while
    // the canvas is the one with the picture would pop out a black rectangle.
    const source = (usingWasm ? canvasRef.current : videoRef.current) as
      (HTMLElement & { captureStream?: () => MediaStream }) | null;
    if (!source?.captureStream) return false;
    const mirror = document.createElement("video");
    mirror.className = "w-full h-full object-contain";
    mirror.playsInline = true;
    mirror.muted = true;
    mirror.autoplay = true;
    mirror.srcObject = source.captureStream();
    // A canvas capture emits a frame only when something draws, so popping out
    // while paused hands the mirror a track that is live and correctly sized
    // and will never produce a picture — it stays at readyState 0 until
    // playback resumes. Drawing the frame that is already there gives it one.
    surfaceRef.current?.repaint?.();
    mirrorRef.current = mirror;
    return true;
  }, [usingWasm]);

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
    // The canvas belongs to the tab's own stage and never leaves it. The
    // pop-out is fed by a mirror of whatever is drawing — the canvas included
    // — so it needs the stream, not the element.
    const canvas = canvasRef.current;
    if (!forPip && canvas && canvas.parentElement !== host) host.append(canvas);
  }, []);

  // Which of the two is on screen. Set on the elements rather than through
  // React, because React does not own them - it owns the host they sit in.
  useEffect(() => {
    if (videoRef.current) videoRef.current.hidden = usingWasm;
    if (canvasRef.current) canvasRef.current.hidden = !usingWasm;
  }, [usingWasm]);

  const pipWindow = useRef<Window | null>(null);
  /** The live shortcut handler, so a new pop-out can be given it too. */
  const keyHandler = useRef<((e: KeyboardEvent) => void) | null>(null);
  const pipRoot = useRef<Root | null>(null);

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
      // The root too, and for a reason the copied sheets create: one of them
      // makes `html` a scroll container deliberately — `overflow-y: scroll`
      // is what reserves the gutter that stops the tabs shifting 2px between
      // Live and Guide. Here it reserves a groove down the side of a video
      // that never scrolls. Inline, so it beats the sheet without the sheet
      // needing to know this window exists.
      w.document.documentElement.style.cssText = "overflow:hidden";

      // A React root of the window's own. This is the whole point: React
      // delegates events to the root container, so a stage merely moved into
      // this document would fire its clicks where nothing is listening —
      // which is exactly what happened. A root here listens here.
      const mount = w.document.createElement("div");
      w.document.body.append(mount);
      openMirror();
      // The canvas is painted by an animation frame loop, and this document is
      // about to be the hidden one — which runs none. Whatever the surface was
      // presenting from, it presents from the window on screen now. Optional
      // on both sides: the element-backed surface has no loop to move.
      surfaceRef.current?.setFrameSource?.({
        request: (callback) => w.requestAnimationFrame(callback),
        cancel: (handle) => w.cancelAnimationFrame(handle),
      });
      pipRoot.current = createRoot(mount);
      if (keyHandler.current) w.addEventListener("keydown", keyHandler.current);
      setPoppedOut(true);

      // However it closes — our button, the window's own, the tab going away
      // — the root has to come down and the video come home, or the player is
      // left with nothing to show.
      w.addEventListener("pagehide", () => {
        pipRoot.current?.unmount();
        closeMirror();
        // Back to this document's clock: the tab's stage is on screen again,
        // and the window that was driving the loop is going away with its
        // `requestAnimationFrame` still holding an outstanding handle.
        surfaceRef.current?.setFrameSource?.(DOCUMENT_FRAMES);
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
  }, [title, openMirror, closeMirror]);

  // A player torn down while popped out would leave the window orphaned,
  // holding a video element that no longer belongs to anything.
  useEffect(() => () => pipWindow.current?.close(), []);

  /**
   * Keep the tab's own copy of the picture alive while it is popped out.
   *
   * Presentation runs on the pop-out's clock while a pop-out is open, so this
   * document schedules no frames — and the WebGL context keeps no drawing
   * buffer between composites, so the canvas still sitting in the tab goes
   * black. Redrawing the same field here costs one draw call and no decoding,
   * and the loop is this document's own: when the tab is hidden, which is
   * exactly when nobody is looking at it, the browser stops running it.
   */
  useEffect(() => {
    if (!poppedOut || !usingWasm) return;
    let handle = requestAnimationFrame(function paint() {
      surfaceRef.current?.repaint?.();
      handle = requestAnimationFrame(paint);
    });
    return () => cancelAnimationFrame(handle);
  }, [poppedOut, usingWasm]);

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
    // A tap that only exists to unlock the sound does nothing else.
    //
    // Chrome will not start an AudioContext without user activation, so a
    // page opened or refreshed into a recording sits with a stopped clock and
    // a black frame until the viewer touches something. That first touch is
    // handled document-wide by `unlockOnGesture` — but the stage divides the
    // frame into rewind, play-pause and skip zones, so the same tap also
    // jumped the playhead thirty seconds or paused a programme that had not
    // begun. The viewer asked for the picture and got a transport command.
    //
    // Only ever the first one, and only before playback has ever begun. A bare
    // "context is suspended" check was wrong: pausing the WASM path suspends
    // the context too (see audioSink), so a *paused* player also reads as
    // "suspended" and this swallowed the very tap meant to resume it — pause
    // worked, un-pause did nothing. `hasStartedRef` distinguishes the startup
    // black frame (never played) from a deliberate pause (played, then stopped).
    if (surfaceRef.current?.diagnostics?.().audioContext === "suspended"
        && !hasStartedRef.current) return;
    const zone = zoneAtEvent(e);
    if (zone === "back") skip(-loadSkipBack());
    else if (zone === "forward") skip(loadSkipForward());
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
    const s = surfaceRef.current;
    const seekable = s?.seekable;
    return {
      source: isLive ? "live" : `recording ${('recording' in source) ? source.recording.object_id : ""}`,
      title,
      position: fmt(s?.currentTime ?? 0),
      duration: fmt(s?.duration ?? 0),
      paused: s?.paused, muted: s?.muted,
      seekable: seekable ? `${fmt(seekable[0])}-${fmt(seekable[1])}` : "none",
      cacheState,
      cachedRanges: rangesLabel(cachedRangesRef.current),
      atCachedPoint: isCached(s?.currentTime ?? 0, cachedRangesRef.current),
      mediaError: s?.error ?? null,
      // The caption the overlay would be drawing, asked exactly as the overlay
      // asks it. Worth having permanently: cues arriving and no caption on
      // screen is otherwise indistinguishable from no cues at all, and the two
      // have nothing in common.
      captionNow: s?.captions?.at(s.currentTime ?? 0)?.text ?? null,
      captionSurface: Boolean(s?.captions),
      // Whatever the implementation in use can say about itself: readyState
      // and buffered ranges for hls, decode and present counts for wasm.
      ...(s?.diagnostics() ?? {}),
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
        // The card is the nearest thing when it is up, and only when it was
        // asked for: one the end of a programme put there has nothing behind
        // it, so dismissing it would leave a still frame and no way on.
        if (card === "browsing") closeCard();
        else if (poppedOut) togglePictureInPicture();
        else onClose();
      }
      if (e.key === "f") enterFullscreen();
      // Symmetrical with the button: out if it is in, in if it is out.
      if (e.key === "p") togglePictureInPicture();
      // Only where there is something to toggle. A key that silently does
      // nothing is worse than one that is not bound.
      if (e.key === "c" && !captionsSilent) toggleCaptions();
      if (e.key === "m") toggleMute();
      if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
      // Match every other transport (the tap zones and the on-screen skip
      // buttons): back on Left, forward on Right, both the configured amount.
      if (e.key === "ArrowLeft") skip(-loadSkipBack());
      if (e.key === "ArrowRight") skip(loadSkipForward());
      // Horizontal is seek, so vertical is the level — which is also where
      // every other player puts it. `preventDefault` because the page behind
      // the player would otherwise scroll under it.
      if (e.key === "ArrowUp") { e.preventDefault(); nudgeVolume(VOLUME_STEP); }
      if (e.key === "ArrowDown") { e.preventDefault(); nudgeVolume(-VOLUME_STEP); }
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
      poppedOut, togglePictureInPicture, nudgeVolume, card, closeCard,
      captionsAvailable, captionsSilent, toggleCaptions]);

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
    captionSourceAt, captionsAvailable, captionsSilent, captionsOn, toggleCaptions, surfaceTime,
    captionPreferences, changeCaptionPreferences, captionMenuOpen, setCaptionMenuOpen,
    paused, togglePlay, skip, skipBurst, muted, toggleMute,
    volume, changeVolume, volumeSettable: stage.volumeSettable,
    isLive, atLiveEdge, goLive, title, subtitle, program, programRemaining, sourceNote,
    openSeriesCard: source.kind === "recording" && !poppedOut ? openSeriesCard : null,
    needsGesture,
    barStart, barEnd, span, pct, shownPos, rangeEnd,
    readyBands, hoverAt, scrubbing, shownPreview, fineFactor,
    onBarPointerDown, onBarPointerMove, onBarPointerUp, onBarKeyDown, setHoverAt,
    formatTime, clockTime, clockAt, onProgramBar, position, previewAt, rangeStart,
  };

  // Keep the popped-out root in step. It renders the same stage from the same
  // view, so every state change in here reaches that window too — without this
  // it would show the moment it was opened at, frozen.
  //
  // Declared here rather than with the other effects because it renders from
  // the view: carrying the view to an earlier effect meant writing a ref
  // during render, which is what this replaces.
  useEffect(() => {
    if (pipRoot.current) pipRoot.current.render(<Stage view={view} pip />);
  });

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
            title="Close picture-in-picture (P)"
            aria-label="Close picture-in-picture (P)"
          >
            <PictureInPictureExit className="w-9 h-9" aria-hidden />
          </button>
          {/* The key, on the one screen with room to say it plainly: this
              placeholder is all the tab has while the window is out, so it is
              where someone looking for the way back will read it. */}
          <p className="text-player-fg-muted text-sm">Close picture-in-picture (P)</p>
        </div>
      )}
      <Stage view={view} pip={false} />

      {/* The rest of the show: put up by itself when the programme is over,
          rather than leaving a still frame and a transport that does nothing,
          and summoned from the show's name the rest of the time.

          Outside `Stage`, and so outside the view that carries everything else
          across, because it reads the recordings list: the popped-out window
          renders `Stage` on a React root of its own, which has no query client
          above it, and anything using one would throw there. It is also not
          wanted there — the pop-out is a picture, and the tab behind it is
          where this belongs. Hence its own `dark`, since it no longer inherits
          the one on the stage. */}
      {card && !poppedOut && source.kind === "recording" && !combinedError && (
        <div className="dark fixed inset-0 z-[55]">
          <SeriesEndCard
            current={source.recording}
            reason={card}
            onPlay={(rec) => onPlayRecording?.(rec)}
            // At the end there is nothing behind the card to go back to, so
            // the way out is the way out of the player. Mid-programme the
            // picture is still there, waiting.
            onClose={card === "ended" ? onClose : closeCard}
          />
        </div>
      )}
    </>
  );
}

/**
 * What is playing, in the corner of the transport row.
 *
 * A button where there is a series behind it, plain text where there is not —
 * and its own element either way, because the two need different markup and a
 * ternary around eighty lines of it is worse than a component.
 *
 * It takes its own clicks now. It used to be `pointer-events-none` throughout,
 * so every click on the programme's name fell through to the picture — and the
 * left two fifths of the picture is Back 10s, so reaching for the title rewound
 * the programme. A click that lands on words is never a click on the frame
 * behind them.
 */
function NowPlaying({
  title, subtitle, program, programRemaining, sourceNote, clockTime,
  openSeriesCard, hidden,
}: {
  title: string;
  subtitle: string | null;
  program: Program | null | undefined;
  programRemaining: number;
  sourceNote: string | null;
  clockTime: (iso: string) => string;
  openSeriesCard: (() => void) | null;
  hidden: boolean;
}) {
  // Nothing to gain from it in a pop-out: the window is named after the
  // programme, and at that width the name and the controls are fighting over
  // the same strip of picture. Hidden rather than dropped, so the row keeps
  // three cells and the transport stays centred.
  //
  // The padding is the hit area, and the negative margins take it back out of
  // the layout: the target grows without the text moving from where it was
  // drawn.
  const className = `max-w-[30%] text-left select-none rounded-lg
    -mx-2 -my-1 px-2 py-1 transition
    ${openSeriesCard ? "hover:bg-fill" : "pointer-events-none"}
    ${hidden ? "invisible" : ""}`;

  // A crisp outline rather than a blurred shadow: over flat white content a
  // soft shadow reads as a smudge. `paint-order: stroke` draws the stroke
  // beneath the fill, so the glyphs keep their weight instead of bulking the
  // way a plain text-stroke would.
  //
  // The halo is the scrim colour, so it always contrasts the text it
  // surrounds: black behind white glyphs in dark, near-white behind ink ones
  // in light. Its alpha is a per-theme knob rather than a shared constant —
  // see `--c-player-scrim-halo-a`; the two directions need very different
  // strengths to read the same.
  const style = {
    WebkitTextStroke: "3px rgb(var(--c-player-scrim) / var(--c-player-scrim-halo-a))",
    paintOrder: "stroke fill",
  } as const;

  const inside = (
    <>
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
      {sourceNote && (
        <p className="text-[10px] text-player-fg-muted tabular-nums mt-0.5">
          {sourceNote}
        </p>
      )}
    </>
  );

  if (!openSeriesCard) {
    return <div className={className} style={style}>{inside}</div>;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openSeriesCard(); }}
      className={className}
      style={style}
      title="The rest of this show"
      aria-label={`The rest of ${title}`}
    >
      {inside}
    </button>
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
    captionSourceAt, captionsAvailable, captionsSilent, captionsOn, toggleCaptions, surfaceTime,
    captionPreferences, changeCaptionPreferences, captionMenuOpen, setCaptionMenuOpen,
    paused, togglePlay, skip, skipBurst, muted, toggleMute,
    volume, changeVolume, volumeSettable,
    isLive, atLiveEdge, goLive, title, subtitle, program, programRemaining, sourceNote,
    openSeriesCard,
    needsGesture,
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

  // Skip amounts (seconds) from the viewer's setting, for the button labels.
  // The onClick handlers call `loadSkipForward()/loadSkipBack()` directly, so
  // the jump is always the current value; this state only keeps the labels in
  // step, refreshed when the setting changes (same tab via a custom event,
  // other tabs via `storage`).
  const [skipFwd, setSkipFwd] = useState(loadSkipForward);
  const [skipBack, setSkipBack] = useState(loadSkipBack);
  useEffect(() => {
    const refresh = () => {
      setSkipFwd(loadSkipForward());
      setSkipBack(loadSkipBack());
    };
    window.addEventListener(SKIP_CONFIG_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SKIP_CONFIG_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  /**
   * Coming up is instant; going away waits.
   *
   * The bar answers the pointer's height, so it drops the moment the cursor
   * clears the strip — which punishes a hand on its way to the scrubber and
   * flickers outright when the pointer tracks along the boundary. A held
   * moment covers both: long enough to come back to, short enough that a
   * window left alone is a picture again almost at once.
   */
  const barLeaveTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const showBar = useCallback((next: boolean) => {
    if (barLeaveTimer.current) {
      clearTimeout(barLeaveTimer.current);
      barLeaveTimer.current = null;
    }
    if (next) { setBarHover(true); return; }
    barLeaveTimer.current = setTimeout(() => setBarHover(false), PIP_BAR_LINGER);
  }, []);

  useEffect(() => () => {
    if (barLeaveTimer.current) clearTimeout(barLeaveTimer.current);
  }, []);

  /**
   * Read from the pointer's height, not from entering and leaving a strip.
   *
   * A strip would sit under the transport it summons, so the controls
   * appearing on top of it would fire its own mouseleave and take them away
   * again. Measuring against the frame cannot contradict itself that way.
   */
  const trackBottomHover = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    showBar(rect.height > 0 && rect.bottom - e.clientY <= PIP_BAR_REACH);
  }, [showBar]);

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
    // Through the same wait: leaving the window entirely is the case the
    // linger is most obviously for, and a pointer that has left has not
    // necessarily finished.
    showBar(false);
    setHoverZone(null);
  }, [showBar]);

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

      {/* Waiting on a tap. `pointer-events-none` deliberately: the tap that
          dismisses this has to reach the surface beneath, which swallows it
          rather than treating it as a skip. */}
      {needsGesture && !loading && !combinedError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2
                        pointer-events-none">
          <div className="rounded-2xl glass px-5 py-4 flex flex-col items-center gap-1">
            <p className="text-player-fg text-sm font-bold">Tap to play</p>
            <p className="text-player-fg-muted text-[11px]">
              Your browser starts sound only after a tap
            </p>
          </div>
        </div>
      )}
      </div>
    );
  }

  /**
   * The queued burst, as a reading and a landing time.
   *
   * Net movement and where it ends up — never a tap count, because Forward and
   * Back are configured separately and a mixed burst of twelve presses can
   * come to nothing at all. The landing follows whatever the scrubber is
   * labelled in: clock time on a programme bar, elapsed time everywhere else.
   */
  const burst = skipBurst ? describeSkipBurst(skipBurst) : null;
  const burstLanding = skipBurst
    ? (onProgramBar ? clockAt(skipBurst.target) : formatTime(skipBurst.target - rangeStart))
    : null;

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
      //
      // Not in the pop-out. There the picture is one small window among
      // others and the pointer is usually on its way somewhere else, so
      // taking it away leaves someone hunting for it over the video. The
      // tab's idle timer goes on running while the window is out, so this is
      // a refusal rather than something that simply never happens.
      className={`dark fixed inset-0 z-50 bg-media flex items-center justify-center
        ${!pip && !showControls ? "cursor-none" : ""}`}
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
      <div
        ref={videoHostRef}
        className="w-full h-full"
      />

      {/* Over the picture, under the chrome. Not rendered into the pop-out:
          that window is fed a mirror of canvas pixels, and a DOM layer is not
          one of them. */}
      {captionsAvailable && !pip && (
        <CaptionOverlay
          source={captionSourceAt}
          enabled={captionsOn}
          currentTime={surfaceTime}
          raised={chromeUp}
          compare={captionCompareRequested()}
          placement={captionPreferences.placement}
          standard={captionPreferences.standard}
        />
      )}

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
              ` rgb(var(--c-player-scrim) / 0) calc(100% - ${CHROME_BOTTOM_BAND_PX}px),` +
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
            <NowPlaying
              title={title}
              subtitle={subtitle}
              program={program}
              programRemaining={programRemaining}
              sourceNote={sourceNote}
              clockTime={clockTime}
              openSeriesCard={openSeriesCard}
              hidden={poppedOut}
            />

            {/* Transport, centered on the frame. Play sits between the two jumps
                so the hand travels the same distance either way. */}
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); skip(-loadSkipBack()); }}
                className={`flex items-center gap-1 rounded-lg glass text-player-fg hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8 justify-center" : "px-2.5 h-9"} ${lent("back")}`}
                title={`Back ${skipBack}s (Left arrow)`}
                aria-label={`Back ${skipBack} seconds`}
              >
                <RotateCcw className="w-4 h-4" aria-hidden />
                {!poppedOut && <span className="text-[10px] font-black tabular-nums">{skipBack}</span>}
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
                onClick={(e) => { e.stopPropagation(); skip(loadSkipForward()); }}
                className={`flex items-center gap-1 rounded-lg glass text-player-fg hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8 justify-center" : "px-2.5 h-9"} ${lent("forward")}`}
                title={`Forward ${skipFwd}s (Right arrow)`}
                aria-label={`Forward ${skipFwd} seconds`}
              >
                <RotateCw className="w-4 h-4" aria-hidden />
                {!poppedOut && <span className="text-[10px] font-black tabular-nums">{skipFwd}</span>}
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

              {/* Speaker and level as one control, the level rolling out of
                  the speaker on approach.

                  Collapsed by default because a bar parked in the row is width
                  spent on something adjusted rarely, next to a transport that
                  wants all of it. `group/vol` keeps the roll-out on this pill
                  alone — the row has other groups — and `focus-within` opens
                  it for the keyboard too, since a slider that only appears
                  under a pointer cannot be tabbed to.

                  Not in the pop-out. That window is small, the bar reaches
                  96px up from the bottom of it, and the speaker is the control
                  anyone actually wants there. */}
              <div className={`group/vol flex items-center rounded-lg glass transition-[width] duration-200
                ${poppedOut ? "h-8" : "h-9"}`}>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                  className={`rounded-lg text-player-fg flex items-center justify-center hover:bg-fill transition
                    ${poppedOut ? "w-8 h-8" : "w-9 h-9"}`}
                  title={muted ? "Unmute (M)" : "Mute (M)"}
                >
                  {/* Three rungs rather than two: the icon carries roughly how
                      loud, so a level set with the keyboard alone is still
                      visible with the slider shut. */}
                  {muted || volume === 0
                    ? <VolumeX className="w-4 h-4" aria-hidden />
                    : volume < 0.5
                      ? <Volume1 className="w-4 h-4" aria-hidden />
                      : <Volume2 className="w-4 h-4" aria-hidden />}
                </button>
                {volumeSettable && !poppedOut && (
                  <div className="overflow-hidden w-0 group-hover/vol:w-[5.5rem] group-focus-within/vol:w-[5.5rem]
                                  transition-[width] duration-200 ease-out">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={VOLUME_STEP}
                      value={muted ? 0 : volume}
                      onChange={(e) => changeVolume(Number.parseFloat(e.target.value))}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Volume"
                      aria-valuetext={`${Math.round(volume * 100)}%`}
                      // The filled part is drawn from the value, because a
                      // range input's track is one box and cannot be split by
                      // a class. Read by the track's own pseudo-element, which
                      // inherits custom properties from the element.
                      style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
                      className="player-volume w-[4.5rem] mx-2"
                    />
                  </div>
                )}
              </div>

              {/* Always in the row, and live from the start. A viewer who
                  presses CC before the first cue has arrived gets captions
                  when they do; the button only greys out once the stream has
                  been silent long enough for "no captions" to be the truth
                  rather than a guess. It used to appear a second or so into a
                  captioned stream, which moved the controls either side of it
                  under the pointer. One rule still covers every case: a
                  transcode has no caption source, uncaptioned programming
                  never produces a cue, and a fall back to the transcode
                  mid-session starts the clock again. */}
              <div className="relative">
              {captionMenuOpen && (
                <CaptionSettings
                  preferences={captionPreferences}
                  onChange={changeCaptionPreferences}
                  onClose={() => setCaptionMenuOpen(false)}
                />
              )}
              <button
                onClick={(e) => { e.stopPropagation(); if (!captionsSilent) toggleCaptions(); }}
                /* The settings are the rarer errand, so they go where a rarer
                   errand goes. The browser's own menu is given up over this
                   one button, which is a small thing to take and the only way
                   a right-click can mean anything here. */
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCaptionMenuOpen(!captionMenuOpen);
                }}
                /* And a long press, for a trackpad without a right button and
                   for a touchscreen, which has no such thing at all. */
                onPointerDown={(e) => {
                  if (e.pointerType === "mouse" && e.button !== 0) return;
                  const timer = setTimeout(() => setCaptionMenuOpen(true), 500);
                  const cancel = () => {
                    clearTimeout(timer);
                    window.removeEventListener("pointerup", cancel);
                    window.removeEventListener("pointercancel", cancel);
                  };
                  window.addEventListener("pointerup", cancel);
                  window.addEventListener("pointercancel", cancel);
                }}
                disabled={captionsSilent}
                className={`rounded-lg glass text-player-fg flex items-center justify-center transition
                ${poppedOut ? "w-8 h-8" : "w-9 h-9"} ${captionsOn ? "bg-fill" : ""}
                ${captionsSilent ? "opacity-40 cursor-default" : "hover:bg-fill"}`}
                /* Named with its key, the way the buttons either side of it
                   are. */
                title={captionsSilent
                  ? "No CC data on this stream"
                  : (captionsOn ? "Hide closed captions (C)" : "Show closed captions (C)")}
                aria-label={captionsSilent
                  ? "No CC data on this stream"
                  : (captionsOn ? "Hide closed captions (C)" : "Show closed captions (C)")}
                aria-pressed={captionsOn}
              >
                <ClosedCaption className="w-4 h-4" aria-hidden />
              </button>
              </div>

              {/* Only where the API exists. Safari has no Document
                  Picture-in-Picture, so the button would promise nothing
                  there — better absent than dead. */}
              {"documentPictureInPicture" in window && (
                <button
                  onClick={(e) => { e.stopPropagation(); togglePictureInPicture(); }}
                  className={`rounded-lg glass text-player-fg flex items-center justify-center hover:bg-fill transition
                  ${poppedOut ? "w-8 h-8" : "w-9 h-9"}`}
                  /* Named with its key, the way Mute and Fullscreen either
                     side of it are. `p` has been bound the whole time; this
                     button sitting between two that advertise theirs read as
                     though it had none. Both labels carry it, because the same
                     key closes the window and the hint should not vanish
                     exactly when it is in use. */
                  title={poppedOut ? "Close picture-in-picture (P)" : "Picture in picture (P)"}
                  aria-label={poppedOut ? "Close picture-in-picture (P)" : "Picture in picture (P)"}
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

      {/* What the queue has added up to, while it is still gathering.

          Outside the chrome layer above on purpose, and so unaffected by
          whether the controls are up: the media keys skip without waking
          anything — an AirPod squeeze reaches the player through the Media
          Session API and touches nothing else — and inside the fading layer
          this would be answering a screen nobody can see. It is also the only
          answer there is for the half-second before the seek commits, which is
          the whole reason the queue exists.

          Net movement, not a tap count. Twelve presses that cancel out read
          "0:00": the playhead has not moved, and saying "×12" about that is
          counting the fingers rather than reporting the jump. */}
      {burst && skipBurst && (
        <div
          role="status"
          aria-label={burst.direction === 0
            ? `Skipping, back where it started, at ${burstLanding}`
            : `Skipping ${burst.direction > 0 ? "forward" : "back"} `
              + `${formatTime(Math.abs(burst.net))} to ${burstLanding}`}
          className={`absolute left-1/2 -translate-x-1/2 pointer-events-none
                      flex items-center gap-2 rounded-full glass text-player-fg
                      shadow-lg tabular-nums
                      ${pip ? "top-2 px-2.5 py-1 text-[11px]" : "top-6 px-3.5 py-2 text-sm"}`}
        >
          {/* The transport's own two icons, so the badge reads as the thing
              those buttons are doing. Nothing at all when the burst nets out —
              an arrow over "0:00" would point somewhere it is not going. */}
          {burst.direction < 0 && <RotateCcw className={pip ? "w-3 h-3" : "w-4 h-4"} aria-hidden />}
          {burst.direction > 0 && <RotateCw className={pip ? "w-3 h-3" : "w-4 h-4"} aria-hidden />}
          <span className="font-bold">
            {burst.direction > 0 ? "+" : burst.direction < 0 ? "−" : ""}
            {formatTime(Math.abs(burst.net))}
          </span>
          {/* Where it lands, which is the part worth waiting for: the offset
              says how hard the button was pressed, this says where that puts
              you in the programme. */}
          <span className="text-player-fg-muted">{burstLanding}</span>
        </div>
      )}
    </div>
  );
}
