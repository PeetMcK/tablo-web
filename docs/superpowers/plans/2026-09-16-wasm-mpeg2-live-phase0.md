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

(pending)

## Task 3 — browser probes

(pending)
