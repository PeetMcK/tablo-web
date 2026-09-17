# Playing finished recordings as MPEG-2 — design

**Date:** 2026-09-17
**Status:** proposed

## The problem

A finished recording is watched today by transcoding it to H.264 with FFmpeg,
on demand, into a disk cache. That works, but it costs an encoder for something
the browser can already decode: the recording is **MPEG-2 video with AC-3
audio**, which is exactly what the WASM decoder was built for and what live
channels already use.

Live channels and in-progress recordings now play as MPEG-2 (`758e164`).
Finished recordings are the remaining gap.

## What the device gives us

Measured against this device, a 3½-hour recording
(`/recordings/sports/events/66220`):

```
segments        8542
unique uris     29          (byte-ranged into 29 files)
byte-range      8542 lines
total duration  12913s (215.2 min)
avg segment     1.512s
ENDLIST         present
playlist size   1.2 MB
```

Every segment carries `#EXT-X-PROGRAM-DATE-TIME`. The first lines:

```
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1.53487,
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T20:24:48.000Z
#EXT-X-BYTERANGE:1667560@0
/stream/segw.ts?aOTs2y9ha4JUW8NQ2yhbcw
```

This is a **complete VOD index**: fixed length, every segment addressable,
`ENDLIST` present. That is the whole reason this is worth building and the
reason the in-progress case is not — an in-progress recording is published as a
live-shaped playlist with no `ENDLIST` and only a ~30 minute sliding window, so
it cannot be played from its beginning by us, by the official iPhone app, or by
anything else.

## The constraint that decides the design

**The media must not be copied to disk.** `RingFollower` downloads segments
into a ring, which is right for live — a bounded window of a stream that has no
end. Applied to a 3½-hour recording it would mean ~25GB per viewing, for
content the device already has.

So this is a **proxy**, not a ring: we serve an index that points at the
device's own bytes and fetch each segment on demand as the player asks for it.

## Design

### Backend

**`POST /api/recordings/{id}/watch-vod`** — opens a device watch session,
fetches the variant playlist once, parses it into an in-memory index, and
returns our own playlist URL plus the real duration.

The index is a list of `(uri, byte_range, duration)` and is a few hundred KB
for the longest recording — cheap to hold, and it is the thing that makes
seeking work, because every segment's position is known up front.

**`GET /api/vod/{session}/playlist.m3u8`** — the index rewritten as our own
playlist: our segment names, the same `EXTINF` durations, `EXT-X-ENDLIST`. No
`PROGRAM-DATE-TIME` is needed because media time here is simply elapsed time
from zero, which is what a recording's scrubber already shows.

**`GET /api/vod/{session}/{n}.ts`** — fetches segment `n` from the device using
the stored byte range and streams it back. Nothing is written to disk.

Sessions reuse the existing lifecycle: registered in `state.streams` with the
device token so the keepalive and the idle reaper cover them, released on
`DELETE /api/stream/{id}` like everything else.

### Frontend

The existing `createSession` is built around a live ring — it polls the
playlist for new segments, joins near the live edge, and treats the window as
sliding. A VOD playlist needs none of that, and two of its behaviours are
actively wrong here: re-polling a playlist that will never change, and starting
near the end.

Rather than add modes to the live transport, the session gains a **VOD mode**
that changes three things and leaves the rest — decoder, presenter, audio
clock, fallback — untouched:

1. **Fetch the playlist once.** No polling; it carries `ENDLIST`.
2. **Start at the beginning** (or the resume point), not the live edge.
3. **`seekable` is `[0, duration]`**, from the index rather than from what has
   been fetched.

Feeding stays exactly as it is: the same lookahead, the same pacing against the
audio clock, the same field queue. A seek already tears down and rebuilds the
decoder at an epoch, which is precisely what seeking in a VOD needs.

### What does not change

- Caching and `Keep` still transcode. That is what an offline copy is for, and
  H.264 is the right format for one.
- `/watch` and the transcode cache are untouched; the player falls back to them
  on any failure.
- In-progress recordings keep the ring path from `758e164`.

## Alternatives considered

**Extend `RingFollower` to seek.** Re-targeting the follower on every seek, so
the ring holds a window around the playhead. Rejected: it still copies media to
disk, and it makes the follower serve two very different jobs.

**Transcode-on-demand as now, but to MPEG-2 instead of H.264.** Rejected: it
still runs FFmpeg over content that needs no conversion.

**Download the whole recording first.** Rejected: ~25GB and a long wait before
the first frame, to avoid a proxy that costs neither.

## Risks

- **Seek latency.** Each seek rebuilds the decoder and refetches from the
  device. Live already does this on every seek and it is acceptable there; a
  VOD seek has further to jump, so it wants measuring rather than assuming.
- **Byte-range fetches per segment.** 8542 segments at ~1.5s each is one device
  request per 1.5s of playback — the same rate the live follower already
  sustains, but over a longer session.
- **The 165-second session expiry** applies here as it does everywhere; the
  keepalive covers it, and a VOD session is exactly the kind a viewer pauses
  for a long time, so this is the path where an expiry would be noticed.

## Acceptance

- A finished recording plays as MPEG-2 with no FFmpeg process started.
- The scrubber shows the recording's real duration, and seeking to any point
  works — including near the end of a 3½-hour recording.
- Nothing is written to `/tmp/tablo_raw` for a VOD session.
- Falls back to the transcode when the browser cannot decode, or on any error.
- `Keep` still produces an H.264 offline copy.
