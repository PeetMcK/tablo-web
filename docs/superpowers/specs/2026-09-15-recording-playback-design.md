# Recording Playback with Cached Transcoding

**Date:** 2026-09-15
**Status:** Approved for implementation
**Scope:** Make Library recordings playable, backed by a persistent transcode cache.

---

## Problem

The Library tab lists recordings but cannot play them.

- `LibraryView.tsx:61` renders a play button with no `onClick`. It is decoration.
- No backend route targets `/recordings/`. `POST /api/stream/{identifier}` resolves to
  `client.watch()`, which hardcodes the live path `/guide/channels/{id}/watch`.
- `README.md` claims "Browse and watch your recordings directly in the browser." Only the
  first half is true.

Three secondary defects in the same surface:

- `state.py:554` — `thumbnail` is hardcoded `None`. Every card renders a placeholder.
- `state.py:560` — `paths[:50]` silently truncates with no indication in the UI.
- `get_recordings` reads descriptions from `episode` / `series` only, so sports recordings
  (which carry `event.description`) always show "No description available".

---

## Device API findings

Established empirically against a Tablo 4G QUAD (firmware 2.2.58) during design. These were
unknowns; all are now confirmed.

**Recording paths are category-scoped, not uniform.**

```
/recordings/sports/events/80888
```

Not `/recordings/airings/{id}`. `get_recordings` already returns this `path`, so it is
available without a second lookup.

**Watch endpoint mirrors live, and takes an empty body.**

```
POST /recordings/sports/events/80888/watch    →  200
{
  "token":        "768e61cb-...",
  "expires":      "2026-09-15T16:32:55Z",
  "keepalive":    165,
  "playlist_url": "http://172.16.16.121:80/stream/pl.m3u8?rXE9pJo-YgMRVGg9g1uMQQ",
  "bif_url_sd":   "http://172.16.16.121:80/stream/bif?...",
  "bif_url_hd":   "http://172.16.16.121:80/stream/bif?..."
}
```

`GET` on the same path returns 404. The live request body is accepted but unnecessary.

Note the playlist is served on **port 80**, not the device's API port 8887. `start_stream`
already derives `base_url` from `playlist_url` for this reason (`state.py:135-139`); the
recording path must do the same rather than assume the API port.

**Sessions expire in ~3.5 minutes and are refreshed by re-POSTing the same path.**

Measured: `expires` moved `16:34:00Z` → `16:35:01Z` after a re-POST at t+60s. `keepalive: 165`
is the advertised interval. Re-POSTing during an active session returns the *same*
`playlist_url`, so refreshing does not invalidate an in-flight reader.

This is not optional. A 3.5-hour recording outlives its session by two orders of magnitude.

**The device serves a complete VOD playlist.**

```
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:1
#EXTINF:1.11779,
#EXT-X-BYTERANGE:664956@0
/stream/segw.ts?wh35x-JEYRhE6rCbv6v8dw
```

46,849 lines / 1.6 MB, ~11,400 byte-range segments against a single `segw.ts`. The entire
recording is addressable immediately — a cache job can ingest end-to-end at full speed rather
than being paced at 1x realtime.

**Recordings are MPEG-2 and must be transcoded.**

```json
"video_details": { "container_format": "mpeg2", "audio": "ac3",
                   "width": 1280, "height": 720, "state": "finished",
                   "size": 10989793280, "duration": 12615, "error": null }
```

Channel flags corroborate: `"flags": ["mpeg2", "canRecord"]`. No browser MSE implementation
decodes MPEG-2 video — the same constraint already documented for live OTA at
`VideoPlayer.tsx:27-29`. Transcoding is mandatory, not an optimization.

**Thumbnails exist.**

`snapshot_image.image_id: 81904`, and `GET /images/81904` returns JPEG. The `thumbnail: None`
in `get_recordings` is an unfinished TODO, not a device limitation.

**Duration is reported twice and they disagree.**

`airing_details.duration` is 10800 (the scheduled slot). `video_details.duration` is 12615 (what
was actually recorded, including `recorded_offsets` padding of -15s/+1800s). The Library
currently shows the scheduled value, which understates every recording. Use `video_details`.

**Resume position is tracked device-side.**

`user_info: { "position": 0, "watched": false, "protected": false }`.

---

## Why cache

Recordings are immutable once `video_details.state == "finished"`. Re-transcoding 3.5 hours of
MPEG-2 on every play is waste that compounds per viewer and per replay.

Caching the transcode output keyed on `object_id` buys four things at once:

| | Without cache | With cache |
|---|---|---|
| Replay | Full re-transcode | Instant |
| Seeking | Impossible — live transcoder uses `delete_segments`, `hls_list_size 6` | Full range, once complete |
| Two viewers | Two FFmpeg processes, two device sessions | One job, shared |
| Resume | Lost on close | Natural — playlist persists |

The existing live transcoder (`stream.py:343-397`) cannot be reused as-is. It is built for
ephemeral live streams: a 6-segment sliding window with `delete_segments`, written to `/tmp`,
killed on session stop. Every one of those properties is wrong for VOD.

---

## Architecture

New module `backend/app/transcode_cache.py` owning the cache lifecycle. Routes stay thin.

```
POST /api/recordings/{object_id}/watch
        │
        ├─ cache COMPLETE ──────────► return cached playlist URL (instant, seekable)
        │
        ├─ cache RUNNING ───────────► attach to running job, return EVENT playlist
        │
        └─ cache ABSENT/FAILED ─────► resolve path → POST {path}/watch on device
                                      → spawn FFmpeg job + keepalive task
                                      → return EVENT playlist
```

### Cache layout

Persistent, on the existing `/data` volume — not `/tmp`. A cache that evaporates on container
restart defeats the purpose, and `/data` already survives (1.7 TB free on the target host).

```
/data/cache/recordings/{object_id}/
    meta.json          state, source duration, bytes, timestamps
    playlist.m3u8      EVENT while running, VOD (with ENDLIST) when complete
    seg_00000.ts ...   H.264/AAC segments
```

`meta.json`:

```json
{
  "object_id": 80888,
  "path": "/recordings/sports/events/80888",
  "state": "running | complete | failed",
  "source_duration": 12615,
  "bytes": 3120000000,
  "created_at": "2026-09-15T16:40:00Z",
  "completed_at": null,
  "last_access": "2026-09-15T16:40:00Z",
  "error": null
}
```

### State machine

```
ABSENT ──start──► RUNNING ──ffmpeg rc=0──► COMPLETE
                     │
                     └──rc!=0 / disk full ──► FAILED ──retry──► RUNNING
```

`RUNNING` with a dead process and no heartbeat is treated as `FAILED` on next access — this is
how a job orphaned by a container kill gets recovered rather than wedging that recording forever.
On startup, any directory in `RUNNING` is swept to `FAILED` for the same reason (mirroring the
existing `_startup_cleanup` intent at `stream.py:27`, but without its `pgrep -f` side effects).

### FFmpeg invocation

```
ffmpeg -y
  -protocol_whitelist http,https,tcp,tls     # NOTE: 'file' deliberately dropped
  -i <device playlist_url>
  -c:v libx264 -preset veryfast -crf 23
  -maxrate 4000k -bufsize 8000k
  -pix_fmt yuv420p -g 60
  -c:a aac -b:a 160k -ac 2
  -f hls
  -hls_time 6
  -hls_list_size 0                           # keep every segment in the playlist
  -hls_playlist_type event                   # append-only; becomes VOD on completion
  -hls_segment_filename seg_%05d.ts
  playlist.m3u8
```

Differences from the live transcoder and why:

- **`-hls_list_size 0`** + no `delete_segments` — the whole point. Every segment stays
  addressable, so seeking works.
- **`-hls_playlist_type event`** — signals an append-only playlist to the player. On clean exit
  the job rewrites the tag to `vod` and appends `#EXT-X-ENDLIST`, making it fully seekable.
- **`-preset veryfast -crf 23`** rather than `ultrafast`/`crf 28`. Live trades quality for
  latency because it must keep up in realtime. A cached VOD job is encoded once and watched
  many times; spending more CPU for a better, smaller artifact is the correct trade.
- **No `-vf yadif`.** Source is 720p progressive (`resolution: hd_720`). Deinterlacing is a
  1080i concern. Revisit if a 1080i recording surfaces — gate on `video_details.height`.
- **No `file` in the protocol whitelist.** The live transcoder includes it
  (`stream.py:367`) with no need; carrying that over would propagate a known weakness.

### Keepalive

While a job is ingesting, an `asyncio.Task` re-POSTs `{path}/watch` every 150s (under the
advertised 165s). It stops when FFmpeg exits. Without this, the device tears down the session
and FFmpeg fails partway with a truncated cache — which is exactly the `FAILED` path above.

### Concurrency

An in-process `dict[int, CacheJob]` plus a per-`object_id` `asyncio.Lock`. Two simultaneous
play requests for the same recording produce one FFmpeg process and one device session; the
second caller attaches to the running job.

Cross-process coordination is out of scope — the app is a single-container singleton, as the
existing module-level `state` singleton already assumes.

### Eviction

LRU by total cache size, budget from `TRANSCODE_CACHE_GB` (default 20).

- Checked before starting a new job, not on a timer.
- `RUNNING` entries are never evicted.
- Evict oldest `last_access` until under budget.
- If the budget cannot be met without evicting a running job, the new job is refused with a
  clear error rather than thrashing.

Disk guard: refuse to start if free space is under `max(2 GB, estimated output × 1.5)`.
Estimated output = `source_duration × 4000k / 8`. For the 12,615s sample: ~6.3 GB estimate,
~3.1 GB actual — deliberately conservative.

### Serving cached media

`GET /api/recordings/cache/{object_id}/{filename}`

Reuses the hardening already present on the live transcode route (`stream.py:52-103`) with its
bug fixed: that route validates containment with
`str(file_path).startswith(str(session_dir.resolve()))`, a string-prefix test that lets session
`abc` read `/tmp/tablo_transcode/abcd/...`. The new route uses `Path.is_relative_to`, and
`object_id` is coerced to `int` by FastAPI, which removes the traversal surface entirely.

---

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/recordings` | List recordings (enriched) |
| `POST` | `/api/recordings/{object_id}/watch` | Start/attach playback, returns stream URL + state |
| `GET` | `/api/recordings/{object_id}/status` | Transcode state + progress percentage |
| `GET` | `/api/recordings/{object_id}/thumbnail` | JPEG, proxied and signed |
| `GET` | `/api/recordings/cache/{object_id}/{file}` | Cached playlist and segments |
| `DELETE` | `/api/recordings/{object_id}/cache` | Evict one entry |

`GET /api/channels/library` is retained as a deprecated alias so the change is not breaking.

**`POST .../watch` response:**

```json
{
  "object_id": 80888,
  "stream_url": "/api/recordings/cache/80888/playlist.m3u8",
  "state": "running",
  "progress": 0.0,
  "resume_position": 0,
  "duration": 12615
}
```

**`object_id` → `path` resolution.** The client holds `object_id`; the device needs `path`.
`get_recordings` already fetches both, so it populates an in-memory
`dict[int, str]`. On a miss (cold start, direct API call) the map is refreshed once before
failing. Resolved paths are also persisted in `meta.json`, so a cached recording needs no
lookup at all.

### Enriched list payload

```json
{
  "object_id": 80888,
  "path": "/recordings/sports/events/80888",
  "title": "NFL Football",
  "subtitle": "Denver Broncos at Kansas City Chiefs",
  "description": "The Chiefs and Broncos meet in an AFC West matchup...",
  "start": "2026-09-15T00:15Z",
  "duration": 12615,
  "thumbnail": "/api/recordings/80888/thumbnail",
  "width": 1280, "height": 720,
  "state": "finished",
  "watched": false,
  "position": 0,
  "cache_state": "complete"
}
```

Description resolution order: `event.description` → `episode.description` →
`series.description`. `subtitle` comes from `event.title` (sports) or `episode.title`. This is
what fixes the always-null sports descriptions.

---

## Frontend

**`VideoPlayer` takes a discriminated union** rather than growing a parallel component. It
currently accepts `channel: Channel` and hardcodes a "LIVE" badge.

```ts
type PlaybackSource =
  | { kind: "live";      channel: Channel }
  | { kind: "recording"; recording: Recording }
```

Branches on: title/subtitle text, LIVE badge vs. seek bar, and which API call starts the
stream. Everything else — `usePlayer`, the controls overlay, keyboard shortcuts, fullscreen,
mute — is shared unchanged. The alternative, a separate `RecordingPlayer`, would duplicate
~150 lines of overlay chrome for a badge and a scrubber.

**Seek bar** is recording-only, driven by the `<video>` element's native `currentTime` /
`duration`. No custom logic — hls.js exposes VOD seeking through the standard media element
once the playlist is complete.

**Transcode progress.** When `state == "running"`, poll `/status` every 2s and show progress.
Playback starts immediately against the EVENT playlist; the user watches from the beginning
while encoding runs ahead. Seeking is clamped to the encoded portion until complete.

**`LibraryView`** gets the `onClick` it never had, plus `useState` for the selected recording,
rendering `VideoPlayer` when set.

---

## Live DVR — pause and rewind

Recordings get seeking for free from the VOD playlist. Live does not, and the reason is a
single flag pair in the live transcoder (`stream.py:377-379`):

```
-hls_list_size 6
-hls_flags delete_segments+independent_segments
```

Six segments at `-hls_time 6` is a ~36-second window, and older segments are deleted from
disk. There is nothing to rewind into.

**Change:** keep a bounded rolling DVR window instead of a minimal one.

```
-hls_time 6
-hls_list_size <LIVE_DVR_MINUTES * 10>      # default 600 = 60 minutes
-hls_flags delete_segments+independent_segments
```

`delete_segments` is retained deliberately — dropping it entirely would let a forgotten live
session grow without bound. A bounded window is the difference between a DVR and a disk leak.

Cost at 2000k: ~900 MB per session-hour. With `MAX_TRANSCODE_SESSIONS = 4` the worst case is
~3.6 GB in `/tmp`, on top of the recording cache's separate budget in `/data`. Window length is
read from `LIVE_DVR_MINUTES` (default 60) so it can be tuned down on constrained hosts.

**Client-side blocker.** `usePlayer.ts:38` sets `backBufferLength: 90`. hls.js evicts buffered
media older than 90 seconds, so even with segments on disk the player would discard them.
`backBufferLength` becomes a parameter: the DVR window for live, `Infinity` for recordings.

**Transport controls** become shared between live and recordings rather than recording-only:

- Play/pause for both. Pausing live simply stops consuming; the window keeps filling, and
  resuming continues from the pause point rather than jumping to the edge.
- Seek bar for both. For live it spans the DVR window, not the whole broadcast.
- The `LIVE` badge becomes a control: a red dot when at the live edge, and a clickable
  **GO LIVE** when behind. Determined by `video.duration - video.currentTime` against a
  small threshold.

**Scope limit.** DVR applies to the transcoded path only. Non-transcoded playback
(`/api/hls/...`) proxies the device's own playlist, whose window the app does not control.
Since OTA is always transcoded (`VideoPlayer.tsx:30`) this covers all broadcast channels;
OTT channels that stream H.264 directly keep whatever window the device provides.

## Testing

Existing suite is 17 tests, `TestClient`-based, no device required. Same approach.

**Backend unit** — `tests/test_recordings.py`

- `object_id` → `path` resolution, including refresh-on-miss
- Description precedence (`event` → `episode` → `series`)
- Duration prefers `video_details` over `airing_details`
- Cache state machine: absent → running → complete, and failure paths
- `RUNNING` with dead process is reported `FAILED`
- Eviction ordering by `last_access`; running entries never evicted
- Disk guard refuses when free space is short

**Backend security** — extends `tests/test_stream_security.py`

- `GET /api/recordings/cache/1/../../etc/passwd` → 4xx
- Sibling-directory escape (`cache/1/../2/seg_00000.ts`) → 4xx.
  This is the case the existing `startswith` check fails and `is_relative_to` catches.
- Unauthenticated access to every new route → 401

**Frontend** — `src/__tests__/recordings.test.tsx`

- Play button calls the watch API with the right `object_id`
- Progress indicator renders while `state == "running"`
- Seek bar hidden for `kind: "live"`, shown for `kind: "recording"`

**Manual, against the real device** — the Tablo is reachable at `172.16.16.121:8887`, so the
end-to-end path is verifiable: play `object_id 80888`, confirm transcode starts, playback
begins, cache completes, second play is instant, seeking works.

---

## Out of scope

Deliberately excluded to keep this reviewable:

- **Resume playback.** `user_info.position` is surfaced in the API and stored, but not wired
  into the player. Wiring it means seeking into a possibly-unencoded region — its own design.
- **Trick-play thumbnails.** `bif_url_sd` / `bif_url_hd` exist. BIF parsing is a separate feature.
- **Seeking ahead of the encode point.** Requires either full pre-transcode or `-ss` restart.
- **Recording management** (delete, protect) — read-only here.
- **Pre-warming** the cache for unwatched recordings.
- **The pre-existing auth gap.** The app still has no user authentication and wildcard CORS
  (see the security audit). These routes are exactly as exposed as every existing route.
  Fixing that is a separate change and must not be conflated with this one.

---

## Risks

| Risk | Handling |
|---|---|
| Transcode is slow on weak hardware | `veryfast` preset; playback starts immediately against EVENT playlist rather than waiting |
| Cache fills the volume | Size budget + LRU + pre-flight disk guard |
| Device session expires mid-ingest | Keepalive task at 150s, under the advertised 165s |
| Orphaned jobs after container kill | `RUNNING` swept to `FAILED` on startup and on dead-process detection |
| 1080i recordings need deinterlacing | Gate `yadif` on `video_details.height`; sample is 720p so unverified — flagged, not silently assumed |
| `container_format` is not always `mpeg2` | Detected per-recording; if H.264 already, the transcode could be `-c copy`. Not implemented in v1 — always transcode, correctness over cleverness |
