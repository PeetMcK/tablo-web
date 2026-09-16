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
  const t = Math.max(0, Math.round(seconds / 10) * 10);
  return `${BASE}/recordings/${objectId}/preview?t=${t}`;
}

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

export interface StreamStart {
  session_id: string;
  proxy_url: string;
  stream_url: string;
  transcoded?: boolean;
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
  /** Already a URL path, or null when the series has no cover art. */
  image_url: string | null;
  /** Computed server-side — the browser's clock may differ from the guide's. */
  airing_now: boolean;
  channel: {
    identifier: string;
    call_sign: string | null;
    major: number | null;
    minor: number | null;
    network: string | null;
    logo_url: string | null;
    kind: string | null;
  };
}

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
  /** Seconds actually recorded, including padding — not the scheduled slot. */
  duration: number;
  thumbnail: string | null;
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
  /** Scan type and height, e.g. "1080i" or "720p". */
  scan: string | null;
  /** 1080i sources need deinterlacing; 720p60 ones pass through untouched. */
  interlaced: boolean;
}

export interface RecordingChannel {
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

  storage: () => req<Storage>("/recordings/storage"),

  evictRecording: (objectId: number) =>
    req<{ ok: boolean }>(`/recordings/${objectId}/cache`, { method: "DELETE" }),

  startStream: (identifier: string, transcode?: boolean) => {
    let url = `/stream/${identifier}`;
    if (transcode !== undefined) {
      url += `?transcode=${transcode}`;
    }
    return req<StreamStart>(url, { method: "POST" });
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
