# Keeping an H.264 Recording Offline — Design

**Date:** 2026-09-22
**Status:** specified, not built.
**Follows:** `docs/superpowers/specs/2026-09-22-h264-recordings-playback.md`, which
made the device's codec label reach the player.

## What is wrong

The offline copy exists to turn a device recording into something this app can
play without the Tablo. Every window goes through the encoder
(`transcode_cache.py:1482`): deinterlace, scale to square pixels, H.264 out,
AAC out.

For a recording the box already encoded itself, every one of those steps is
waste. Recording 94904 is H.264 High, 1280×720 **progressive**, 2.3 Mbit/s —
measured 2026-09-22. Keeping it offline today means decoding that H.264 and
re-encoding it to H.264 at whatever the profile's bitrate is: a core spent per
window, a wait, and a generation of quality thrown away to arrive at a file the
browser could already play. The picture is already exactly what the offline copy
is trying to produce.

The one part that genuinely cannot stay is the audio. AC-3 is what every Tablo
recording carries and what no browser but Safari will decode — measured
2026-09-22, every `ac-3` mime string is false in Chrome, in MSE and in a bare
`<video>`. The MP4 export needs AAC too: `build_mp4` remuxes with `-c copy` and
`aac_adtstoasc`, which presumes AAC in ADTS framing.

## Goal

Keeping an H.264 recording offline copies its picture and converts only its
audio, and everything downstream — playback, seeking, progress, eviction, and
the Download button — behaves exactly as it does for a transcoded copy.

## Non-goals

- **MPEG-2 recordings.** They still transcode, unchanged. That is the whole
  library bar one.
- **The player.** It already plays a cached copy through hls.js; a copied window
  is the same H.264/AAC MPEG-TS a transcoded one is, so nothing there changes.
- **Live.** Untouched.
- **Re-copying what is already cached.** A copy made by the encoder stays as it
  is; this changes how new windows are produced, not old ones.

## The rule

One question, asked per window, answered from the device's own label:

```
source_codec == "h264"  → copy the picture, convert the audio
otherwise               → encode, exactly as today
```

`source_codec` is `video_details.container_format` mapped the way the player's
`codec` already is (`state.py:_VIDEO_CODECS`): `mpeg4` → `h264`, `mpeg2` →
`mpeg2`, anything else → `None`. `None` encodes, because that is what all but
one recording measured on this device has been.

## What the copy window runs

Today's command, minus the parts that only make sense when re-encoding:

```
ffmpeg -y -protocol_whitelist http,https,tcp,tls
  -ss <seek_to> -i <playlist> [-ss <preroll>] -t <length>
  -output_ts_offset <start>
  -c:v copy
  -c:a aac -b:a 160k -ac 2
  -f hls -hls_time 6 -hls_list_size 0 -start_number 0
  -hls_segment_filename seg_%02d.ts index.m3u8
```

Gone, and why:

- **`-vf` (deinterlace, square pixels, profile filters)** — a filter chain
  cannot run on a stream that is not being decoded, and there is nothing to fix:
  this source is progressive 720p with square pixels already.
- **`-c:v <encoder>` and its flags** — replaced by `copy`.
- **`-force_key_frames expr:gte(t,n_forced*6)`** — FFmpeg cannot place
  keyframes in a stream it is copying. This is the one load-bearing removal; see
  below.

## Keeping the window's shape without forcing keyframes

`build_playlist` (`transcode_cache.py:901`) publishes the whole timeline before
anything is encoded — `w{w:05d}/seg_{n:02d}.ts`, exactly
`segments_in_window(duration, w)` names per window. That is what lets a viewer
seek into a window that does not exist yet. The names are derived, so the files
must match them: a window that produces one file fewer leaves the playlist
naming a 404, and one file more hides that content from playback entirely.

Today `-force_key_frames` guarantees the match. Copying cannot, so the match
becomes something to **verify rather than assume**:

- Measured on 94904, 2026-09-22: its keyframes are every **1.001s** (probed
  across 12s of segments — 1.466, 2.467, 3.468, 4.469, 5.470, 6.271, 7.272 …).
  With a GOP that short, `-hls_time 6` cuts at the first keyframe at or after
  6s, i.e. ~6.006s, and a 60s window yields the same ten segments the playlist
  named.
- After a copy window finishes, count `seg_*.ts` against
  `segments_in_window(duration, w)`. On a match, mark the window done as usual.
- **On a mismatch, redo that window with the encoder** and mark it done from
  that. One retry, logged with both counts, and the window ends up in the shape
  the playlist promised. A source with sparse or scene-cut keyframes therefore
  degrades to exactly today's behaviour rather than to a broken window.

This is deliberately a check on the output rather than a probe of the input:
what matters is not what the GOP looked like at the start of a 60s window, it is
whether the files on disk are the files the playlist named.

## Where the codec comes from

`CacheMeta` gains `source_codec: str | None`. It is set when the entry is
registered, because that is the only moment the caller has the recording's
projection in hand:

- `POST /api/recordings/{id}/keep` (`recordings.py:1356`) already holds `info`,
  the library projection, which now carries `codec` — it passes
  `info.get("codec")`.
- `register()` takes `codec: str | None = None` and writes it onto the meta,
  updating it in place the way `source_duration` and `path` already are.
- Any caller that does not know passes nothing, and the entry encodes. That is
  the safe direction: a wrong "h264" would produce unplayable windows, while a
  wrong `None` merely spends the CPU it spends today.

## The Download button

`build_mp4` (`transcode_cache.py:814`) remuxes the cached segments with
`-c copy -bsf:a aac_adtstoasc -movflags +faststart`. A copied window is H.264
video and AAC-in-ADTS audio in MPEG-TS — the same thing a transcoded window is —
so the export needs no change at all.

That is the claim, and it is the one most worth distrusting, because it is the
whole point of the feature for the person asking. **Acceptance is end to end on
the real recording**: keep 94904 offline, wait for it to complete, press
Download, and confirm the file plays from the first frame to the last with sound
— not that the route returned 200.

## What this costs and saves

| | today (encode) | copied |
|---|---|---|
| video | decode + re-encode every window | bytes copied |
| audio | AC-3 → AAC | AC-3 → AAC |
| filters | yuv deinterlace + scale | none |
| quality | a generation lost | identical to the device's |
| size | the profile's bitrate | the source's 2.3 Mbit/s (~1 GB/hour) |

`estimate_bytes` (`transcode_cache.py:1145`) reserves
`source_duration × VIDEO_BITRATE_BPS / 8`. For a 2.3 Mbit/s source that
over-reserves, which is the harmless direction — it books more room than the
copy needs and `make_room` frees no more than it must.

## Tests

Hermetic, against the existing `fake_exec` harness in `test_recordings.py` —
never against the device, and never against recording 94904, which is the only
H.264 specimen in existence here and cannot be reproduced (it exists because a
wedged box was restarted mid-game and re-encoded what it recovered).

- `register(codec="h264")` stores the codec; re-registering updates it in place
  without clearing `pinned`.
- An `h264` entry's window command contains `-c:v copy`, no `-vf`, and no
  `-force_key_frames`; its audio flags are still `aac 160k 2ch`.
- An `mpeg2` entry's window command is byte-for-byte what it is today.
- An entry with no codec encodes.
- A copy window whose output has the expected segment count is marked done, and
  FFmpeg ran once.
- A copy window that produces the wrong number of segments is redone with the
  encoder, ends up marked done, and says so in the log.
- The export command is unchanged for a copied entry.

## Evidence

- 94904: `container_format: mpeg4`; segment probe `h264 High 1280x720
  progressive`, `ac3 48kHz 2ch`; 2.3 Mbit/s against 8.3–11.0 Mbit/s for every
  1080i MPEG-2 recording on the box.
- Keyframe spacing 1.001s, probed over 8 device segments.
- Chrome MSE/`canPlayType`: `avc1.64001f` true, every `ac-3` form false.
- `build_mp4` already copies rather than re-encodes, and needs AAC-in-ADTS.
