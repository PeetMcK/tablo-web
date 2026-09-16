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
  readonly error: string | null;
  /** Whatever this implementation can say about itself, for `tabloDebug()`. */
  diagnostics(): Record<string, unknown>;
  /** Subscribe; the returned function unsubscribes. */
  on(event: SurfaceEvent, handler: () => void): () => void;
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
