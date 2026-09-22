# H.264 Recordings — Playback Design

**Date:** 2026-09-22
**Status:** specified, not built.

## What forced this

Recording 94904 (`NFL Football — Jacksonville Jaguars at Denver Broncos`,
2:21:12) would not play in Chrome. It played in Safari. Measured 2026-09-22:

```
[mpegts @ …] Could not find codec parameters for stream 0 (Video: h264 …): unspecified size
[tablo:warn] wasm decoder error: Codec not found
[tablo:warn] recording wasm gave up (decode error)
```

The recording is **H.264**, and the vendored WASM decoder
(`libav-6.10.9.0-tablo-mpeg2`) is an MPEG-2 build. Safari is not WASM-eligible,
so it took the transcode, where ffmpeg decodes H.264 without comment.

The device produced it, not the broadcaster. KPAX 8.1 carries
`flags: ["mpeg2", "interlaced", "canRecord"]` at `resolution: hd_1080`, and the
other recording of the same airing (74776) is `mpeg2video 1920x1080`,
`field_order: tt`. 94904's own bytes carry an encoder SEI —
`x264 core r2991M … Copyleft 2003-2019`, `High@3.1, ref=1, subme=2` — which is
real-time software encoding on the box. Its tuner recording died 68 minutes in
(74776: `recorded_offsets {start: -15, end: -6699}`, 4116s captured) and the
capture that replaced it (94904: `start: +4103`) was fed from the device's own
encoder rather than the tuner.

So this is not a broadcast format the app will see once. It is what this Tablo
does when a capture is restarted from its transcoded output, and it will happen
again.

## The labels already exist

The device says which codec a recording is, and the app throws it away.

| Field | MPEG-2 recording (74776) | H.264 recording (94904) |
|---|---|---|
| `video_details.container_format` | `"mpeg2"` | `"mpeg4"` |
| `video_details.audio` | `"ac3"` | `"ac3"` |
| `video_details.flags` | `["interlaced"]` | `[]` |
| `video_details.width` × `height` | 1920 × 1080 | 1920 × 1080 — **wrong** |
| ffprobe of segment 0 | `mpeg2video 1920x1080, tt` | `h264 High 1280x720 progressive` |

Surveyed across all 39 recordings on the device: 38 say `mpeg2`, one says
`mpeg4`. `container_format` is the device's word for the video codec family and
is the only field that distinguishes them — `flags` says interlacing, not codec,
and the dimensions are the device's intent rather than what it wrote.

`AppState._recording_fields` (`backend/app/state.py:1108`) projects `flags`,
`width`, `height` and drops `container_format`.

The live side has the same label in the same shape and drops it the same way:
a channel record carries `flags: ["mpeg2", …]`, and `_channel_details`
(`state.py:354`) reads that list only for `interlaced`.

## What the browser will actually take

Measured in the user's Chrome, 2026-09-22:

| MIME | `MediaSource.isTypeSupported` | `canPlayType` |
|---|---|---|
| `video/mp4` + `avc1.64001f` | true | probably |
| `video/mp4` + `avc1.64001f,mp4a.40.2` | true | probably |
| `video/mp4` + `avc1.64001f,ac-3` | **false** | no |
| `audio/mp4` + `ac-3` | **false** | no |
| `video/mp2t` + `avc1.64001f,ac-3` | **false** | no |

And measured against the real recording: hls.js pointed at the device's own VOD
playlist (`/api/vod/{sid}/playlist.m3u8`, segments proxied verbatim) **played
it** — `MANIFEST_PARSED`, `FRAG_PARSED` on segments 0–2, no errors, a seek to
1:00:00 landing at 3603s with `readyState: 4` and `buffered: 0 → 3611s`. Its
`BUFFER_CODECS` reported `{video: "avc1.64001f"}` and nothing else;
`hls.audioTracks` was 0. hls.js transmuxed the video into MSE and dropped the
AC-3 track silently.

**So the picture needs nothing. Only the audio needs converting.**

## Goal

An H.264 recording plays in every browser, with sound, without re-encoding the
picture — and without the WASM decoder being asked to do something it cannot.

## Non-goals

- **Teaching the WASM build H.264.** It stays the MPEG-2 decoder it is. If the
  vendored build ever gains H.264, the routing below is what decides to use it,
  and nothing else changes.
- **Live TV.** A tuner that starts serving H.264 live has the same problem and
  the same label (`channel.flags`), but the ring and its supply are a separate
  path with a separate failure story. Out of scope here; noted so the label is
  projected in a shape live can reuse.
- **Fixing the device's dimensions.** 94904 claims 1920×1080 and is 1280×720.
  See "What stays wrong".
- **Offline copies.** Keeping an H.264 recording offline still goes through the
  transcode cache exactly as today. It works, it is what "keep" already means,
  and the `-c:v copy` optimisation for it is a separate pass (see "Deferred").

## The rule

One question decides the path, asked before anything opens:

```
codec = the recording's projected codec        # "mpeg2" | "h264" | null

mpeg2, or null      → WASM decoder            (today's path, unchanged)
h264                → device bytes + audio swap, through hls.js
browser not eligible (Safari, Firefox, mobile):
  mpeg2             → transcode               (today's path, unchanged)
  h264              → device bytes + audio swap, through hls.js
```

`null` means the device said nothing recognisable. It takes the MPEG-2 path
because that is what 38 of 39 recordings are and what the path has always
assumed — but see "When the label lies".

Note what is *not* in the table: the transcode never runs for an H.264
recording. It is not needed — the encoder would decode H.264 and re-encode it to
H.264 at lower quality for no reason. This is not a violation of "the transcode
is not a rescue" (`docs/superpowers/specs/2026-09-17-no-transcode-fallback-design.md`);
it is the same principle applied one step earlier, by not choosing a decoder
that was never able to decode this.

## Backend

### 1. Project the codec

`AppState._recording_fields` gains one field:

```python
CODECS = {"mpeg2": "mpeg2", "mpeg4": "h264"}
...
"codec": CODECS.get(vd.get("container_format")),   # None when unrecognised
```

Named `codec` rather than `container_format` because it is the video codec, not
the container — everything here is MPEG-TS. The device's word is preserved in
the mapping so a third value (HEVC, when a 5th-gen box ships one) arrives as
`None` and takes the conservative path rather than being guessed at.

Also projected onto the snapshot used for offline-only recordings
(`recording_snapshot`), so a kept copy still knows what it was.

### 2. Swap the audio, copy the video

A new route beside the existing VOD proxy:

```
GET /api/vod/{session_id}/{nnnnn}.ts        # today: device bytes, verbatim
GET /api/vod/{session_id}/{nnnnn}.aac.ts    # new: video copied, audio as AAC
```

The existing route (`backend/app/routes/stream.py:911`) fetches one device
segment and returns it unchanged, one-for-one with the published index. The new
one runs that payload through:

```
ffmpeg -v error -copyts -i <segment> -c:v copy -c:a aac -b:a 160k -ac 2 -f mpegts -
```

`-c:v copy` means the H.264 is byte-identical to what the device wrote — no
quality loss, no encoder, no deinterlace (it is already progressive). `-copyts`
keeps the segment's own timestamps, so the playlist's `#EXTINF` values and the
player's seek math stay exactly as published. **Segment boundaries never move**,
which is what makes this cheap: none of the window/keyframe machinery in
`transcode_cache.py` is involved, and `-force_key_frames` — which cannot apply
to a copied stream — is never needed.

Measured on the real segment, three runs: **0.07–0.08s wall per 1.089s segment**
(248KB in, 240KB out), video `h264 1280x720` out, audio `aac` out,
`start_time: 2.778667` preserved. That is ~14× realtime for one process on one
core.

**Playlist.** `vod_playlist` names `{n}.aac.ts` instead of `{n}.ts` when the
session's recording is H.264. The session already knows the recording it indexes;
the codec is decided once, at session open, and stored on `VodSession`.

**Process model.** The device's segments are ~1.001s, so 1× playback is about
one ffmpeg per second of watching, and hls.js prefetches in bursts. Two guards:

- A small **LRU of swapped segments** per session (bytes, bounded — 64 segments
  is ~15MB), so a re-read, a scrub back, or two viewers on one recording pay
  once. Never written to disk: the existing route's contract is "fetched from
  the device on demand and never stored", and this keeps it.
- A **semaphore** bounding concurrent swaps the way `_fetch_bytes` bounds device
  reads, so a seek storm cannot fork fifty ffmpegs.

If a swap fails, the route answers 502 with the segment number in the detail —
not the unswapped bytes, which would be a silent track drop.

## Frontend

### 3. Route on the codec

`Recording` gains `codec: "mpeg2" | "h264" | null`.

`wasmLiveEligible(win, storage, channelKind)` already refuses OTT because OTT is
H.264 (`capability.ts:54`). The same question, asked of a recording, has the same
answer, so the signature grows a codec rather than a second function:

```ts
wasmLiveEligible(win, storage, channelKind, codec?: string | null)
// codec === "h264" → { eligible: false, reason: "h264 recording" }
```

In `VideoPlayer`'s recording branch (`VideoPlayer.tsx:1114`), the hardcoded
`"ota"` keeps its meaning and the recording's codec joins it. An ineligible
recording falls past the WASM block to the existing non-WASM path, which is
already `openSurface(stream_url)` over hls.js — the same surface OTT channels
use. The only change there is *which* URL: the raw VOD playlist for H.264,
the transcode for MPEG-2.

The comment at `VideoPlayer.tsx:1100` ("A recording is the same MPEG-2 and AC-3
the live path decodes") becomes false and must be rewritten, not merely
bypassed: a recording is *usually* that, and the device says when it is not.

### 4. When the label lies

A `null` codec takes the MPEG-2 path, so an unrecognised future format would
fail exactly as 94904 did today. One correction, once:

`onFailure` already distinguishes a rebuild from a give-up. A failure whose
reason is a **codec** failure (the worker's `Codec not found`, as opposed to a
starved supply or a lost context) is not a fault to report — it is a routing
mistake this design just made. On that reason only, and only once, re-open on
the audio-swap path instead of giving up, and log it as a correction.

This keeps the no-transcode-fallback rule intact: the swap is not a worse
picture, it is the same picture.

## What stays wrong

94904 reports `width: 1920, height: 1080` and is 1280×720, so the Library badge
reads "1080p" for a 720p recording. The honest number is in the bytes, which
means probing a segment — something nothing does today for the listing, and
which costs a device fetch per card. Left alone deliberately; noted so the next
person who sees "1080p" on this recording knows it is the device, not the badge.

## Deferred

- **`-c:v copy` in the transcode cache** for H.264 sources, so a kept offline
  copy stops re-encoding a picture it already has. Blocked on the window
  machinery's `-force_key_frames` contract, which assumes it controls GOPs.
- **Live H.264**, using `channel.flags` the way this uses `container_format`.
- **Probed dimensions** for recordings whose metadata disagrees with the stream.

## Tests

Backend:
- `container_format: "mpeg2"` → `codec: "mpeg2"`; `"mpeg4"` → `"h264"`; absent
  or unknown → `None`. (`test_recordings.py`)
- The swap route returns `video/mp2t` whose video packets are byte-identical to
  the device segment's and whose audio stream is AAC — asserted on a fixture
  segment, not a live device.
- The swap route's timestamps match the device segment's, so `#EXTINF` still
  describes it.
- A failing swap is a 502 naming the segment, never the unswapped bytes.
- The playlist names `.aac.ts` for an H.264 session and `.ts` for an MPEG-2 one.
- The swap LRU serves a second read of one segment without a second ffmpeg.

Frontend (`decoderPolicy.test.tsx`, which already owns "which decoder plays"):
- An H.264 recording never calls `openWasmSurface`, and opens the raw playlist.
- An MPEG-2 recording is unchanged — WASM, one rebuild, then the reason.
- A `null`-codec recording takes the WASM path.
- A WASM failure whose reason is `Codec not found` re-opens on the swap path
  once; any other reason still gives up with the reason shown.
- Safari (ineligible) on an H.264 recording gets the swap path, not the
  transcode.

## Evidence trail

- Device: Tablo 4G QUAD (`t4g4`), firmware 2.2.58, `/server/info`.
- `GET /recordings/sports/events/94904` → `video_details.container_format: "mpeg4"`.
- `GET /recordings/airings` × 39 → one `mpeg4`, 38 `mpeg2`.
- ffprobe of `/api/vod/{sid}/00000.ts` for 94904 and 74776 — codecs, dimensions,
  field order, x264 SEI.
- hls.js against the unmodified device playlist — plays, seeks, no audio track.
- `ffmpeg -c:v copy -c:a aac` on one segment — 0.07–0.08s, timestamps preserved.
