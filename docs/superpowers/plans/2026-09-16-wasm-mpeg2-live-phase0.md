# Phase 0 results

## Task 1 — build

- libav.js version: 6.10.9 (ffmpeg 9.0)
- variant: `tablo-mpeg2`
- toolchain: `emscripten/emsdk:latest` in Docker. Emscripten is **not** installed
  on this host and was deliberately not installed; the build script runs the
  container instead. This is a deviation from the plan's native-`emcc` script.
- fragments: `avformat, avcodec, avfcbridge, avfilter, swresample, swscale,
  demuxer-mpegts, parser-mpegvideo, decoder-mpeg2video, parser-ac3, decoder-ac3,
  filter-bwdif, filter-format, filter-aformat, filter-aresample, audio-filters,
  video-filters`
- **bwdif included: yes.** `--enable-filter=bwdif` is in the generated
  `ffmpeg-config.txt` and the string `bwdif` is present in the built wasm. The
  bob-deinterlace contingency is not needed.
- Also confirmed present in the binary: `mpeg2video`, `mpegts`, `aresample`.
  `ac3` appears as `--enable-decoder=ac3` in the configure flags.
- Only the loader, the wasm target and the types were built. The asm.js and
  threaded targets cost most of the build time and nothing in this design uses
  them.
- Build time: about 3 minutes on the M1 Max, far below the 30-60 the plan
  budgeted.

Artifact sizes:

```
    26740  libav-6.10.9.0-tablo-mpeg2.js        (loader)
   321635  libav-6.10.9.0-tablo-mpeg2.wasm.js   (glue)
  2044824  libav-6.10.9.0-tablo-mpeg2.wasm.wasm (the decoder)
   225477  libav.types.d.ts
```

2.4 MB of runtime artifact, against the ~31 MB ffmpeg.wasm was rejected for.

LGPL sources vendored under `sources/` (16 MB): `ffmpeg-9.0.tar.xz` and
`libav.js.tar.xz`, both exactly as shipped in the npm package the build used.

## Task 2 — decode throughput

Measured with `frontend/tools/measure-decode.mjs` against the saved 9.41s 1080i
sample (NBC 13.1, 1920x1080 tt, 29.97, AC-3 5.1), node 20, single-threaded, M1
Max. Media duration is taken from packet timestamps in the input stream's
timebase — frame timestamps are unusable here because `bwdif=send_field` halves
the output timebase, which made the first run read 2x too fast.

`-Oz` build (libav.js default):

| | wall | vs realtime |
|---|---|---|
| decode + AC-3, no deinterlace, frames copied out | 1.13s | **8.35x** |
| decode + AC-3, no deinterlace, frames left in wasm | 1.15s | 8.20x |
| decode + AC-3 + `bwdif=send_field` | 11.65s | **0.81x** |

`-O3` build (this is the one now committed):

| | wall | vs realtime |
|---|---|---|
| decode + AC-3, no deinterlace | 1.07s | **8.81x** |
| video decode alone, no audio, no copy | 1.14s | 8.22x |
| decode + AC-3 + `bwdif=mode=send_frame` (30p out) | 6.52s | 1.44x |
| decode + AC-3 + `bwdif=mode=send_field` (60p out) | 11.54s | **0.82x** |
| decode + AC-3 + `yadif=mode=send_field` | 18.91s | 0.50x |

### What the numbers say

**Decode passes, easily.** 8.8x realtime against 25.6x native is a 2.9x WASM
penalty — the middle of the 2-3x the investigation assumed. AC-3 decode is
free at this scale: dropping it changed nothing measurable. Copying frames out
of the wasm heap is also free (0.02s across 560 frames), so the `VideoFrame`
path costs nothing.

**Software deinterlacing fails, by a mile.** `bwdif` costs 10.5s of the 11.5s.
Native `bwdif` over the same clip is 0.55 CPU-s, so the penalty on the filter
alone is roughly 19x, against 2.9x for the decoder. The reason is
straightforward: `bwdif` and `yadif` are hand-written AVX2 in native FFmpeg,
and this build has no SIMD at all — libav.js dropped its SIMD variant because
its constituent libraries do not use WebAssembly SIMD.

Neither lever recovers it:

- **`-O3` instead of `-Oz`** bought 5% on decode and nothing on `bwdif`
  (0.81 → 0.82x). The artifact grew 2.04 → 2.54 MB. Kept anyway, for the decode
  gain and the headroom it buys.
- **`yadif` instead of `bwdif`** is *worse*, at 0.50x.
- **`bwdif=send_frame`** (30p out rather than 60p) reaches 1.44x — still under
  the 1.5x gate, with no headroom left for presentation, and it throws away the
  60p field cadence that makes 1080i playback look right today.

### Verdict

The gate as written — decode plus deinterlace ≥ 1.5x — **fails at 0.82x**.
The gate on decode alone **passes at 8.8x**.

The spec listed WebGL deinterlacing as optional, a v2 move to reclaim CPU. This
measurement makes it mandatory: deinterlacing has to happen on the GPU, where
it is nearly free, and the WASM build does decode only. Decode at 8.8x leaves
ample budget for that.

## Task 3 — browser probes

Run in the user's own Chrome (M1 Max, ANGLE Metal), via
`frontend/public/wasm-probe.html`.

**Chrome decodes no AC-3 at all:**

```
no  MSE audio/mp4; codecs="ac-3"
no  MSE audio/mp4; codecs="ec-3"
no  MSE video/mp2t; codecs="ac-3"
no  WebCodecs ac-3
no  WebCodecs ec-3
```

So the WASM AC-3 decoder is not insurance, it is required. The design would
have needed it even if the browser-AC-3 shortcut had been taken, and the "use
the browser's AC-3 where present" option considered during design would have
had no platform to run on.

This also settles an old comment in `VideoPlayer.tsx:376` — "hls.js demuxes the
container but the video track is unrenderable, leaving audio only". Audio could
only have survived on a channel whose audio was already AAC, i.e. an OTT one.
On a real OTA broadcast the raw path yields neither picture nor sound.

**Everything the pipeline needs is present:**

```
yes OffscreenCanvas, AudioWorkletNode, WebAssembly, WebGL2RenderingContext, Worker
yes webgl2 context obtainable — ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max)
yes R8 textures (the Y/U/V planes)
    max texture size 16384, against the 1920 needed
```

**The built decoder loads in the browser** in 416ms, in `direct` mode (the probe
passes `noworker: true`, as the real worker will).

### The video path, verified in Chrome

Before any device was involved, the whole video path was run in the browser
against the committed fixture — decode in the worker, planes uploaded as `R8`
textures, both fields drawn through the deinterlace shader — from
`frontend/probe.html` (`vite dev`, not part of the production build).

It works: 25 frames decoded, 1920x1080, `interlaced=true tff=true`, 6 fields
presented, a correct picture on the canvas with correct colour.

It also found three bugs that no unit test could have, all in production code:

1. **The worker handled messages concurrently.** Every segment posted while the
   2.5 MB of wasm was still instantiating arrived before the decoder existed
   and was dropped — a decoder that opened successfully and then decoded
   nothing at all. Messages are now handled one at a time, in order.
2. **The decoder returned output from `push()` rather than emitting it.** Frames
   only reached the page when the *next* segment arrived: six seconds of added
   latency per frame on this device, and nothing at all at the end of a stream.
   Output is now pushed through a callback as it is decoded.
3. **avformat's default probe reads 5 MB, or waits for EOF.** On a live feed
   that is seconds of black before the first frame — against the ~12s encoder
   lead this project exists to remove. Bounded to 512 KB and half a second.

The first two are exactly the class of bug the test suite cannot reach: both
are about *when* things happen across a worker boundary, and both were invisible
to every test that passed.

## Live soak against the real device (Task 17, partial)

Run against the actual Tablo with the worktree's backend on `:8000` and the
built frontend served by `vite preview`. **It plays**: real 1080i broadcast,
decoded in WASM, deinterlaced by the shader, in sync with its own audio,
sustained across tens of seconds — and the fallback to the transcode works
cleanly when the WASM path gives up.

It is **not yet reliable from a cold start**, and the flag stays default-off.

### What the soak found that the test suite could not

1. **The device serves byte-range HLS behind a master playlist.** Every EXTINF
   names the same `segw.ts` and differs only in `#EXT-X-BYTERANGE`. The
   follower understood neither, so the ring stayed empty for ever. FFmpeg and
   hls.js both resolve this on their own, which is precisely why nothing in
   this codebase had ever had to know.
2. **Audio and video disagreed by 39 seconds.** `buffersink` re-bases what it
   emits onto the filter graph's timeline rather than the stream's, so the
   downmixed audio carried timestamps unrelated to the frames beside it. Audio
   is now timed from the decoder's own pts plus samples emitted.
3. **The playhead and the seekable window were in different timebases** —
   decoded pts against seconds-since-session-open — and only looked plausible
   because the two origins happened to be close.
4. **Nothing paced the transport.** Decode runs at 8x realtime, so it ate the
   ring's whole backlog and the field queue filled with video the clock would
   not reach for a minute; everything evicted before its moment. Pacing now
   measures media fed against media played.
5. **The obvious pacing fix deadlocks.** The playhead only advances while audio
   renders, audio only exists if the transport fetched it, and the transport
   only fetches if the playhead moved. A buffer floor breaks the cycle.

Plus: a field queue capped at 8 threw away nine tenths of every segment;
concurrent polls fetched every segment twice; a player closed mid-open leaked a
tuner; and the first-frame deadline counted from the open rather than from the
first segment fed, so a cold ring failed before there was anything to decode.

### Where it stands

On a channel whose ring has been filling for a while, the WASM path plays and
keeps playing. On a freshly opened channel the decoder sometimes produces
nothing at all from the first few seconds of media and the session falls back.

## Chasing the cold-channel failure on the bench

The standing theory was the demuxer probe: that a cold ring's opening segments
are where PAT and PMT have to be found and avformat gave up first. The probe
limits had been loosened once on that theory (512KB → 2MB, 0.5s → 2s) without
ever being tested.

**The theory is wrong, and the test that killed it needs no device.** The
committed fixture is one second of this device's output, cut from the middle of
a broadcast — which is exactly what tuning into a live channel looks like. Fed
in 64KB chunks with **no end of stream**, which is the condition live playback
actually runs under and which the existing decode test never exercised because
it calls `flush()`:

| fed | frames out |
|---|---|
| 1,056,936 bytes (~1s), no EOF | 25 video, 29 audio |
| three of those, a second apart | 87 video, growing each round |

So avformat names both streams on well under a megabyte, with nothing to help
it along. `PROBE_BYTES` is a ceiling that is never reached, and the loosening
was unnecessary — harmless, but it was never the problem.

Two more suspects went the same way. Every decoded frame and audio chunk owns
its own `ArrayBuffer` — no aliasing, no view into a shared buffer — so the
transfer lists cannot throw; and running the worker handler with a real
`structuredClone(message, { transfer })` in place of `postMessage` posts video
and audio without error.

### What was actually wrong: three silences

The decoder had three ways to produce nothing and say nothing, and from the
page they were indistinguishable from each other and from a decoder that was
merely slow. All three are now loud.

1. **A stream with no video in it.** `open()` only built a decoder `if
   (videoStream)`. With no video PID — a tuner that has not locked yet — it
   built none, then read packets for ever and emitted nothing. No error, no
   frames, no audio: exactly the reported symptom. It now throws, naming the
   byte count and whether audio was found. Pinned by a fixture: the same second
   of broadcast with the video PID stripped out.
2. **An open that never completes.** The reader device blocks until it is given
   data, so a feed too thin to demux leaves `ff_init_demuxer_file` outstanding
   indefinitely. Now raced against a deadline that reports how many bytes were
   fed and how many the demuxer took.
3. **A worker that never loads.** A module worker whose script or wasm asset
   fails reports through `onerror`, which nothing was listening to. The session
   sat in the same silence until its deadline. Now an immediate, named failover.

Beside them, `stats()` — bytes fed, bytes delivered, whether it opened, what it
opened on, which streams it found, frames and chunks emitted — rides to the
page with every segment, so `tabloDebug()` distinguishes never-fed from
never-opened from opened-but-wrong-stream from merely-behind.

### Removing the cold start rather than surviving it

MPEG-TS has no header. It describes itself periodically, so opening a live
stream means listening until the tables come round — and a browser handed a
ring holding one segment gets a trickle, a segment per poll interval. That is
the only condition this path has ever failed to start under.

`POST /api/stream?mode=ring` now fills the ring before it answers:
`RingFollower.prime()` polls until the ring holds `RING_PRIME_SECONDS` (8) or
`RING_PRIME_TIMEOUT_SECONDS` (15) elapses, and only then starts the background
poller. Every channel therefore opens under the conditions a warm one already
works under. The wait is not new — the transcode path already waits up to
twelve seconds for its first playlist segment, behind the same spinner — and a
device that will not fill still yields a session, because the client falls back
on its own.

A session stopped while priming does not start its poller: a player closed
mid-open would otherwise hold a tuner for the life of the process.

Ring directories orphaned by a crash are swept at startup, but only if nothing
has written to them for a minute. A live follower writes every couple of
seconds, so the sweep cannot take the ring out from under a second backend
sharing the directory — which is not hypothetical, since running one beside the
user's own is the documented way to test this path, and the transcode cleanup
beside it kills the other one's FFmpeg for exactly the want of that check.

**Next step:** a device run to confirm it, with the counters now available to
say what happened if it does not. Until that passes, `tablo.wasmlive` stays off
by default and every viewer gets the transcode exactly as before.

## The device run, and what it took

It played, and then it stuttered for four hours. Everything below was found by
measuring; not one of these was visible by reading the code, and several
contradicted a confident diagnosis made minutes earlier.

Field presentations reaching the screen, in order of fix:

| | fields/s |
|---|---|
| first live run of the production build | 3 |
| queue evicting from the far end instead of the front | 8 |
| audio clock interpolated between worklet reports | 23 |
| starvation widening the lookahead instead of removing it | 41 |
| polling faster than the lookahead drains | 47 |
| drawing the oldest due field instead of the newest | 55 |
| joining the device at its live edge | 56 |
| not decoding into a full queue, and sizing the queue for a burst | **59.9** |

Against 59.94 offered. Thirty seconds sustained, nothing below 50.

### The production build had never worked

Bundled into the worker chunk, the libav runtime loaded and then wedged: it
answered nothing, never fetched its own wasm, and blocked its thread so
completely that a timer set beside it never fired. No error, no frames, no way
to tell from the page. Dev worked throughout, because Vite serves those modules
separately there — so every previous session's "cold channel produces nothing"
was this, and the cold/warm distinction was never real.

Bisected by loading the built worker by hand and posting it an `open`: booted,
then silence, in both module and classic form, minified and unminified. Loading
the runtime from a URL instead of a bundled import fixes it, and shrinks the
worker chunk from 231KB to 31KB.

### The device is a DVR, and its playlist is the recording

Its media playlist carried **2336 segments** — close to an hour. The follower
took all of it, so the ring ingested history as fast as it could be fetched:
70 seconds of media for every 20 seconds of wall clock, 3.5x realtime. The
ring's live edge ran away from the viewer at two and a half seconds per second,
and playback that began ten seconds back was, two minutes later, 284 seconds
behind the broadcast — while appearing from inside the player to be following
live and merely stuttering. It also meant priming exhausted its fifteen second
timeout on every session; taking only the newest twelve seconds, it completes
in 3.8s.

Nothing was duplicated. Every segment was distinct and the timestamps ran
continuously — checked by cksum and by ffprobe across segment boundaries. It
was simply the past, arriving quickly.

### The queue cap was destroying content, not limiting it

Pacing the fetch does not pace the decoder: decode runs at about a thousand
frames a second here, thirty-five times realtime, so a segment becomes fifty or
sixty frames in fifty milliseconds. Those land together on a queue draining one
field at a time, it reaches its cap, and the excess is refused — and a refused
field is a hole in the timeline, not a short queue. At 100ms resolution:
presentation falling to zero for 300ms with 104 fields queued, every one in the
future, the oldest 0.286s ahead, while the clock crossed the gap.

The transport now declines to hand over a segment the queue cannot take, and
the cap holds a whole burst above the working buffer. Both bounds were measured
against the device: less than a burst's room overflows anyway, too much starves
the sound.

### Smaller, and each one worth the measurement

- **The field queue evicted from the front** — the next field due — to make
  room for one a second and a half away.
- **The audio clock advanced in 100ms steps**, because the worklet reports every
  4800 frames. Video presented against it could be drawn ten times a second
  however many fields were ready: 60 animation frames, a clock that moved on
  twelve of them.
- **An empty buffer bypassed pacing outright**, and at startup the buffer is
  empty by definition, so the first poll swallowed the whole primed window.
- **Polling ran at 1.5s against a 1.25s lookahead** — a quarter second short
  every cycle, for ever. They are a pair now, with a test saying so.
- **Presentation skipped to the newest due field on every tick**, discarding
  about one field in five as ordinary 60Hz-against-59.94 jitter.
- **Playback started 25s inside the DVR window**, so live TV behaved like a
  recording and every fresh session replayed the same content.
- **`fallBack` leaked the ring session**: a tuner held and an hour of 1080i
  accumulating per fallback. Found mid-soak with three leaked sessions holding
  1.5GB and the device refusing to open another.
- **No device request had a timeout**, so a busy tuner held a session open past
  its own deadline — a deadline that could not fire, being tested only between
  polls rather than bounding them.

### What made the difference

Logging, almost entirely. The `booted` message separated "the worker never ran"
from "the worker hung"; the decoder's counters separated never-fed from
never-opened from opened-on-the-wrong-stream; `fedAhead` beside `buffered`
showed two numbers measuring the same quantity disagreeing by five seconds; and
sampling the seekable window against the wall clock produced the 3.5x that
unravelled the largest bug of the night. Three separate confident diagnoses
were wrong until a number contradicted them.

### Device playlist depth — not yet run

Deferred deliberately. It needs a tuner held open against the live device, and
the ring makes it a sizing curiosity rather than a dependency: retention is
ours, not the device's. `backend/tools/probe_device_window.py` is written and
takes the `proxy_url` from a started session.
