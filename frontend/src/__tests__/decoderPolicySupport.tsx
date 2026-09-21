/**
 * Fixtures for the decoder-policy tests.
 *
 * Kept beside them rather than inside: the file mocks two modules, and a
 * fixture defined in the same file as a `vi.mock` factory has to reason about
 * hoisting to be read at all.
 */
import { vi } from "vitest";

import type { Channel, Program, Recording } from "../api/tablo";
import type { OpenOptions } from "../lib/wasmlive/open";
import type { CaptionCue } from "../lib/captions";
import type { CaptionSource, PlaybackSurface } from "../lib/playbackSurface";

export type { Channel, Program, Recording, OpenOptions };

export const CHANNEL: Channel = {
  identifier: "S84522_007_02", call_sign: "K08PRD2", major: 7, minor: 2,
  network: "WORLD", kind: "ota", display_name: "7.2 K08PRD2",
};

export const NEWS_HOUR: Program = {
  title: "PBS News Hour", description: null,
  start: new Date(Date.now() - 15 * 60 * 1000).toISOString(), duration: 3600,
};

export const REC: Recording = {
  object_id: 80888,
  identifier: 80888,
  path: "/recordings/sports/events/80888",
  title: "NFL Football",
  subtitle: "Denver Broncos at Kansas City Chiefs",
  description: "AFC West matchup at Arrowhead Stadium.",
  start: "2026-09-15T00:15:00Z",
  // Sport: no series record and no episode numbers, which is what makes
  // the end card group by title and order by date.
  series_path: null, sport_path: null, season_number: null, episode_number: null,
  orig_air_date: null,
  duration: 12615,
  recorded_seconds: null,
  expected_seconds: null,
  recording_started: null,
  slot_seconds: 10800,
  thumbnail: "/api/recordings/80888/thumbnail",
  width: 1280,
  height: 720,
  state: "finished",
  error: null,
  watched: false,
  position: 0,
  protected: false,
  cache_state: "absent",
  cache_progress: 0,
  pinned: false,
  offline_only: false,
  paused: false,
  cached_seconds: 0,
  rate: { mbps: 0, realtime: 0 },
  channel: {
    identifier: "S34654_008_01", call_sign: "KTMFABC", network: "ABC", number: "23.1",
  },
  scan: "720p",
  interlaced: false,
  image_url: null, cover_frame: null,
  has_preview: false,
};

/**
 * A caption source a test drives directly.
 *
 * `announce` is what the session does the first time a cue arrives, which is
 * the moment the CC button is allowed to appear.
 */
export function stubCaptions(cues: CaptionCue[] = []): CaptionSource & { announce(): void } {
  const handlers = new Set<() => void>();
  let seen = cues.length > 0;
  return {
    get available() { return seen; },
    at: (seconds: number) =>
      cues.find((c) => seconds >= c.startSeconds && seconds < c.endSeconds) ?? null,
    on(_event: "change", handler: () => void) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    announce() { seen = true; handlers.forEach((fn) => fn()); },
  };
}

/** A surface the player can hold, shaped only as far as the player reads it. */
export function stubSurface(
  audioContext = "running",
  /* Left out by default, which is how the transcode fallback says it has no
     captions — and how every caller written before captions existed behaves. */
  captions?: CaptionSource,
): PlaybackSurface {
  return {
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    currentTime: 0,
    seekable: [0, 60] as const,
    duration: null,
    paused: false,
    muted: false,
    setMuted: vi.fn(),
    volume: 1,
    setVolume: vi.fn(),
    error: null,
    diagnostics: () => ({ kind: "wasm", audioContext }),
    on: () => () => {},
    captions,
    destroy: vi.fn(),
  };
}
