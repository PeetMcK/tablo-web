# Live TV Decodes in the Browser

Live OTA channels play their native MPEG-2 directly, decoded by WASM in a
worker and presented on a canvas. No FFmpeg process, no encoder lead, no
transcode. Recordings are untouched.

## Problem

Every live channel today runs through FFmpeg: `yadif`, `libx264 -preset
ultrafast`, AAC, HLS out (`backend/app/routes/stream.py:389`). The transcode
exists for exactly one reason — no browser's media stack decodes MPEG-2 video —
and it costs:

- **A process per viewer.** Six concurrent windows already run device-bound.
- **~12 seconds before anything plays.** `LIVE_LEAD_SECONDS` in
  `frontend/src/components/VideoPlayer.tsx:53` is two 6s segments, because
  hls.js will not start on one. That is dead air on every channel change.
- **A generational loss.** 8.7 Mbps MPEG-2 re-encoded to a 2000k H.264 ceiling
  by the fastest preset x264 has.

None of it buys anything durable. Live is watched once, never cached, never
exported. The transcode is pure translation, and translation is the part a WASM
decoder can do in the browser instead.

Recordings keep the current pipeline unchanged. The window cache, instant
seeking, offline copies and MP4 export all need H.264 on disk, and none of those
arguments apply to live.

## What was measured

Probed in the user's own Chrome:

```
MSE  mp2v         video/mp2t   false
MSE  mp4v.61      video/mp4    false
MSE  avc1.42E01E  video/mp2t   true     <- H.264-in-TS, what we do today
TAG  video/mpeg                no
WebCodecs  mp2v / mp2v.61 / mp4v.61 / mpeg2video / mp4v.20.3   all false
```

No native door exists, and no extension can open one — Chromium has no API for
adding codecs to its media stack. WASM is the only path.

A live 1080i sample pulled off the device decodes cheaply. Single-threaded,
native, on the M1 Max, over a 9.46s / 280-frame clip:

| | CPU-s | vs realtime | % of one core |
|---|---|---|---|
| decode only | 0.37 | 25.6x | 3.9% |
| decode + `bwdif` | 0.92 | 10.3x | 9.7% |

Two consequences shrink the project. **No threads are needed**, so no
`SharedArrayBuffer`, so no `COOP`/`COEP` cross-origin isolation, so nothing
disturbs `PUBLIC_BACKEND_ORIGIN` — the direct-to-backend path serving MP4
exports at 583 MB/s rather than 117 through nginx. Every deployment objection to
this idea rested on that requirement, and none of it applies. And **WebGL
deinterlacing is optional**: `bwdif` can live inside the WASM build for v1 and
still clear realtime several times over.

The same sample's audio is the fact the original investigation missed:

```
video  mpeg2video  Main  1920x1080  field_order=tt  29.97fps
audio  ac3         5.1   48 kHz     384 kbps
```

OTA audio is **AC-3 5.1**, not AAC. Chrome decodes AC-3 only on some platforms,
so audio is not free either — it is a second decoder in the same WASM build.

## Non-goals

- **Recordings.** Unchanged, forever, for the reasons above.
- **OTT channels.** Already H.264; they keep the raw `<video>` path.
- **Mobile and Safari.** Desktop Chrome/Edge is the supported target for this
  path. Everything else takes the transcode fallback automatically, which is
  exactly what it does today.
- **Multichannel audio out.** 5.1 is downmixed to stereo.
- **Replacing the transcode.** It stays, permanently, as the fallback.

## Phase 0: the gate

The WASM penalty is assumed, not measured, and every line below it is worthless
if the assumption is wrong. Nothing downstream begins until these numbers exist.

1. **Build** libav.js with `decoder-mpeg2video`, `decoder-ac3`, and the `bwdif`
   filter. The artifact and its LGPL `sources/` are vendored under
   `frontend/public/wasm/libav/`, pinned by version, and served as static
   assets — not fetched from a CDN at runtime, so playback never depends on a
   third party being up. Record the artifact size. If `bwdif` cannot be built
   into libav.js,
   the design falls back to a bob deinterlace in the presenter and `bwdif`
   becomes a v2 item — it does not block.
2. **Decode** the saved 1080i sample in a worker, end to end, and count frames
   per second of wall clock.
   - **Kill criterion: under 1.5x realtime for decode + deinterlace stops the
     project.** Native is 10.3x; a 3x WASM penalty lands at 3.4x. Under 1.5x
     there is no headroom for presentation, audio, and a browser doing anything
     else, and the transcode wins on merit.
3. **Probe** Chrome's AC-3 support in MSE and WebCodecs. Informational only —
   the design decodes AC-3 in WASM regardless, so that one code path runs
   everywhere. The number decides whether that was necessary.
4. **Probe** the depth of the Tablo's own raw playlist, to size the segment
   ring. Not while the user is watching: probing competes for device bandwidth
   and corrupts the measurement.

Phase 0 output is a written result in the plan's progress notes, including the
measured multiple. If it passes, implementation proceeds. If it fails, this spec
is closed and the transcode stands.

## Architecture

```
Tablo --HLS / MPEG-2 TS--> backend: proxy + raw segment ring (disk) --> browser
  worker   libav.js: demux -> mpeg2 decode -> bwdif send_field -> I420 @ 60p
                     ac3 decode -> downmix 2.0 -> PCM
  main     AudioWorklet (clock master) + OffscreenCanvas presenter
```

The browser cannot talk to the Tablo directly. Device requests need HMAC-MD5
signing — the keys are in the app, that part is fine — but the device sends no
CORS headers, so a proxy stays in the path regardless of what decodes the bytes.

### The raw transport already exists

`POST /api/stream/{identifier}?transcode=false` already returns
`/api/hls/{session}/playlist.m3u8`, which proxies the device's own HLS and
rewrites its manifest (`backend/app/routes/stream.py:186`). hls.js fetches and
demuxes that stream today; it only fails on the video track. The transport is
not a rebuild, it is an existing route the new path reuses.

### Backend: the raw segment ring

What does not survive removing FFmpeg is the DVR window. Today's hour of rewind
is FFmpeg's own `-hls_list_size LIVE_DVR_SEGMENTS`
(`backend/app/routes/stream.py:428`), and the device's own window is a different,
unmeasured depth. Full parity needs a window we own.

A new `backend/app/live_ring.py` holds one follower task per raw session. It
polls the device playlist, fetches each new segment exactly once, writes it to
`RAW_DIR/{session}/%05d.ts`, trims the directory to `LIVE_DVR_SECONDS` worth,
and regenerates a sliding `playlist.m3u8` with a correct
`#EXT-X-MEDIA-SEQUENCE`. A new `/api/raw/{session}/...` route serves both from
disk.

This is byte copying: no encode, no FFmpeg, and one device fetch per session
regardless of how many requests the browser makes — an improvement on the
current proxy, which re-fetches the device for every segment request. At 8.7
Mbps a one-hour window is roughly 3.9 GB per active channel, against a 250 GB
budget that the recording cache already lives inside. The retention logic is the
same shape as `backend/app/transcode_cache.py`; it reuses what is there rather
than inventing a second disk lifecycle.

`start_stream` grows a `mode` parameter: `transcode` (today's path), `raw`
(today's direct proxy, kept for OTT), and `ring` (the new one).

### Frontend: `frontend/src/lib/wasmlive/`

Five modules, each independently testable, none knowing about React:

- **`transport.ts`** — polls the ring playlist, fetches segments in order, maps
  a seek target to a sequence number, and hands `ArrayBuffer`s onward. Pure
  logic plus `fetch`; the sequence arithmetic is unit-testable without a
  network.
- **`decode.worker.ts`** — owns the libav.js instance. Segment bytes go into a
  reader device, and a filter graph (`bwdif=mode=send_field`) emits I420 frames
  at 60p plus stereo PCM. Frames and PCM leave as transferables.
- **`audioSink.ts`** — AudioWorklet with a ring buffer, and the authority on
  time: `clockSeconds` is what the rest of the pipeline synchronises against.
- **`presenter.ts`** — an OffscreenCanvas and a bounded frame queue. Each frame
  becomes a `VideoFrame` constructed directly from its I420 planes, which the
  browser colour-converts on the GPU; there is no pixel loop in JavaScript and
  the main thread never touches frame data. On each tick it presents the newest
  frame whose PTS is at or before the audio clock, drops what is late, and holds
  what is early.
- **`session.ts`** — assembles the four into something with a lifecycle.

Frames are `close()`d on presentation and the queue is capped at 8. An
unbounded queue of 1080p frames exhausts GPU memory in seconds.

### The seam in VideoPlayer

`VideoPlayer.tsx` is 1331 lines that reach into `videoRef.current` for
`currentTime`, `seekable`, `play`, `pause` and media events from a dozen places.
Two playback implementations cannot both live behind that.

A `PlaybackSurface` interface — `play`, `pause`, `seek`, `currentTime`,
`seekable`, and an event subscription — gets two implementations: `HlsSurface`,
wrapping today's `<video>` and `usePlayer`, and `WasmSurface`, wrapping
`session.ts`. `VideoPlayer` talks only to the surface. The programme bar, the
scrubber, the DVR window, the anchor — all of it is arithmetic over
`currentTime` and `seekable` and none of it needs to change.

This refactor is the price of admission, and it is also how live playback stops
being understood in exactly one 1331-line file.

### Fallback

The WASM path is attempted when all of the following hold: the channel is not
OTT, the browser is Chrome-family desktop, `VideoFrame`, `OffscreenCanvas`,
`AudioWorklet` and WASM are all present, and the feature flag is on.

The flag is a `localStorage` key read when the player opens, alongside the
existing debug switches in `frontend/src/lib/debug.ts`. It defaults off until
Phase 0 passes and the manual soak is clean, and it flips to default-on in a
single commit that can be reverted by itself.

It falls back to the transcode when any of these happen: worker or WASM
initialisation fails, no first frame is presented within 5 seconds, the decoder
reports an error, or frame starvation exceeds 1 second twice inside 30 seconds.

Falling back opens a transcode session at the wall-clock instant currently being
watched, swaps the surface underneath the same UI, and logs the transition
through the existing `log.player` channel. The viewer sees a rebuffer, not a
crash, and the fallback is one-way for the life of the session — a path that
flapped between decoders would be worse than either.

### Edges

- **Discontinuity or resolution change mid-stream.** The filter graph is torn
  down and rebuilt on a format change; the presenter resizes its canvas.
- **Hidden tab.** Audio continues, video frames are dropped rather than queued.
  The clock is audio, so nothing drifts while hidden.
- **Pause and rewind.** Pause stops presenting and stops consuming the ring.
  Rewind re-requests from the segment covering the target and decodes forward
  from its first GOP header — MPEG-2 GOPs run about half a second, against the
  60-second windows the recording cache seeks in.
- **Channel change.** Session torn down, worker terminated, ring follower
  stopped server-side by the existing `stop_stream`.

## Testing

- **Decode, hermetically.** A committed ~2s 1080i fixture is decoded in node
  under vitest: frame count, dimensions, monotonic PTS, and a stable first-frame
  checksum. This is the test that fails if a libav.js upgrade changes the build.
- **Pure units.** Frame queue drop/hold policy, audio clock arithmetic,
  transport sequence mapping, and the fallback state machine — all without a
  browser, a device, or WASM.
- **Backend.** Ring rotation, retention trimming, playlist generation and
  media-sequence continuity, in the existing pytest style.
- **Surface parity.** The `PlaybackSurface` contract is exercised against both
  implementations, so the bar and scrubber are proven against the new path
  without a live device.
- **Manual soak, last.** A 30-minute watch, a tab switch, a rewind to the edge
  of the window, and a channel change.

## Rejected

- **A JS MPEG-TS demuxer, or hls.js's.** libav.js's own demuxer handles PAT,
  PMT, PES, timestamps and discontinuities in the same graph as the decoder, for
  no extra code. hls.js's `TSDemuxer` is private API that breaks on upgrade, and
  writing a new one is ~400 lines re-solving a solved problem.
- **ffmpeg.wasm.** CLI-shaped — write a file, run a command, read a file — about
  31 MB, and it wants `SharedArrayBuffer`, which is the one requirement this
  design is free of.
- **Kagami/ffmpeg.js.** Dead since 2020, pinned to Emscripten *fastcomp*, a
  toolchain that no longer exists.
- **jsmpeg.** MPEG-1 only. It is the first result everyone finds and it cannot
  work.
- **A WebGL YUV shader in v1.** The `VideoFrame` path gets GPU colour conversion
  for free. The shader is the same seam and remains the v2 move if the CPU spent
  on `bwdif` is ever wanted back.
- **Moving deinterlace to WebGL in the *existing* pipeline.** It would save the
  largest CPU item but buys no throughput — the Tablo saturates around 10x
  realtime aggregate and six concurrent windows already run device-bound. It
  also worsens compression, since combing is high-frequency detail, and it would
  cost the `<video>` element outright: `bwdif=mode=send_field` emitting 60p is
  what makes 1080i playback correct today.

## LGPL

libav.js is FFmpeg's libavcodec under LGPL. Distributing a build obliges
shipping the corresponding sources, which the build emits into `sources/` and
which ship alongside the artifact. libav.js's own wrapper layer is 0-clause BSD.
