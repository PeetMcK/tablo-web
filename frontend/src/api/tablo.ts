const BASE = "/api";

export interface AuthStatus {
  authenticated: boolean;
  email: string | null;
  devices: { sid: string; name: string }[];
  active_sid: string | null;
  /** Origin that reaches the backend without the proxy, when one exists. */
  direct_origin: string | null;
}

/**
 * Where to fetch a large export from.
 *
 * In native mode nginx runs inside the Docker VM while the backend runs on the
 * host, so a proxied download crosses the virtual network twice - measured at
 * 117 MB/s against 583 MB/s direct. This is only used for bulk file transfers;
 * everything else stays on the proxied /api path so there is one origin to
 * reason about.
 */
let directOrigin: string | null = null;

export function setDirectOrigin(origin: string | null): void {
  directOrigin = origin;
}

/**
 * A scrub-preview frame at `seconds`.
 *
 * The device's thumbnail pack holds one frame roughly every 10s, so the request
 * is rounded to that grid: distinct drag positions collapse onto the same URL
 * and the browser cache serves the repeats instead of the network.
 */
export function previewUrl(objectId: number, seconds: number): string {
  return `${BASE}/recordings/${objectId}/preview?t=${previewFrameAt(seconds)}`;
}

/**
 * The position of the frame the preview pack actually holds for `seconds`.
 *
 * Exported because anything that *keeps* a position has to agree with what the
 * popup showed at it, and the two roundings differ: this rounds to the nearest
 * frame, while the server returns the frame at or before what it is asked for.
 * Storing the raw pointer position instead meant a viewer who picked the frame
 * they were looking at, at 57s, kept the one from 50s — wrong about half the
 * time, and unmistakably wrong when the picture changed between them.
 */
export function previewFrameAt(seconds: number): number {
  return Math.max(0, Math.round(seconds / PREVIEW_GRID_SECONDS) * PREVIEW_GRID_SECONDS);
}

/** How far apart the device's preview frames sit. */
const PREVIEW_GRID_SECONDS = 10;

export function downloadUrl(objectId: number): string {
  return `${directOrigin ?? ""}${BASE}/recordings/${objectId}/download`;
}

export interface DebugReport {
  generated_at: string;
  server: { python: string; platform: string; arch: string };
  auth: { authenticated: boolean; device_count: number; active_device_name: string | null; active_device_sid: string | null };
  active_streams: number;
  recent_logs: string[];
}

export interface Channel {
  identifier: string;
  call_sign: string;
  major: number;
  minor: number;
  network: string;
  kind: string;
  display_name: string;
}

/**
 * How a live stream reaches the browser.
 *
 * `transcode` runs FFmpeg as it always has. `raw` proxies the device's own
 * HLS untouched, which plays for OTT and is unrenderable for MPEG-2. `ring`
 * copies the device's segments into a DVR window of our own, for the WASM
 * decoder to read.
 */
export type LiveMode = "transcode" | "raw" | "ring";

export interface StreamStart {
  session_id: string;
  proxy_url: string;
  stream_url: string;
  transcoded?: boolean;
  mode?: LiveMode;
  /** When the backend opened the session; media time is measured from here. */
  started_at?: string;
}

export interface TranscodeStatus {
  status: "active" | "stopped" | "inactive";
  /** Seconds of video the live encoder has produced, null before its first frame. */
  encoded_seconds: number | null;
  files?: string[];
  log?: string;
}

export interface Program {
  title: string | null;
  description: string | null;
  start: string;
  duration: number;
  genres?: string[];
  kind?: string | null;
  /**
   * Series poster for what is airing, as a device image id for
   * `/api/channels/image/{id}`.
   *
   * Null for roughly one airing in five: movies and sports are separate record
   * types with no series row, and some channels carry no EPG at all. Measured
   * on the mirror — 8,747 of 10,655 airings resolve one — and confirmed
   * against the device, where 19 of 26 channels with a programme had a poster.
   * The Live card reads null as "show the channel logo", so it is the empty
   * state rather than a failure.
   */
  poster_image_id?: number | null;
}

export interface GuideChannel {
  identifier: string;
  call_sign: string;
  major: number;
  minor: number;
  network: string;
  kind: string;
  display_name: string;
  logo_url: string | null;
  current_program: Program | null;
  /**
   * Scan type as the station broadcasts it, e.g. `1080i`, `720p`, `480i`.
   *
   * From the device, not the cloud: the cloud's channel record carries no
   * resolution at all — verified against the live account, where the union of
   * every key across all 28 channels had nothing about resolution, scan or
   * favourites. The device has all three at `/guide/channels/{id}`.
   *
   * Optional, though the backend always sends all three: it is null where the
   * device did not answer, and absent in fixtures that are not about channels.
   */
  scan?: string | null;
  interlaced?: boolean;
  /** Marked as a favourite on the device. Nothing reads it yet. */
  favourite?: boolean;
}

export interface GridChannel extends Omit<GuideChannel, 'current_program'> {
  airings: Program[];
}

/**
 * One airing joined to its series — everything the show sheet renders.
 *
 * Read from the guide mirror, never the device, so this resolves at local
 * speed. Almost every field is nullable: a channel with no EPG data yields a
 * sheet that is mostly title and channel, which is honest rather than broken.
 */
export interface AiringDetail {
  title: string | null;
  episode_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  description: string | null;
  start: string;
  duration: number;
  orig_air_date: string | null;
  genres: string[];
  rating: string | null;
  /**
   * Ready to put in a `src`, or null when there is no artwork.
   *
   * Two shapes, deliberately not normalised: a local `/api/channels/image/{id}`
   * for OTA, whose artwork lives on the device behind a signed request, and an
   * absolute `lighthousetv-cdn` URL for OTT, which has no device artwork at
   * all. Channel logos already come from that CDN, so both are the same kind
   * of thing to an `<img>`.
   */
  image_url: string | null;
  /** Computed server-side — the browser's clock may differ from the guide's. */
  airing_now: boolean;
  /**
   * The device can record this.
   *
   * False for OTT/FAST airings: they exist only in the cloud, which carries no
   * device path, no schedule block and no series — see docs/tablo-api.md.
   */
  schedulable: boolean;
  /** Derived server-side: any schedule state but "none", "skipped" or null. */
  scheduled: boolean;
  /**
   * Already finished, so recording it is no longer possible.
   *
   * Not the inverse of `airing_now`, which is also false for everything
   * upcoming — which is the main thing anyone records.
   */
  past: boolean;
  /** The device's own state string, passed through. */
  schedule_state: string | null;
  skip_reason: string | null;
  /**
   * The recording this airing produced, or null if it produced none.
   *
   * Null also until a library listing has run: the device owns the library and
   * nothing here learns of a recording before it is listed.
   */
  recording_id: number | null;
  /** Null for a one-off, a movie, or an airing whose series is unknown. */
  series: { path: string; schedule_rule: string | null } | null;
  channel: {
    /**
     * Null when the answer came from a recording rather than an airing.
     *
     * A guide sheet is addressed by this, so it always has one. A recording is
     * addressed by its own id, and a copy kept offline after the Tablo deleted
     * the original is described from the snapshot taken when it was pinned -
     * which carries no identifier if the device had none to record.
     */
    identifier: string | null;
    call_sign: string | null;
    major: number | null;
    minor: number | null;
    network: string | null;
    logo_url: string | null;
    kind: string | null;
  };
}

/** What a series records: every episode, only new ones, or nothing. */
export type SeriesRule = "all" | "new" | "none";

export type CacheState = "absent" | "partial" | "complete" | "failed";

export interface Recording {
  object_id: number;
  /** Alias of object_id, retained for backward compatibility. */
  identifier: number;
  path: string;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  start: string;
  /**
   * `/recordings/series/{id}`, the show this is an episode of.
   *
   * The *recordings* series rather than the guide's, so it means "other
   * recordings of this show". Null for anything the device files as sport,
   * which is why the end card groups by title when this is missing.
   */
  series_path: string | null;
  /**
   * `/recordings/sports/{id}`, where a game keeps what an episode keeps in
   * `series_path`.
   *
   * The device means the same thing by both: that record carries a title, a
   * description, the same three images and its own airing count, and the Tablo
   * app heads its sheet "Series Recording Scheduled". The sport is the series.
   */
  sport_path: string | null;
  season_number: number | null;
  episode_number: number | null;
  /** When it first aired, `YYYY-MM-DD`. Null for sport and for live events. */
  orig_air_date: string | null;
  /** Seconds actually recorded, including padding — not the scheduled slot.
   *  While `state` is "recording" the device has not settled this yet and it
   *  reads as the scheduled slot; `recorded_seconds` is what exists so far. */
  duration: number;
  /**
   * Seconds recorded so far, or null once finished — when `duration` is it.
   *
   * Counted from when the tuner actually started, which the device reports; the
   * only assumption left is that recording has run continuously since.
   */
  recorded_seconds: number | null;
  /**
   * How long this recording will be when it finishes, or null once it has.
   *
   * Not the scheduled slot: a show whose tuner started 63 minutes late will be
   * an hour shorter than booked, and a progress bar drawn against the slot
   * could never fill.
   */
  expected_seconds: number | null;
  /**
   * When the tuner actually began, ISO — for finished recordings too.
   *
   * Taken from the device's `recorded_offsets`, which is signed: a recording
   * that started early reports a time before `start`.
   */
  recording_started: string | null;
  /**
   * The scheduled slot, in seconds, always.
   *
   * `duration` stops meaning this the moment a recording finishes and becomes
   * what was actually captured, so the coverage bar is drawn against this
   * instead — a 3h game padded to 3h30 has a 3h slot and a 3h30 duration.
   */
  slot_seconds: number;
  thumbnail: string | null;
  /**
   * The show's own artwork, as the schedule's info box resolves it.
   *
   * The airing's own picture where there is one, else the series cover. Null
   * is ordinary — sport whose airing has aged out of the guide, or anything
   * recorded before a guide sync — and the card falls back to `thumbnail`.
   */
  image_url: string | null;
  /**
   * Seconds into the recording of the frame the viewer chose to lead with,
   * or null for none. The card's picture is `thumbnail` when this is set,
   * because that route serves the chosen frame.
   */
  cover_frame: number | null;
  width: number | null;
  height: number | null;
  /** Device-side recording state, e.g. "finished" or "recording". */
  state: string | null;
  /** Device-reported recording fault, if any. */
  error: string | null;
  watched: boolean;
  position: number;
  cache_state: CacheState;
  /** Fraction of the recording transcoded, 0-1. */
  cache_progress: number;
  /** Kept offline: exempt from eviction, removable only on request. */
  pinned: boolean;
  /** Cached copy of something the Tablo no longer has. */
  offline_only: boolean;
  /** Offline copy still wanted, but not being worked on right now. */
  paused: boolean;
  /** Seconds transcoded so far. */
  cached_seconds: number;
  /** Live transcode throughput. Zero once no window has landed recently. */
  rate: TranscodeRate;
  /** Station this was recorded from. */
  channel: RecordingChannel | null;
  /**
   * Whether the device's pack of scrub-preview frames is stored locally.
   *
   * False until something has been played: the pack is fetched alongside the
   * first stream. The card's strip offers a preview only where there is one.
   */
  has_preview: boolean;
  /** Scan type and height, e.g. "1080i" or "720p". */
  scan: string | null;
  /** 1080i sources need deinterlacing; 720p60 ones pass through untouched. */
  interlaced: boolean;
}

/** A recording in flight, as Live and Guide need it to mark their rows. */
export interface InProgressRecording {
  object_id: number;
  /** The guide's key for the airing, with `start`. */
  channel_identifier: string | null;
  /** Scheduled start — not when the tuner actually began. */
  start: string;
  /** The scheduled slot, in seconds. */
  duration: number;
  recording_started: string | null;
  recorded_seconds: number | null;
  expected_seconds: number | null;
  title: string | null;
  /**
   * The guide series this airing belongs to, or null if the guide never saw it.
   *
   * The guide's path, resolved server-side from `(channel, start)` — not the
   * recording's own `series_path`, which lives in the `/recordings/series/`
   * namespace and never equals what the info sheet holds.
   */
  series_path: string | null;
}

export interface RecordingChannel {
  /**
   * The key the guide and the info sheet are addressed by.
   *
   * Null for an offline copy of something the device has since deleted: the
   * airing that described it is gone too, so there is nothing to look up.
   */
  identifier: string | null;
  call_sign: string;
  network: string | null;
  /** Virtual channel, e.g. "8.1". */
  number: string | null;
}

export interface TranscodeRate {
  /** Megabits per second written to the cache. */
  mbps: number;
  /** Seconds of output produced per second spent encoding. */
  realtime: number;
}

export interface RecordingList {
  recordings: Recording[];
  returned: number;
  /** Device total. Exceeds `returned` when the fetch limit truncated the list. */
  total: number;
  /** How many entries exist only as offline copies. */
  offline_only: number;
}

export interface Storage {
  pinned_bytes: number;
  cache_bytes: number;
  total_bytes: number;
  budget_bytes: number;
  free_bytes: number;
  pinned_count: number;
}

export interface RecordingSeries {
  /** Null when the device files this as sport, which has no series record. */
  series_path: string | null;
  title: string | null;
  /** An id for `/api/channels/image/{id}`. Null is ordinary, not a failure. */
  cover_image: number | null;
}

export interface RecordingWatch {
  object_id: number;
  stream_url: string;
  state: CacheState;
  progress: number;
  duration: number;
  cached_seconds: number;
  cached_ranges: [number, number][];
}

export interface RecordingStatus {
  object_id: number;
  state: CacheState;
  progress: number;
  duration: number;
  /** Seconds of the recording already transcoded. */
  cached_seconds: number;
  /** Encoded regions as [startSec, endSec]. Not necessarily contiguous — a
   *  seek leaves the opening cached and adds a separate island. */
  cached_ranges: [number, number][];
  /** The window playback is blocked on, while one is being encoded. */
  encoding: EncodingProgress | null;
  error: string | null;
}

export interface EncodingProgress {
  window: number;
  /** Seconds into the recording where this window begins. */
  start: number;
  segments_ready: number;
  segments_total: number;
}

export type SearchKind = "channel" | "airing" | "recording";

/** What activating a result does. Mirrors the backend's `target`. */
export interface SearchTarget {
  tab: "live" | "grid" | "library";
  /** Channel identifier or recording object_id, when the result is playable. */
  watch?: string | number;
  /** ISO start, for a guide result. */
  at?: string;
  /** Channel the airing is on, for a guide result. With `at`, keys the show sheet. */
  channel_id?: string;
}

export interface SearchItem {
  kind: SearchKind;
  ref: string;
  title: string | null;
  subtitle: string | null;
  channel: string | null;
  start_epoch: number | null;
  duration: number;
  target: SearchTarget;
  /** For a past airing: the recording of it, if there is one. */
  recorded: { object_id: number } | null;
}

export interface SearchGroup {
  kind: SearchKind;
  /** Full match count, which may exceed `items.length`. */
  total: number;
  items: SearchItem[];
}

export interface SearchResponse {
  query: string;
  /** How far back guide history can be trusted. */
  coverage: { since: string | null; last_sync: string | null };
  groups: SearchGroup[];
}

async function* ndjsonStream<T>(path: string, signal?: AbortSignal): AsyncGenerator<T> {
  const res = await fetch(BASE + path, { signal });
  if (!res.ok || !res.body) throw new Error(res.statusText);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield JSON.parse(line) as T;
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as T;
  } finally {
    reader.cancel();
  }
}

function guideStream(signal?: AbortSignal) {
  return ndjsonStream<GuideChannel>("/channels/guide/stream", signal);
}

function guideGridStream(signal?: AbortSignal) {
  return ndjsonStream<GridChannel>("/channels/guide-grid/stream", signal);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

export const api = {
  status: () => req<AuthStatus>("/auth/status"),

  login: (email: string, password: string) =>
    req<{ devices: { sid: string; name: string }[]; active_sid: string | null }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    ),

  selectDevice: (sid: string) =>
    req<{ sid: string; name: string }>(`/auth/device/${sid}`, { method: "POST" }),

  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "DELETE" }),

  debugReport: () => req<DebugReport>("/channels/debug-report"),

  channels: (refresh = false) =>
    req<Channel[]>(`/channels${refresh ? "?refresh=true" : ""}`),

  /**
   * Re-read the account's channel list and rebuild the guide from it.
   *
   * Not a tuner scan — the backend re-fetches the list the Tablo cloud holds
   * for this device, which is the same one read on first connect. A channel
   * disabled in the Tablo app disappears because the account stops listing it.
   */
  refreshChannels: () =>
    req<{ channels: number; added: string[]; removed: string[] }>(
      "/channels/refresh", { method: "POST" },
    ),

  /**
   * One airing's full detail, keyed the way the grid already holds it.
   *
   * (channel, start) is `guide_airing`'s primary key, so no new identifier
   * has to be carried through the guide for this.
   */
  airingDetail: (channel: string, start: string) =>
    req<AiringDetail>(
      `/channels/airing-detail?channel=${encodeURIComponent(channel)}` +
      `&start=${encodeURIComponent(start)}`,
    ),

  /**
   * Record, or stop recording, one episode.
   *
   * Keyed the same way `airingDetail` is, and answers with the same shape: the
   * device replies to a write with the full updated record, so there is
   * nothing to re-fetch afterwards.
   */
  scheduleAiring: (channel: string, start: string, scheduled: boolean) =>
    req<AiringDetail>("/schedule/airing", {
      method: "PUT",
      body: JSON.stringify({ channel, start, scheduled }),
    }),

  /** Set the series rule. Affects every future episode, not just this one. */
  scheduleSeries: (channel: string, start: string, rule: SeriesRule) =>
    req<AiringDetail>("/schedule/series", {
      method: "PUT",
      body: JSON.stringify({ channel, start, rule }),
    }),

  guide: () => req<GuideChannel[]>("/channels/guide"),
  guideStream: (signal?: AbortSignal) => guideStream(signal),
  guideGridStream: (signal?: AbortSignal) => guideGridStream(signal),
  
  guideGrid: () => req<GridChannel[]>("/channels/guide-grid"),

  /** What is on one channel now and next, from the guide mirror. */
  channelAirings: (identifier: string) =>
    req<{ airings: Program[] }>(`/channels/${encodeURIComponent(identifier)}/airings`),

  /** @deprecated Use `recordings()` — this returns the unenriched legacy shape. */
  library: () => req<Recording[]>("/channels/library"),

  recordings: () => req<RecordingList>("/recordings"),

  /** Every stored resume position, keyed `"<kind>:<ref>"`. */
  resumeAll: () => req<Record<string, number>>("/resume"),

  putResume: (kind: string, ref: string, position: number, duration: number) =>
    req<{ ok: boolean }>("/resume", {
      method: "PUT",
      body: JSON.stringify({ kind, ref, position, duration }),
    }),

  /** One-shot handover of positions this browser stored before they moved server-side. */
  importResume: (entries: Record<string, number>) =>
    req<{ imported: number }>("/resume/import", {
      method: "POST",
      body: JSON.stringify({ entries }),
    }),

  /** Start or attach to a cached transcode. Returns immediately; if the cache is
   *  cold the returned playlist grows as encoding proceeds. */
  watchRecording: (objectId: number) =>
    req<RecordingWatch>(`/recordings/${objectId}/watch`, { method: "POST" }),

  /**
   * Follow a recording's own MPEG-2 segments, for the WASM decoder.
   *
   * A recording is MPEG-2 video with AC-3 audio - the same thing the live path
   * decodes - so playing it needs no transcode at all. The transcode is what
   * caching is for.
   */
  watchRecordingRaw: (objectId: number) =>
    req<{
      object_id: number;
      session_id: string;
      stream_url: string;
      origin_ms: number;
      mode: string;
    }>(`/recordings/${objectId}/watch-raw`, { method: "POST" }),

  /**
   * Serve a recording as MPEG-2, straight from the device, by byte range.
   *
   * Unlike `watchRecordingRaw` this is an index rather than a rolling window,
   * so playback starts at the first frame and seeks anywhere in what exists.
   *
   * A recording still being written comes back with `growing: true` and a
   * `duration` of what is held so far. It used to be refused with a 409, on the
   * belief that the device offered no reachable beginning for one; measured
   * against the device, it publishes from byte 0 and appends.
   */
  watchRecordingVod: (objectId: number) =>
    req<{
      object_id: number;
      session_id: string;
      stream_url: string;
      duration: number;
      segments: number;
      growing: boolean;
      mode: string;
    }>(`/recordings/${objectId}/watch-vod`, { method: "POST" }),

  /**
   * What is being recorded right now, for the views that are not the Library.
   *
   * Its own endpoint rather than fields on the guide: the guide is large,
   * synced and cached hard, while this changes every few seconds and is almost
   * always empty. Keyed by `(channel_identifier, start)`, which is how the
   * guide addresses the very same airings.
   */
  /**
   * Tell the device how far into a recording playback has got.
   *
   * The device keeps this in `user_info.position` and its own app writes it, so
   * writing here is what lets a phone and a browser agree about where you were.
   */
  setRecordingPosition: (objectId: number, position: number) =>
    req<{ object_id: number; position: number }>(
      `/recordings/${objectId}/position`,
      { method: "POST", body: JSON.stringify({ position: Math.max(0, Math.floor(position)) }) },
    ),

  /**
   * Mark a recording watched, or put it back.
   *
   * The device never works this out for itself — one played to its end still
   * read `watched: false` — so nothing marks it but us.
   */
  setRecordingWatched: (objectId: number, watched: boolean) =>
    req<{ object_id: number; watched: boolean }>(
      `/recordings/${objectId}/watched`,
      { method: "POST", body: JSON.stringify({ watched }) },
    ),

  /**
   * The show a recording belongs to, for the card shown at its end.
   *
   * Only the artwork needs this: everything the card orders by is already on
   * each recording, but a recording carries no `series` object — just a path to
   * one — so the cover is a fetch further away.
   */
  recordingSeries: (objectId: number) =>
    req<RecordingSeries>(`/recordings/${objectId}/series`),

  /**
   * What the info sheet shows, built from the recording rather than the guide.
   *
   * The sheet is keyed on `(channel, start)` in the guide mirror, which is
   * right for something upcoming and unreliable for something already
   * recorded: the device lists airings forward from roughly now, so a
   * recording outlives its own listing within days rather than within the
   * month the retention policy suggests. Measured 2026-09-18 — the mirror's
   * earliest row was from the 15th, while recordings from the 13th were still
   * in the library and their sheets said "Information unavailable".
   */
  recordingDetail: (objectId: number) =>
    req<AiringDetail>(`/recordings/${objectId}/detail`),

  /**
   * Make the frame at `t` seconds the picture this recording's card leads with.
   *
   * A position rather than a picture: the frame is already on disk in the BIF
   * pack the scrub preview reads, so nothing is copied.
   */
  setRecordingCover: (objectId: number, t: number) =>
    req<{ object_id: number; cover_frame: number }>(
      `/recordings/${objectId}/cover`,
      { method: "POST", body: JSON.stringify({ t: Math.max(0, t) }) },
    ),

  /** Put the card's picture back to the show's own artwork. */
  clearRecordingCover: (objectId: number) =>
    req<{ object_id: number; cover_frame: null }>(
      `/recordings/${objectId}/cover`, { method: "DELETE" },
    ),

  inProgressRecordings: () =>
    req<{ recordings: InProgressRecording[] }>("/recordings/in-progress"),

  /** Doubles as the "still watching" heartbeat that bounds server-side prefetch. */
  recordingStatus: (objectId: number, position?: number) =>
    req<RecordingStatus>(
      `/recordings/${objectId}/status${position != null ? `?position=${Math.floor(position)}` : ""}`,
    ),

  /** Stop transcoding without deleting what is already cached. */
  releaseRecording: (objectId: number) =>
    req<{ ok: boolean }>(`/recordings/${objectId}/release`, { method: "POST" }),

  /** Keep a full offline copy: transcodes everything, exempt from eviction. */
  keepRecording: (objectId: number) =>
    req<{ pinned: boolean; progress: number }>(`/recordings/${objectId}/keep`, { method: "POST" }),

  /** Stop keeping it. The transcode remains until eviction reclaims it. */
  unkeepRecording: (objectId: number) =>
    req<{ pinned: boolean }>(`/recordings/${objectId}/keep`, { method: "DELETE" }),

  pauseKeep: (objectId: number) =>
    req<{ paused: boolean }>(`/recordings/${objectId}/keep/pause`, { method: "POST" }),

  resumeKeep: (objectId: number) =>
    req<{ paused: boolean }>(`/recordings/${objectId}/keep/resume`, { method: "POST" }),

  deleteRecordingCache: (objectId: number) =>
    req<{ ok: boolean }>(`/recordings/${objectId}/cache`, { method: "DELETE" }),

  /**
   * Delete the recording on the Tablo. Irreversible, and not the same thing as
   * `deleteRecordingCache`, which only drops the transcoded copy.
   */
  deleteRecording: (objectId: number) =>
    req<{ object_id: number; deleted: boolean }>(`/recordings/${objectId}`,
      { method: "DELETE" }),

  storage: () => req<Storage>("/recordings/storage"),

  evictRecording: (objectId: number) =>
    req<{ ok: boolean }>(`/recordings/${objectId}/cache`, { method: "DELETE" }),

  startStream: (identifier: string, transcode?: boolean, mode?: LiveMode) => {
    const params = new URLSearchParams();
    if (transcode !== undefined) params.set("transcode", String(transcode));
    if (mode !== undefined) params.set("mode", mode);
    const query = params.toString();
    return req<StreamStart>(`/stream/${identifier}${query ? `?${query}` : ""}`, {
      method: "POST",
    });
  },

  stopStream: (sessionId: string) =>
    req<{ ok: boolean }>(`/stream/${sessionId}`, { method: "DELETE" }),

  transcodeStatus: (sessionId: string) =>
    req<TranscodeStatus>(`/transcode/status/${sessionId}`),

  search: (q: string, opts?: { limit?: number; kinds?: SearchKind[] }) => {
    const p = new URLSearchParams({ q });
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.kinds?.length) p.set("kinds", opts.kinds.join(","));
    return req<SearchResponse>(`/search?${p}`);
  },
};
