# The Tablo 4th-gen API

What a 4th-generation Tablo and its cloud accept, as far as we have established
it. Written down because no public documentation covers it, and because much of
what follows — the entire write surface, and most of the cloud guide surface —
was derived by probing real hardware rather than read from a spec.

Mapped against a `t4g4` ("Tablo 4G QUAD 128GB", firmware 2.2.58) on the LAN at
port 8887, and the account that owns it.

**This generation is not the old one.** The pre-4th-gen API is a different
protocol: unauthenticated HTTP on port 8885, a `/batch` endpoint, different
paths. Projects written against it (`jessedp/tablo-api-js` and its
descendants, and the docs at `jessedp.github.io/tablo-api-docs`) do not
transfer. `/batch` returns 404 here.

## Two APIs, and why you need both

| | Device (local) | Lighthouse (cloud) |
|---|---|---|
| Base | `http://<device>:8887` | `https://lighthousetv.ewscloud.com/api/v2` |
| Auth | HMAC-MD5 per request | `Authorization: Bearer <account_token>` |
| Channels | **23** — OTA only | **28** — OTA *and* OTT/FAST |
| Guide records | one request each (9,166) | whole guide in one request |
| Recording control | yes — this is the only place | no |
| Works offline | yes, on the LAN | no |

The split that matters: **OTT/FAST channels exist only in the cloud.** The
device returns zero airings for 500.1, 501.5, 501.6, 528.1 and 7.99. The
cloud, conversely, has no `path`, no `schedule` block and no `series_path` —
so it cannot schedule anything.

Neither is a superset. Anything that both displays a guide and manages
recordings needs both.

## Prior art, and what it misses

| Project | Covers | Misses |
|---|---|---|
| `trevor-viljoen/tablo-api` (vendored here) | `channels`, `watch`, `ping`, `server_info` | everything below |
| `gibme-npm/tablo.tv` | best published coverage: most `/server/*`, `/settings/info`, player sessions, three cloud calls | all writes; the cloud guide grid; `upcoming` |
| `hearhellacopters/tablo2plex` | one POST, `/guide/channels/{id}/watch` | its "schedule" files are local JSON for a Plex EPG, not device data |
| `jessedp/tablo-api-js` | previous device generation | does not apply |

`gibme-npm/tablo.tv` is the one worth reading. Its `Lighthouse` class knows
`/account/`, `/account/devices/`, `/account/select/`, `/devices/virtual/` and
`…/guide/channels/live/`. It does **not** know `/guide/grid/`,
`/guide/channels/{id}/airings/upcoming/`, `/guide/search/`, `/guide/shows/`, or
that the grid takes `limit` and `day` — which is where all the useful guide
data is.

---

# Device API

## Authentication

Every local request is signed. `TabloAuth.make_device_auth(method, path, body)`:

```
msg_hash = md5(body) if body else ""
payload  = f"{method}\n{path}\n{msg_hash}\n{date}"
sig      = hmac_md5(HASH_KEY, payload)
Authorization: tablo:{DEVICE_KEY}:{sig}
Date: {date}
```

The signature covers the body, so writes need no separate mechanism — the body
hash slot exists precisely because the scheme was designed for requests that
carry one.

**The signature covers the bare path, with the query string excluded.** Signing
`/guide/airings?day=2026-09-20` returns `401`; signing `/guide/airings` and
sending `?day=…` on the wire returns `200`. This is not obvious and the failure
looks like a credentials problem rather than a signing-scope one.

## Reads

### Server

| Path | Returns |
|---|---|
| `/server/info` | `server_id`, `name`, `version`, `build_number`, `local_address`, `model` (`type`, `tuners`, `wifi`, `name`) |
| `/server/capabilities` | `{"capabilities": [...]}` — see below |
| `/server/guide/status` | `guide_seeded`, `last_update`, **`limit`**, `download_progress` |
| `/server/tuners` | one entry per tuner: `in_use`, `channel`, `recording`, `channel_identifier` |
| `/server/harddrives` | `connected`, `format_state`, `kind`, `size`, `size_mib`, `busy_state`, `error` |
| `/server/location` | `state`, `location` (postal code, city, county, lat/long), `timezone` |
| `/server/subscription` | `state`, `expires`, `url`, `identifier` |
| `/server/update/info` | `available_update`, `state` (`none`/…), `current_step`, `sequence` (`["downloading","installing","rebooting"]` — the step order), `last_checked`, `last_update`, `details`, `error` |
| `/settings/info` | `led`, `extend_live_recordings`, `auto_delete_recordings`, `exclude_duplicates`, `preferred_audio_track`, `data_collection`, … |
| `/storage/info` | `{"supported_kinds": ["external", "internal"]}` |
| `/channels/info` | `{"committed_scan": …}` |
| `/account/subscription` | `services`, `state`, `trial`, `registration`, `subscriptions` |

`/server/guide/status.limit` is the **guide horizon** — the last instant the
device holds data for. Measured: `2026-09-30T14:00Z` on 2026-09-16, i.e. about
14 days out. It agrees exactly with what the cloud grid returns and with what
the Tablo app displays, so treat it as authoritative for "how deep does the
guide go" rather than probing for the edge.

`/server/location` carries the account holder's postal code and coordinates.
Do not log it or include it in a diagnostic bundle.

**Capabilities**, verbatim from this device:

```
guide_recording_refs  recordings_keep  recording_options  xSwup  search
subscription_services manual_programs_edit  airings_by_day  movie_ratings
genres  conflicts  cp  lc  rf  snap_grid  params  scan_stop  sap  ac3
library  netstatus  reclive
```

Several of these name features whose endpoint we have not found —
`airings_by_day`, `conflicts`, `search`, `snap_grid`. See **Unknowns**.

### Endpoints found by sweeping, not documented anywhere

A signed-GET sweep of ~130 candidate paths (`backend/tools/probe_endpoints.py`,
status-code archaeology: 404 absent, anything else a lead) turned up eight the
prior art never named. All read-only, all on 8887.

| Path | Returns |
|---|---|
| `/guide/channels/{id}` | one channel record — `object_id`, `path`, `channel` |
| `/guide/shows` | **all show paths in one list — 781 = series + movies + sports** |
| `/guide/programs` | manual programs — `[]` here (nothing manual scheduled) |
| `/recordings/shows` | recorded shows, aggregated across kinds |
| `/recordings/genres` | genre strings for the library (170, same set as `/guide/genres`) |
| `/recordings/programs` | recorded manual programs — `[]` here |
| `/server/network` | `server_id`, `ip`, `connection` (`ethernet`), `status` (`online`) |
| `/ping` | `{"sid": …}` — the cheapest liveness check on the box |

Two are worth acting on:

- **`/guide/channels/{id}` carries `channel.flags`** — `["mpeg2",
  "interlaced", "canRecord"]` on KSPS-HD. That is the codec and scan type of a
  channel **before any tuner is opened.** Everywhere else this is only known
  from the `watch` response, which costs a tuner. `?day=` is ignored; it is a
  channel record, not a schedule.
- **`/guide/shows` is one request for every series, movie and sport path** —
  700 + 69 + 12 = 781 here — where the three `/guide/{series,movies,sports}`
  collections are three. The recordings side has the same shortcut in
  `/recordings/shows`.

Still not found, after trying every spelling and `POST` as well as `GET`:
`snap_grid` (`/guide/grid`, `/guide/snap_grid`, `/guide/snapgrid`,
`/server/guide/grid`, … all 404), `conflicts`, `airings_by_day`, device-side
`search`, `params`, `netstatus`, `cp`, `lc`, `rf`, `reclive`. These are
advertised in `/server/capabilities` but route nowhere on firmware 2.2.58 —
either unimplemented, internal, or behind a path no analogy has reached. The
device has no guide grid: you walk airings. See **Unknowns**.

### The legacy port (8885) is alive but sealed

Port 8885 — the pre-4th-gen API port — is open and answers `Hello, World!`
unauthenticated at `/`. Every real path returns `401 unauthorized` (even
`/zzz/nonexistent`), so status-code archaeology cannot see through it, and the
current 4th-gen HMAC signature is rejected there too. It is the old-generation
protocol with its own key, not a second door into this one. Ports 22 (OpenSSH
8.2) and 443 (a static Apache serving only `<h1>Nuvyyo Tablo Server</h1>`, a
2014 self-signed cert, 404 on everything else) are open and equally not an API.

### Endpoints and writes confirmed by capturing the official app

The GET sweep finds reads; it cannot find writes, and it cannot find the
parameters a read actually honours. Both come from watching the real app. The
following is from one capture of the iOS app's **settings** screen (Proxyman,
device HTTP on 8887). One screen; more screens will add more.

**A read filter we had written off works.** §Unknowns says `?day=` on
`/guide/airings` is silently ignored. A *different* parameter is not:

```
GET /guide/airings?state=requested   -> only scheduled airings, each as
  {"identifier": "...", "schedule": {"state","qualifier","skip_reason",
                                     "skip_detail","offsets"}}
GET /guide/shows?state=requested     -> only shows with a rule, each as
  {"identifier","schedule":{"rule","channel_identifier","offsets"},
   "keep":{"rule","count"},"recordings_path"}
```

So `/guide/airings` and `/guide/shows` take a **`state`** filter (`requested`
seen; other values unmapped) and return a *projection* — just the identifier
and the schedule/keep sub-object, not the full record. This is how the app
lists "what have I asked to record" without walking everything.

**New read endpoints:**

| Path | Returns |
|---|---|
| `/views/recordings/recent?sort=age&order=desc&failed=false` | a server-composed, date-grouped view: `[{"key":"2026-09-19","contents":["/recordings/series/episodes/{id}", …]}, …]` |
| `/recordings/channels/{id}` | one channel as the *recordings* side sees it — adds `resolution` (`hd_1080`/`hd_720`/`sd`) to the `flags` the guide side carries |
| `/settings/recording_qualities/live` , `/settings/recording_qualities/recordings` | video quality profiles — `[]` here (see the transcode section) |
| `/server/harddrives` , `/server/location` , `/server/update/info` | as §Reads; the app reads all three on the settings screen |
| `/notifications/stream?client_type&client_version&client_build&device_id&device_type` | a long-lived event stream (SSE-style). It never ends; a naïve proxy that buffers it will stall |

`/views/` is a whole namespace the sweep never reached — the server composes
views (grouped, sorted, filtered) so the client does not have to. `recent` is
one; others are unmapped and worth capturing.

**`server/info` carries more than §Reads lists** — also `timezone`,
`availability` (`"ready"`), `cache_key`, `product` (`"tablo"`), and a
`deprecated` field naming a key on its way out (`"timezone"`).

**The write surface, observed rather than guessed.** Every write the settings
screen makes is a flat `PATCH`, one key per request, and the response is the
full updated object (so a write doubles as a read, same as the schedule writes):

| Write | Body | Notes |
|---|---|---|
| `PATCH /settings/info` | `{"led": "on"｜"dim"｜"off"}` | LED brightness — all three values observed |
| `PATCH /settings/info` | `{"auto_delete_recordings": bool}` | |
| `PATCH /settings/info` | `{"extend_live_recordings": bool}` | |
| `PATCH /settings/info` | `{"exclude_duplicates": bool}` | |
| `PATCH /settings/info` | `{"enable_amplifier": bool}` | tuner amplifier |
| `PATCH /settings/info` | `{"audio": "ac3"｜"aac"}` | the audio-transcode toggle (see transcode section) |
| `PATCH /server/info` | `{"name": "…"}` | renames the device |
| `POST  /server/update/check` | — (empty) | triggers a check; returns the full `update/info` object (so it doubles as a refreshed read). `state:"none"` + `available_update:null` = up to date |

`/settings/info` PATCH is flat (`{"led": …}`), unlike the *schedule* writes
which are nested — the write shape is per-endpoint, not global.

**The `lh` query flag.** Nearly every app request carries a bare `?lh` (no
value), often alongside real parameters (`?state=requested&lh`,
`?allowAudioTranscode=true&lh`). It is valueless and its effect is unmapped —
possibly "this request originates on the LAN / include lighthouse-derived
fields." Harmless to send; unclear what it changes. Worth a with/without diff.

**Cloud (`ewscloud`) capture** showed only `CONNECT` — the app pins, or the
capture had no CA for that host, so the HTTPS bodies were not decrypted. The
cloud surface in this doc still comes from our own signed calls, not the app.

### Series scheduling, addressed by cloud identifier — from a second capture

A second capture (iOS app, every series recording option exercised) rewrote how
much of §Writes should be read. Two structural surprises:

**The device guide is addressable by cloud identifier.** The app does not PATCH
`/guide/series/{numeric_id}`. It PATCHes **`/guide/{cloud_identifier}`** — the
same `C…_SHOW_…` show identifier and `LH-CEP…` airing identifier the *cloud*
returns. All of these are live device endpoints on 8887:

```
GET  /guide/C183890_SHOW_SH000037100000            one show's schedule/keep/offsets
GET  /guide/C183890_SHOW_SH000037100000/airings?state=…   that show's airings
GET  /guide/LH-CEP013451880184-S35314_011_01-T1789830000  one airing's schedule
PATCH /guide/C183890_SHOW_SH000037100000           the write target (below)
```

`GET /guide/{show_identifier}` returns
`{"identifier","schedule":{"rule","channel_identifier","offsets":{"start","end","source"}},"keep":{"rule","count"},"recordings_path"}`.
This is the bridge between the two APIs: the cloud gives you the identifier, and
the *device* accepts it directly — no need to resolve it to a numeric object id
first.

**`?state=` is the conflicts endpoint we could not find.** §Unknowns lists
`conflicts` as advertised-but-unrouted. It is not a path — it is a filter:

```
GET /guide/airings?state=requested     scheduled airings (projection)
GET /guide/shows?state=requested       shows with a rule (projection)
GET /guide/{show_identifier}/airings?state=conflicted   the show's conflicts
```

`state` takes at least `requested` and `conflicted`. So conflict discovery is
`?state=conflicted`, and `airings_by_day`/`conflicts`/`search` were never
missing paths — the guide reads take filters we had not sent. (`?day=` genuinely
is still ignored; `?state=` is the one that works.)

**The series write surface, every option, confirmed by 200 + device echo.**
`PATCH /guide/{show_identifier}`; the response is the full updated show object.
Sub-objects combine in one body.

| Field | Values (confirmed) | Meaning |
|---|---|---|
| `schedule.rule` | `"all"` ｜ `"new"` ｜ `"none"` | record everything / new only / off |
| `keep.rule` | `"all"` ｜ `"none"` ｜ `"count"` (+ `"count": N`) | how many to keep — **`count` is new** |
| `schedule.offsets` | `{"start": ±sec, "end": ±sec, "source": "show"｜"none"}` | recording padding in **seconds**; **`source:"show"` is new** (was thought `none`-only) |
| `schedule.channel_identifier` | a cloud channel id (`"S35298_013_01"`) ｜ `null` | pin the series to one channel, or unpin |

`keep.rule: "count"` with `count: 10` and `count: 5` both returned 200 with the
value echoed. `offsets.source` defaults to `"show"` (the show's own padding) and
was set to `"none"` in a combined write that returned 200. The standalone
`offsets` and `channel_identifier` writes in the capture show `999` — Proxyman's
"cancelled, empty body", the app debouncing rapid taps — so their *shape* is
known but a clean 200 was only seen for them inside the combined write
`{"keep":{"rule":"none"},"schedule":{"channel_identifier":null,"offsets":{"source":"none"}}}`.

**Two recording writes that are not schedule writes:**

```
PATCH /recordings/series/episodes/{id}   {"protected": true｜false}   -> 200
```
Protect one recording from auto-delete (the per-recording "keep" toggle). The
response is the full recording object — which also newly exposes
`guide_identifier` (the `LH-CEP…` airing this recording came from),
`series_path`, and `season_path`.

```
POST /recordings/series/{series_id}/delete   {"filter": "watched"}   -> 200, []
```
Bulk-delete a series' episodes by filter — `watched` seen. This is a
`POST …/delete` with a body, distinct from the single-recording `DELETE` in
§Writes.

**The recordings library has a season tier and server-composed views:**

| Path | Returns |
|---|---|
| `/recordings/series/{id}/seasons` | seasons of a recorded series |
| `/recordings/series/seasons/{id}` | one season |
| `/recordings/series/seasons/{id}/episodes?failed` | a season's episodes |
| `/recordings/series/{id}/episodes?sort&order&failed` | a series' episodes, sorted/filtered |
| `/views/library/counts` | the whole library index — per show `{title, identifier, recording, guide:{show_counts:{airing_count,conflicted_count,scheduled_count}, ota_show_counts, ott_show_counts, …images}}`, grouped |
| `/views/guide/upcoming` | upcoming airings, date-grouped `[{key:"YYYY-MM-DD", contents:["LH-CEP…", …]}]` |
| `/views/recordings/recent?sort&order&failed` | recent recordings, date-grouped |
| `/views/guide/channels/{channel_identifier}/airings?date=YYYY-MM-DD&state=…` | one channel's airings for a day — the read the guide grid is built from |

`/views/library/counts` is the single call behind the library screen —
`conflicted_count` per show is the same conflict data `?state=conflicted`
exposes per airing.

**There is no grid endpoint; the app builds the grid itself.** A guide-browse
capture showed the app calling `/views/guide/channels/{channel_identifier}/airings`
**once per channel** (all ~35), each with `?date=YYYY-MM-DD` and an optional
`?state=` filter, and laying the columns out client-side. Note `date` is
honoured *here* (in `/views/`) even though `?day=` on the raw `/guide/airings`
is ignored — the working date parameter lives on the view, not the collection.
This settles `snap_grid`: the official app has no single-request grid either, so
whatever `snap_grid` names, nothing uses it.

### Editing the channel lineup — commit a scan

A third capture (adding/removing a channel from the guide) showed the lineup is
not edited channel-by-channel. It is one write: **re-commit the whole set**.

```
POST /channels/scans/{scan_id}/commit
["/channels/scans/discovered/86531", "/channels/scans/discovered/86532", …]
-> 204
```

The JSON **array is the lineup**. A channel present in the array is in the guide
and tunable; drop its `/channels/scans/discovered/{id}` path from the array and
re-commit and it is gone from both. Verified by diffing two commits from the
capture: 25 paths then 27, the two added being exactly the two channels enabled.
There is no per-channel add/remove endpoint — the client reads the current set,
edits the array, and POSTs the whole thing back.

The `/channels/scans/` namespace behind it, all read-only GETs on 8887:

| Path | Returns |
|---|---|
| `/channels/info` | `{"committed_scan": …}` — points at the active scan |
| `/channels/scans/{id}` | scan meta — `postal_code`, `datetime`, `completed`, `progress`, `preferred_audio_track` |
| `/channels/scans/{id}/discovered` | every OTA channel the scan found, as `/channels/scans/discovered/{id}` paths |
| `/channels/scans/discovered/{id}` | one discovered channel — `signal_state` (`"good"`), `selected`, `recommended`, `new`, `physical_channel_path` (`/channels/physical/{n}`), and the full `channel` record (`flags`, `resolution`, `channel_identifier`) |
| `/channels/scans/{id}/expected_ota` | channels expected at that postal code (`[]` here) |
| `/channels/scans/{id}/ott` | OTT/FAST channels offered — `{identifier, name, discovered:false, selected, recommended, source:"network", logos}` |

**Running a scan** (fourth capture, a full OTA rescan and save) is a three-step
lifecycle:

```
POST /channels/scans                 -> 200 {object_id, postal_code, datetime,
                                             completed:false, progress:0.001}
GET  /channels/scans/{id}   (poll)   -> progress 0.001 → 0.23 → 0.93 → 1.0,
                                             completed flips true
POST /channels/scans/{id}/commit     -> 204   (the keep-array, as above)
```

`POST /channels/scans` takes **no body** — it just starts a scan and returns the
new scan object. The client then polls `GET /channels/scans/{id}` for
`progress`/`completed`, reading `/discovered` as it fills, and finally commits
the set to keep. A scan you do not want is simply never committed — the capture
started scan `#67`, let it finish, abandoned it, then started `#68` and
committed that. **No cancel/stop was sent**, so `scan_stop` (an advertised
capability) is still unmapped; abandoning a scan is not the same as stopping one
mid-run, which this never exercised.

### Guide

| Path | Returns |
|---|---|
| `/guide/channels` | list of channel paths — 23, OTA only |
| `/guide/airings` | list of airing paths — 9,166 |
| `/guide/series` | list of series paths — 738 |
| `/guide/movies` | list of movie paths — 76 |
| `/guide/sports` | list of sport paths — 13 |
| `/guide/genres` | list of genre names — 170 strings |
| `/guide/series/{id}` | `identifier`, `object_id`, `path`, `schedule`, `schedule_rule`, `series`, `show_counts`, `keep`, `recordings_path` |
| `/guide/series/episodes/{id}` | one airing: `episode`, `airing_details`, `schedule`, `series_path`, `path` |
| `/guide/movies/{id}` | `movie`, `show_counts`, `keep`, `recordings_path` |
| `/guide/sports/{id}` | `sport`, `schedule`, `schedule_rule`, `show_counts`, `keep` |
| `/images/{image_id}` | JPEG — **see the redirect note below** |

The collection endpoints return *paths*, not records. There is no batch
endpoint on this generation, so a full guide walk is one signed round trip per
airing: ~9,166 requests, measured ~130/s through our own proxy, roughly three
minutes. `/guide/series` is worth knowing about — it enumerates all 738 series
directly, rather than deriving them by walking every airing.

### `/images/{id}` redirects

Some ids return a JPEG body. **Most return a 302** to the device's *stream*
port:

```
302 → http://<device>:80/stream/thumb?id=5007&path=<base64>
```

Measured: 157 of 160 cover images for one 12-hour window redirected. An HTTP
client that does not follow redirects sees an error for almost every image.
The redirect target carries its own signed `path` parameter, so dropping the
`Authorization` header across the cross-origin hop (which httpx does
automatically) is correct.

This is the same port split `playlist_url` has: **media on 80, API on 8887**,
and `local_url` is the API one.

### Recordings

| Path | Returns |
|---|---|
| `/recordings/airings` | list of recording paths |
| `/recordings/series` | list |
| `/recordings/movies` | list |
| `/recordings/sports` | list |
| `/recordings/{kind}/{id}` | one recording: `airing_details`, `video_details`, `episode`/`event`/`movie`, `user_info`, `snapshot_image` |

Three details the device gets right that are easy to get wrong:

- Description lives under `event` for sports, `episode` for series, `series` as
  a fallback. Reading only the latter two leaves every sports recording with a
  null description.
- `video_details.duration` is what was actually recorded, including padding.
  `airing_details.duration` is only the scheduled slot and understates every
  recording.
- `video_details.flags` contains `"interlaced"`. Verified against ffmpeg's
  `idet` on six recordings — the flag and the detection agreed every time, so
  scan type is known without probing the stream.

### Playback

| Path | Method | Notes |
|---|---|---|
| `/guide/channels/{id}/watch` | POST | opens a live session |
| `/recordings/{kind}/{id}/watch` | POST | empty body; GET 404s |
| `/player/sessions/{token}` | GET / DELETE | session state, teardown |
| `/player/sessions/{token}/keepalive` | POST | extends expiry |

Re-POSTing an active `watch` refreshes its expiry and returns the same
`playlist_url`, which is what makes it usable as a keepalive.

**The app sends a body with `watch`; we send none and it still works.** Captured
from the iOS app:

```json
POST /guide/channels/{id}/watch
{"extra":{"width":375,"height":812,"deviceOS":"iOS","deviceOSVersion":"27.0",
          "deviceModel":"iPhone18,2","deviceMake":"Apple","lang":"en_US",
          "limitedAdTracking":1,"deviceId":"…"},
 "platform":"ios","bandwidth":null,"device_id":"…"}
```

The body is client/telemetry context — screen size, OS, ad-tracking, a device
id — plus a **`bandwidth`** field (null here). `bandwidth` is the only thing in
it that could plausibly influence the stream; it was never sent non-null, so
whether it selects a rate is untested — but given the single-variant MPEG-2
master (see the transcode section), there is probably nothing to select. Our own
`watch` sends an empty body and gets the same `playlist_url`, so the body is not
required.

The full live-session lifecycle, all captured against the real app:

```
POST   /guide/channels/{id}/watch        -> token, playlist_url, canRecord, …
POST   /player/sessions/{token}/keepalive-> 200, same session (before expiry)
DELETE /player/sessions/{token}          -> 204 (teardown)
```

`canRecord: true` in the watch response is the hint the player uses to offer
"record" — which then fires the schedule write, not a special verb (see the
`reclive` note under Unknowns).

**`playlist_url` is on port 80, not 8887.** Derive the stream base from the
returned URL; never assume `local_url`.

### The device does not transcode, and cannot be asked to

This generation hands over exactly what the tuner received. Probed three ways
(`backend/tools/probe_transcode.py`, `probe_stream_fmt.py`), all against a live
OTA channel:

**No endpoint.** 24 candidate paths — `/server/transcode`, `/server/encoder`,
`/server/profiles`, `/server/quality`, `/settings/transcode`,
`/settings/quality`, `/player/profiles`, `/transcode`, and the rest of the
obvious spellings — every one `404 none_found`. `/player/sessions/{token}` has
no `/info` or `/profiles` below it either.

**No parameter.** `POST /guide/channels/{id}/watch` accepts `quality`,
`profile`, `transcode`, `bitrate`, `resolution`, `codec`, `video_codec`,
`format`, `max_bitrate` and `audio_track` — and also `zzz_probe`, the control.
All return `200` with an ordinary session. The same keys as query parameters
behave identically. **The watch endpoint ignores unknown keys**, unlike the
strict `PATCH` validator, so the "send an invalid value and read `details`"
technique finds nothing here: a `200` means nothing was understood, not that
something was accepted.

**No format selector.** The master playlist's single variant points at
`/stream/pls.m3u8?<token>&fmt=v4`, and `fmt` is the only knob the device shows
anywhere in its own URLs. It is inert. 22 values (`v0`–`v6`, `1`, `2`, `4`,
`h264`, `avc`, `mpeg2`, `hls`, `ts`, `mp4`, `fmp4`, `low`, `sd`, `hd`, `ZZZ`,
and the parameter omitted entirely) each returned `200` and a first segment
that ffprobe read as, every time:

```
video=mpeg2video 1920x1080 tt | audio=ac3
```

Garbage and omission behave like `v4`, so `fmt` is not a codec or quality
selector — most likely a playlist-format version the media server no longer
branches on.

What the watch response does tell you is what you are getting, before a byte is
fetched: `video_details.container_format` (`mpeg2`), `flags` (`interlaced`),
`audio_details.container_format` (`ac3`), and a master playlist advertising
`BANDWIDTH=10000000`. `bif_url_sd` / `bif_url_hd` are null for live.

So client-side transcoding is the only option for **video**. But the picture
is not quite "the device cannot transcode at all" — see the audio note directly
below, found by capturing the official app.

### The device *does* transcode audio — `settings/info.audio`

Captured from the official iOS app (Proxyman, settings screen). `GET
/settings/info` normally returns what §Reads lists. Add **`?allowAudioTranscode=true`**
and the response gains one field:

```json
{"led":"dim","extend_live_recordings":true,"auto_delete_recordings":true,
 "exclude_duplicates":true,"audio":"ac3","preferred_audio_track":"default",
 "enable_amplifier":true}
```

`PATCH /settings/info {"audio":"aac"}` is accepted and the field flips to
`"aac"`; `{"audio":"ac3"}` flips it back (the app has no reachable control for
`preferred_audio_track`, the other audio field, so its write shape is unmapped
and would need a direct signed probe rather than a capture) — both observed, `200`, the full
settings object returned each time. So the box **can** re-encode its AC-3 audio
to AAC on the way out; it is a persistent device setting, not a per-stream
parameter. Video has no equivalent (below), so this does not remove the need to
transcode the MPEG-2 *video* — but a client that only needed AAC audio could
stop transcoding audio by flipping this once.

### Recording video transcode: plausible in hardware, not seen in this API state

The device has a hardware encoder and is understood to re-compress recordings on
its small **internal** storage to save space. Whether that is exposed or
observable through the API is a separate question, and on the box as captured the
answer is "not here, not now" — for a reason that is about storage, not the API:

- **Only an external drive is attached.** `/server/harddrives` lists one drive,
  `kind: "external"` (a 500 GB WD My Passport); the 128 GB internal is not even
  listed while the external is present. Recordings therefore land on the
  external.
- **Every recording captured is stored as MPEG-2.** Across all recordings seen,
  `video_details.container_format` is `"mpeg2"`, at roughly broadcast bitrate
  (~7 Mbps) — i.e. written through untouched, not re-encoded.
- **The quality-profile endpoints exist but are empty:**
  ```
  GET /settings/recording_qualities/live         -> []
  GET /settings/recording_qualities/recordings   -> []
  ```
  Not 404 — the surface is there — but this device offers no profile to choose.

**Internal-storage recordings are uncompressed too.** The internal drive is not
listed by `/server/harddrives`, but it does hold recordings — the NFL games on
this box are on internal. Their `video_details` is the direct test, and it comes
back full broadcast-rate MPEG-2:

```
Buffalo Bills at Houston Texans     mpeg2 1920x1080  14.4 GB / 235 min =  8.2 Mbps
Dallas Cowboys at New York Giants   mpeg2 1920x1080  18.2 GB / 225 min = 10.8 Mbps
Denver Broncos at Kansas City       mpeg2 1280x720   11.0 GB / 210 min =  7.0 Mbps
```

A re-encoded H.264 copy of a four-hour game would be a few GB, not fourteen. So
on firmware 2.2.58, in this state, recordings are **not** re-compressed on
internal any more than on external — every recording, both drives, is written
through as MPEG-2. If the hardware does re-compress to reclaim space, it is
either gated on the internal drive actually filling up (it was not full here) or
simply not active on this firmware; `/settings/recording_qualities/recordings`
(empty) is the only API surface that would select or report it, and nothing
populates it. A recording whose `video_details.container_format` is not `mpeg2`
would be the proof that it ever runs — none exists on this device today.

`video_details` on a finished recording carries more than §Reads noted:
`state` (`"finished"`), `clean` (bool), `cloud`, `uploading`, `size` (bytes),
`width`/`height`, `container_format`, `audio`, `has_snap_grid`, `seek`,
`recorded_offsets` vs `airing_offsets`, `flags`, `error`, `warnings`.

**Probing live playback can wedge the API.** During the `fmt` sweep (repeated
whole-playlist and segment fetches on port 80, ~25 minutes, plus ~20 `watch`
POSTs) port 8887 stopped answering HTTP entirely while still accepting TCP, and
stayed that way. Port 80 kept serving segments throughout. The API not
answering also means sessions cannot be released, so the tuner stays held. It
recovered by itself after roughly 40 minutes with no reboot. Space live probes
out and release each session before opening the next.

## Writes

**`PATCH` only** for the schedule. `POST` and `PUT` against these paths return
`404 none_found` — they are not routed at all. Deleting a *recording* is the
one exception, and uses `DELETE` — see below.

### Delete a recording

```
DELETE /recordings/series/episodes/{id}     ->  204
GET    /recordings/series/episodes/{id}     ->  404 object_not_found
```

Measured 2026-09-18 against a real device. The recording is gone from the
library immediately and its space is freed; there is no undo and no trash.

`OPTIONS` on the same path answers `204` with **no `Allow` header**, so the
device will not tell you the verb is supported — it had to be tried on a
recording that could be lost. The category segment is whatever the recording's
own `path` carries (`series/episodes`, `sports/events`, `movies`), which is why
the id alone is not enough to build the request.

### Record a single episode

```
PATCH /guide/series/episodes/{id}
{"scheduled": true}
```

Boolean. A string gives `400 Invalid parameter value`.

Note the asymmetry: the GET response exposes `schedule.state` (`"none"` /
`"skipped"` / …), but the write parameter is `scheduled`, a boolean, at the top
level. Read shape and write shape are not the same, and
`{"schedule": {"state": ...}}` is rejected.

The response is the full updated airing, so a write doubles as a read — no
follow-up GET is needed to refresh local state.

### Series rules

```
PATCH /guide/series/{id}
{"schedule": {"rule": "new"}}
{"keep":     {"rule": "none", "count": 5}}
{"schedule": {"offsets": {"start": 0, "end": 0, "source": "none"}}}
```

Nested, not flat. The GET response also exposes a top-level `schedule_rule`,
but writing that key fails with `Must specify at least one valid parameter` —
only the nested `schedule.rule` form is accepted.

`offsets` (recording padding) requires all three fields. Sending `start` and
`end` without `source` fails with `Missing value for 'source' string
parameter`, even when both values are valid.

**`schedule.rule` accepts `"all"`, `"new"` and `"none"`** — all three
confirmed, each written and then read back with a fresh GET, and the original
restored afterwards (`backend/tools/probe_schedule_rules.py`). An unknown value
is refused with:

```json
{"error": {"code": "invalid_patch_document",
           "details": {"rule": "ZZZ"},
           "description": "Invalid value for 'rule' parameter"}}
```

Measured on `/guide/series/5954` of a 727-series device, chosen because it had
`keep: {rule: "none"}` and so nothing to lose.

### Error contract

```json
{"error": {"code": "invalid_patch_document",
           "description": "Invalid value for 'rule' parameter",
           "details": {"rule": "ZZZ"}}}
```

`details` echoes the offending field and its value, so failures can be
surfaced to a user rather than reported as a generic error.

The validator is strict: unknown keys and bad values are rejected rather than
silently ignored. That is the property that makes this surface safe to build
against — a wrong guess returns 400 instead of doing something unintended.

---

# Lighthouse (cloud) API

Base `https://lighthousetv.ewscloud.com/api/v2`.
`Authorization: Bearer <account_token>`.

Two different tokens are in play and they are not interchangeable: the
**account token** authenticates, and the per-device **context token** (our
`lighthouse_token`; gibme calls it `context_token`) selects which device's
lineup you are asking about. It appears in the path.

## Account and devices

| Path | Returns |
|---|---|
| `/account/` | `identifier`, `email`, `firstName`, `lastName`, `postalCode`, `dma`, `devices`, `profiles` |
| `/account/{context_token}/` | same shape |
| `/account/devices/` | devices on the account |
| `/account/devices/{server_id}/resolve/` | one device, plus `reachability` and `url` |
| `/account/select/` | selects a device context (POST — not exercised here) |
| `/account/{context_token}/devices/` | `serverId`, `type`, `product`, `registrationStatus`, `lastSeen`, `name`, `reachability` |
| `/account/{context_token}/profiles/` | `identifier`, `name`, `date_joined`, `preferences` |
| `/devices/` , `/devices/virtual/` | 200 with an empty list from off-network; presumably LAN discovery |

`/account/` returns the holder's name, email and postal code. Treat as PII.

## Guide

All under `/account/{context_token}/guide/`.

| Path | Returns |
|---|---|
| `channels/` | 28 channels — `identifier`, `name`, `kind` (`ota`/`ott`), `logos`, `ota`/`ott` |
| `channels/{id}/` | one channel |
| `channels/{id}/airings/` | **exactly one** airing — what is on now |
| `channels/{id}/airings/upcoming/` | upcoming airings for that channel (8 by default, 50 with `limit`) |
| `channels/live/` | **what is on now across every channel, in one request** — 25 `{airing, channel}` pairs |
| `grid/` | the whole grid — see below |

Two more, outside the `{context_token}` prefix:
`/account/guide/channels/{id}/live/` (one channel's current airing, full record
with `episode`, `genres` and `images`) and `/account/devices/{server_id}/resolve/`
(one device, including a `url`).

### `channels/live/` replaces per-channel polling

If all you need is "what is on right now", this is one request for the whole
lineup. Fetching `channels/{id}/airings/` for each channel in turn — which is
the obvious reading of the per-channel endpoint, and what this codebase did
originally — costs one request per channel for identical data.
| `schedule/` | `next`, `total`, `results` |
| `shows/` | `identifier`, `title`, `sortTitle`, `sectionTitle`, `kind`, `images` |
| `search/` | `{channel, airing}` pairs |
| `genres/` | `next`, `total`, `results` |
| `live/` | `next`, `total`, `results` |
| `airings/` | **405** on GET |

### `channels/{id}/airings/` returns one record, always

It ignores every parameter tried — `limit`, `count`, `duration`, `start`,
`end`, `from`, `to`, `startTime`, `endTime`, `onnow`. It is "what is on now"
and nothing else. Reaching for it to build a schedule is the mistake this
codebase originally made.

### `grid/` is the useful one

```
GET /account/{context_token}/guide/grid/?limit=50&day=2026-09-20
```

Returns `{"grid": [{"channel": {...}, "airings": [...]}, ...], "next": ...}`.

Two parameters, both undocumented anywhere else:

- **`limit`** — without it the grid paginates at **4 channels per page**
  (7 pages, 7 requests). With `limit=50` the entire lineup comes back in **one
  response**, `next: null`. Only `limit` works; `page_size`, `pageSize`,
  `per_page`, `count` and `size` are all ignored.
- **`day=YYYY-MM-DD`** — walks forward a day at a time. Without it you get
  today. Other spellings (`date`, `start`, `startTime`, `datetime`) are
  accepted and ignored.

Measured coverage: ~950 airings/day across 28 channels, reaching **14 days**
(2026-09-30 returns partial, 2026-10-02 returns empty) — the same horizon
`/server/guide/status.limit` reports.

**So the entire 14-day guide, OTA and OTT, is 14 requests.** The device walk
for the same period is 9,166.

### Cloud airing record

```json
{
  "identifier": "LH-CEP049548040008-S79600_007_01-T1789570800",
  "title": "...", "datetime": "2026-09-16T04:00:00Z", "duration": 3600,
  "description": "...", "kind": "episode", "onnow": false, "qualifiers": 8,
  "channel": {"identifier": "S79600_007_01"},
  "episode": {"season": {"kind": "number", "number": 1},
              "episodeNumber": 4, "originalAirDate": null, "rating": "TVPG"},
  "show": {"identifier": "C24808079_SHOW_SH047566050000", "title": "..."},
  "images": [{"kind": "poster",     "url": "https://lighthousetv-cdn.../...jpg"},
             {"kind": "background", "url": "..."},
             {"kind": "coverLarge", "url": "..."},
             {"kind": "stillLarge", "url": "..."}]
}
```

The `identifier` encodes the slot: `T1789570800` is the start as a Unix epoch.

**Images are direct CDN URLs** — no auth, no redirect, no device round trip.
For display purposes this is strictly better than `/images/{id}` on the device.

**What it does not carry**, and why that matters: no `path`, no `schedule`
block, no `series_path`. Those are the PATCH target and the recording state.
The cloud is a complete *display* source and not a *control* source.

### Comparison for one airing

| Field | Device | Cloud |
|---|---|---|
| title, duration, description | yes | yes |
| season / episode number | `episode.season_number` / `.number` | `episode.season.number` / `.episodeNumber` |
| rating | `series.series_rating` (`"tvy"`) | `episode.rating` (`"TVY"`) |
| artwork | image id → 302 → port 80 | direct CDN URL |
| `path` (PATCH target) | yes | **no** |
| `schedule.state` / `skip_reason` | yes | **no** |
| `series_path` | yes | **no** |
| OTT channels | **no** | yes |

Note the casing differs (`tvy` vs `TVY`) and so does the nesting. They are not
the same record with different transport.

## Cost

| Task | Device | Cloud |
|---|---|---|
| Channel list | 1 | 1 |
| What is on now, all channels | ~650 | **1** (`channels/live/`) |
| One day, all channels | ~650 | **1** (`grid/?limit=50`) |
| 14 days, all channels | 9,166 | **14** |
| OTT schedule | impossible | included |
| Schedule a recording | 1 PATCH | impossible |

The two cloud rows are the same request count because the grid *is* a day of
airings; `channels/live/` is the narrower one when only the current programme
matters.

---

## Unknowns

**Device capability flags with no endpoint found.** `/server/capabilities`
advertises these; none of the obvious paths resolve:

- `airings_by_day` — `?day=` on `/guide/airings` is accepted and **silently
  ignored** (same 9,166 paths either way). `/guide/airings/{date}`,
  `/guide/airings/day/{date}`, `/guide/airings_by_day` and `/guide/days` all
  404. The shape is somewhere else.
- `conflicts` — **resolved.** Not a path: `GET /guide/airings?state=conflicted`
  (and `/guide/{show_identifier}/airings?state=conflicted`) is the conflict
  filter, and `/views/library/counts` carries a `conflicted_count` per show.
  See "Series scheduling, addressed by cloud identifier".
- `search` — `/guide/search` 404 on the device (the *cloud* has
  `guide/search/`).
- `reclive` — **not a distinct endpoint (confirmed by capture).** Watching a
  channel and recording the current programme fired `PATCH /guide/{airing_identifier}
  {"scheduled": true}` -> `200` — the ordinary episode schedule write, against the
  cloud airing identifier of what was on. Record-series is the same on the show
  identifier. There is no separate live-record verb; the player just issues the
  schedule write in place.
- `snap_grid` — **not a guide grid at all** (earlier guess corrected). Every
  recording's `video_details` carries `has_snap_grid: true`, so `snap_grid` is
  the *recording's* seek-thumbnail grid (the scrub-preview filmstrip, the role
  `bif_url_*` plays elsewhere). The endpoint that serves it is unmapped —
  seeking inside a recording in the app would reveal it. Separately, the guide
  has no single-request grid: the app builds it from
  `/views/guide/channels/{id}/airings?date=…` per channel plus
  `/views/guide/upcoming`.
- `scan_stop` — **resolved.** `POST /channels/scans/{id}/stop` -> `204`,
  captured by starting a scan and cancelling it mid-run. So the full scan verb
  set is `POST /channels/scans` (start), `GET …/{id}` (poll),
  `POST …/{id}/stop` (cancel), `POST …/{id}/commit` (save).

**Write enumerations.** The validator rejects bad values but does not list good
ones, so these need a deliberate write to confirm:

These are now **resolved** by the app capture (see "Series scheduling, addressed
by cloud identifier"), each written and echoed back with a 200:

- `keep.rule` — `"all"`, `"none"`, `"count"` (with `"count": N`).
- `offsets.source` — `"show"` (the default) and `"none"`.

`schedule.rule` (`"all"`/`"new"`/`"none"`) was already resolved.

**Cloud `schedule/`, `shows/`, `search/`, `live/`, `genres/`** return data but
their parameters and full record shapes are unmapped.

**`/account/select/`** is a POST in gibme's client; we have not exercised it.

## How to extend this safely

The write mapping was done without changing a single setting, using two
techniques. Both are worth reusing.

**Write the value that is already there.** Reading an object first, then
PATCHing a field to its current value, exercises the full path — auth, verb,
body signing, validation — while being a no-op. This is how `PATCH` was
confirmed as the verb.

**Send a deliberately invalid value.** A rejected write cannot change
anything, and the 400 names the field it objected to. This is how the
`scheduled` parameter was found: patching `{"schedule": {"state": "ZZZ"}}`
came back with `details={'scheduled': None}`, naming the parameter the device
actually wanted.

Choose a target with nothing to lose. The series used had
`keep: {rule: "none", count: null}` and zeroed offsets, so even replace-style
PATCH semantics could not have destroyed anything.

Verify by diffing the whole object before and after the run, not by reading
the response — a 200 does not prove the absence of a side effect elsewhere.

For **reads**, the cheap technique is status-code archaeology: a `404` means
the path does not exist, a `401` means it does and your signature was wrong,
and a `405` means it exists but wants a different verb. That distinction is
what turned up `?day=` on `/guide/airings` — it answered `401`, not `404`.
