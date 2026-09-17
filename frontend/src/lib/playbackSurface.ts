/**
 * One playback interface, two implementations.
 *
 * The player's bar, scrubber, anchor and DVR arithmetic are all written
 * against `currentTime` and `seekable`. Putting those behind an interface is
 * what lets a canvas pipeline stand where the `<video>` element stands without
 * the rest of the player learning that anything changed.
 */

export type SurfaceEvent =
  | "ready" | "timeupdate" | "waiting" | "playing" | "paused" | "ended" | "error"
  | "volumechange";

/**
 * Where animation frames come from.
 *
 * `requestAnimationFrame` is a property of a window, and a document that is
 * hidden runs none — so a surface that paints rather than decodes has to be
 * told which window is actually on screen. Two functions rather than the
 * window itself: a test can then drive the loop by hand, with no display and
 * no clock involved.
 */
export interface FrameSource {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

/**
 * The tab's own clock, which is where every surface starts.
 *
 * Shared so that handing the loop back is the same operation as handing it
 * away, and neither side has to spell out what the default was.
 */
export const DOCUMENT_FRAMES: FrameSource = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** A running presentation loop, with the window it runs on still to be decided. */
export interface FrameLoop {
  /** Present from a different window's frames from now on. */
  setFrameSource(next: FrameSource): void;
  /** Stop, cancelling on whichever source is current. */
  stop(): void;
}

/**
 * Run `step` once per animation frame, on a source that can be changed under
 * it, until it returns false or the loop is stopped.
 *
 * The bookkeeping is the whole reason this is not four lines at the call site:
 * a handle belongs to the source that issued it, so a swap has to cancel on
 * the outgoing source before requesting from the incoming one. Miss that and
 * the old request survives — two loops then step the same session every
 * frame, which shows up as clock drift rather than as anything visible.
 */
export function startFrameLoop(
  step: () => boolean,
  initial: FrameSource = DOCUMENT_FRAMES,
): FrameLoop {
  let frames = initial;
  let handle = 0;
  let running = true;

  const tick = () => {
    if (!running) return;
    if (!step()) { running = false; return; }
    handle = frames.request(tick);
  };
  handle = frames.request(tick);

  return {
    setFrameSource(next: FrameSource) {
      if (!running) { frames = next; return; }
      frames.cancel(handle);
      frames = next;
      handle = frames.request(tick);
    },
    stop() {
      if (!running) return;
      running = false;
      frames.cancel(handle);
    },
  };
}

export interface PlaybackSurface {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  readonly currentTime: number;
  /** `[start, end]` in media seconds, or null before there is a range. */
  readonly seekable: readonly [number, number] | null;
  /** Fixed length in seconds, or null for live, which has none. */
  readonly duration: number | null;
  readonly paused: boolean;
  readonly muted: boolean;
  setMuted(muted: boolean): void;
  /**
   * The level, 0..1, independent of mute.
   *
   * Separate from `muted` because unmuting has to give back the level that
   * was set — which is also why zero here is not the same thing as muted.
   * Both implementations hold the two apart: one leans on the element, the
   * other on a gain node it was already using for exactly this.
   */
  readonly volume: number;
  setVolume(volume: number): void;
  readonly error: string | null;
  /** Whatever this implementation can say about itself, for `tabloDebug()`. */
  diagnostics(): Record<string, unknown>;
  /** Subscribe; the returned function unsubscribes. */
  on(event: SurfaceEvent, handler: () => void): () => void;
  /**
   * Present from a different window's frames from now on.
   *
   * Optional, and absent on the element-backed surface: a `<video>` decodes
   * on the media stack's own clock and keeps producing frames wherever its
   * document is. Only the painted surface has a loop to redirect.
   */
  setFrameSource?(next: FrameSource): void;
  destroy(): void;
}

/** Media events, mapped onto surface events. */
const EVENT_MAP: Record<string, SurfaceEvent> = {
  loadedmetadata: "ready",
  durationchange: "ready",
  timeupdate: "timeupdate",
  progress: "timeupdate",
  play: "playing",
  playing: "playing",
  canplay: "playing",
  seeked: "timeupdate",
  seeking: "waiting",
  waiting: "waiting",
  pause: "paused",
  ended: "ended",
  error: "error",
  volumechange: "volumechange",
};

/** Flatten a TimeRanges for logging. */
function ranges(list: TimeRanges | undefined): string {
  if (!list?.length) return "none";
  return Array.from({ length: list.length }, (_, i) => `${list.start(i)}-${list.end(i)}`).join(", ");
}

export function createHlsSurface(
  video: HTMLVideoElement,
  load: (url: string) => void,
  url: string,
): PlaybackSurface {
  const handlers = new Map<SurfaceEvent, Set<() => void>>();
  const attached: [string, EventListener][] = [];

  for (const [mediaEvent, surfaceEvent] of Object.entries(EVENT_MAP)) {
    const listener: EventListener = () => {
      handlers.get(surfaceEvent)?.forEach((fn) => fn());
      // Every media event moves the clock or the ranges, so the player's
      // transport reads once more whatever else it was told.
      if (surfaceEvent !== "timeupdate") handlers.get("timeupdate")?.forEach((fn) => fn());
    };
    video.addEventListener(mediaEvent, listener);
    attached.push([mediaEvent, listener]);
  }

  // Loading here rather than at the call site keeps "one surface, one load"
  // true: a surface that was constructed is a stream that was started.
  load(url);

  return {
    play: () => video.play(),
    pause: () => video.pause(),
    seek: (seconds: number) => { video.currentTime = seconds; },
    get currentTime() { return video.currentTime; },
    get seekable() {
      const ranges = video.seekable;
      return ranges.length
        ? ([ranges.start(0), ranges.end(ranges.length - 1)] as const)
        : null;
    },
    get duration() { return Number.isFinite(video.duration) ? video.duration : null; },
    get paused() { return video.paused; },
    get muted() { return video.muted; },
    setMuted(muted: boolean) { video.muted = muted; },
    get volume() { return video.volume; },
    setVolume(volume: number) { video.volume = volume; },
    get error() { return video.error ? `Media error ${video.error.code}` : null; },
    diagnostics: () => ({
      kind: "hls",
      readyState: video.readyState,
      buffered: ranges(video.buffered),
      seekable: ranges(video.seekable),
    }),
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    destroy() {
      for (const [type, listener] of attached) video.removeEventListener(type, listener);
      handlers.clear();
    },
  };
}
