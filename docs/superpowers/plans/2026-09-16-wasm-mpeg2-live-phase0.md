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

### Device playlist depth — not yet run

Deferred deliberately. It needs a tuner held open against the live device, and
the ring makes it a sizing curiosity rather than a dependency: retention is
ours, not the device's. `backend/tools/probe_device_window.py` is written and
takes the `proxy_url` from a started session.
