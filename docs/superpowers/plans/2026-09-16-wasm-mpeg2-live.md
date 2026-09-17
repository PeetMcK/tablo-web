# WASM MPEG-2 Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live OTA channels play their native MPEG-2 in the browser — libav.js decoding in a worker, canvas presentation, audio clock as master — with the existing FFmpeg transcode kept as an automatic fallback.

**Architecture:** The backend gains a raw segment ring that copies device segments to disk and serves its own sliding playlist, replacing the DVR window FFmpeg used to provide. The frontend gains `lib/wasmlive/`: a transport that fetches ring segments, a worker that runs libav.js (demux → MPEG-2 decode → interlaced I420; AC-3 decode → stereo PCM), an AudioWorklet that owns the clock, and a WebGL2 presenter that deinterlaces and colour-converts in one shader pass, drawing each frame twice — once per field — for 60p out. `VideoPlayer` talks to a `PlaybackSurface` interface with two implementations, so the programme bar and scrubber are unchanged.

**Tech Stack:** Python 3.14, FastAPI, httpx, pytest. React 19, TypeScript, vitest, hls.js 1.6, libav.js 6.10.9 (custom variant), WebGL2, OffscreenCanvas, AudioWorklet.

**Spec:** `docs/superpowers/specs/2026-09-16-wasm-mpeg2-live-design.md`

## Global Constraints

- **Phase 0 has run, and it changed the design.** Tasks 1 and 2 are complete; results are in `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md`. Decode clears the gate at **8.81x realtime**. Software deinterlacing fails it at **0.82x**, so **no video filter runs in WASM**: the worker decodes to interlaced I420 and the presenter deinterlaces on the GPU. Tasks 7, 11 and 13 are written against that outcome.
- **No CPU-side per-pixel work anywhere in the pipeline.** That headroom is what the measurement bought, and spending it is the one way this design loses to the transcode it replaces.
- **Recordings are untouched.** No task modifies `transcode_cache.py`, the recording routes, or the recording branches of `VideoPlayer`.
- **The transcode path stays.** Nothing deletes `start_transcoder`, `/api/transcoded/...`, or the `transcode=true` branch. The new path is additive.
- **Feature flag default off.** `localStorage` key `tablo.wasmlive` gates the new path until the final task flips it in a commit of its own.
- **Target is desktop Chrome/Edge.** Anything else takes the existing transcode path; no task adds Safari or iOS workarounds.
- **Backend tests:** `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest` run from the worktree's `backend/`. The worktree has no venv of its own; the main checkout's interpreter is used deliberately.
- **Frontend tests:** `npm test` (vitest) from the worktree's `frontend/`.
- **`main` already fails ruff with pre-existing errors.** Lint only files you touch.
- **Never probe the Tablo while the user is watching.** Device bandwidth is shared; a probe during viewing corrupts both the measurement and the viewing.
- **Exact names, verbatim:** the media type stays `video/mp2t`; the session flag is `mode` with values `transcode`, `raw`, `ring`; the libav variant is named `tablo-mpeg2`.
- **libav.js version is pinned at 6.10.9.** The wrapper module is the only file allowed to import it.

---

## File Structure

**Backend**

| File | Responsibility |
|---|---|
| `app/live_ring.py` (create) | Ring state: segment list, retention trim, playlist text generation |
| `app/live_follower.py` (create) | The polling task: device playlist → new segments → disk → ring |
| `app/routes/stream.py` (modify) | `mode` parameter on `start_stream`; `/api/raw/{session}/...` serving |
| `tests/test_live_ring.py` (create) | Ring arithmetic, retention, playlist text |
| `tests/test_live_follower.py` (create) | Polling loop against a fake device, no network |
| `tests/test_stream_security.py` (modify) | `/api/raw` auth, traversal, unknown session |

**Frontend**

| File | Responsibility |
|---|---|
| `src/lib/wasmlive/types.ts` (create) | `DecodedVideoFrame`, `DecodedAudioChunk`, shared shapes |
| `src/lib/wasmlive/playlist.ts` (create) | Parse a media playlist; map media seconds ↔ segment |
| `src/lib/wasmlive/frameQueue.ts` (create) | Which frame to present, what to drop, what to hold |
| `src/lib/wasmlive/audioClock.ts` (create) | Media time from samples played |
| `src/lib/wasmlive/fallback.ts` (create) | The state machine that gives up on WASM |
| `src/lib/wasmlive/capability.ts` (create) | Is this browser eligible, is the flag on |
| `src/lib/wasmlive/libavClient.ts` (create) | The only file that imports libav.js |
| `src/lib/wasmlive/decode.worker.ts` (create) | Worker message protocol around `libavClient` |
| `src/lib/wasmlive/presenter.ts` (create) | Field scheduling and the WebGL2 draw |
| `src/lib/wasmlive/deinterlace.ts` (create) | The shader pair and its GL plumbing |
| `src/lib/wasmlive/audioSink.ts` (create) | AudioWorklet feeding and sample accounting |
| `src/lib/wasmlive/pcmWorklet.js` (create) | The AudioWorkletProcessor itself |
| `src/lib/wasmlive/session.ts` (create) | Lifecycle gluing transport, worker, sink, presenter |
| `src/lib/playbackSurface.ts` (create) | `PlaybackSurface` interface + `HlsSurface` |
| `src/lib/wasmlive/wasmSurface.ts` (create) | `PlaybackSurface` over `session.ts` |
| `src/components/VideoPlayer.tsx` (modify) | Talks to a surface instead of `videoRef.current` |
| `src/api/tablo.ts` (modify) | `startStream` gains `mode`, response gains `started_at` |
| `public/wasm/libav/` (create) | The built variant + its LGPL sources |
| `tools/build-libav.sh` (create) | Reproducible build of the `tablo-mpeg2` variant |

---

## Phase 0 — The gate

### Task 1: Build the `tablo-mpeg2` libav.js variant — ✅ COMPLETE

**Done in commits `ebf6476` and `20a9405`.** Built in the `emscripten/emsdk`
container rather than from a host toolchain (no emsdk installed here, Docker is
available), with `-O3` instead of libav.js's default `-Oz`, and with `yadif`
added alongside `bwdif` so the deinterlacers could be compared. Artifacts and
LGPL sources are committed under `frontend/public/wasm/libav/`; the ESM (`.mjs`)
targets are built too, because `frontend/package.json` is `type: module` and
node parses the CommonJS loader as ESM otherwise. The steps below are the
record of what was run.

No prebuilt libav.js variant contains MPEG-2 video, AC-3, and the MPEG-TS demuxer together — checked against `configs/mkconfigs.js` in libav.js 6.10.9. A custom variant is required.

**Files:**
- Create: `tools/build-libav.sh`
- Create: `frontend/public/wasm/libav/` (build output, committed)
- Create: `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md` (results log)

**Interfaces:**
- Consumes: nothing
- Produces: `frontend/public/wasm/libav/libav-6.10.9.0-tablo-mpeg2.js` and its `.wasm.js` / `.wasm.wasm` siblings; `frontend/public/wasm/libav/sources/` holding the LGPL source tarballs shipped by the npm package.

- [ ] **Step 1: Write the build script**

```bash
#!/usr/bin/env bash
# Builds the tablo-mpeg2 variant of libav.js: MPEG-2 video + AC-3 audio out of
# MPEG-TS, deinterlaced with bwdif. No prebuilt variant carries this set.
#
# Requires emsdk on PATH (emcc --version). The ffmpeg compile is long; 30-60
# minutes on an M1 is normal.
set -euo pipefail

VERSION=6.10.9
VARIANT=tablo-mpeg2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/libav-build"
OUT="$ROOT/frontend/public/wasm/libav"

command -v emcc >/dev/null || { echo "emcc not on PATH; source emsdk_env.sh" >&2; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"
npm pack "libav.js@$VERSION"
tar xzf "libav.js-$VERSION.tgz"
tar xJf package/sources/libav.js.tar.xz
cp package/sources/*.tar.* .  # ffmpeg + deps, as shipped

cd configs
# Fragment names map directly onto ffmpeg configure flags. swscale is needed for
# any useful video handling; filter-format lets the graph pin yuv420p output.
./mkconfig.js "$VARIANT" '["avformat", "avcodec", "avfcbridge", "avfilter",
 "swresample", "swscale",
 "demuxer-mpegts", "parser-mpegvideo", "decoder-mpeg2video",
 "parser-ac3", "decoder-ac3",
 "filter-bwdif", "filter-format", "filter-aformat", "filter-aresample",
 "audio-filters", "video-filters"]'
cd ..

make "build-$VARIANT" -j"$(sysctl -n hw.ncpu)"

mkdir -p "$OUT/sources"
cp dist/libav-"$VERSION".0-"$VARIANT"* "$OUT/"
cp package/sources/ffmpeg-*.tar.xz package/sources/libav.js.tar.xz "$OUT/sources/"
ls -l "$OUT"
```

- [ ] **Step 2: Run it**

Run: `bash tools/build-libav.sh`
Expected: `frontend/public/wasm/libav/` contains `libav-6.10.9.0-tablo-mpeg2.js`, `...wasm.js`, `...wasm.wasm`.

If `filter-bwdif` is rejected by ffmpeg's configure, drop it from the fragment list, rebuild, and record that in the results log — the presenter then does a bob deinterlace and `bwdif` becomes a later task. Do not block on it.

- [ ] **Step 3: Record what was built**

Create `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md`:

```markdown
# Phase 0 results

## Task 1 — build
- libav.js version: 6.10.9
- variant: tablo-mpeg2
- fragments: <the list actually used>
- bwdif included: yes | no (reason)
- artifact sizes: <ls -l output for the .js and .wasm>

## Task 2 — decode throughput
(pending)

## Task 3 — browser probes
(pending)
```

- [ ] **Step 4: Commit**

```bash
git add tools/build-libav.sh frontend/public/wasm/libav docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md
git commit -m "build: libav.js variant with MPEG-2, AC-3 and bwdif"
```

---

### Task 2: Measure decode throughput — the kill gate — ✅ COMPLETE, DESIGN CHANGED

**Done in commit `20a9405`.** Decode + AC-3 runs at **8.81x realtime**, passing.
Adding `bwdif=send_field` drops it to **0.82x**, failing: the filter costs 10.5
of the 11.5 seconds, a ~19x WASM penalty against 2.9x for the decoder, because
native `bwdif` is hand-written AVX2 and this build has no SIMD. `-O3` did not
move it, `yadif` is worse (0.50x), and `send_frame` reaches only 1.44x by
halving the frame rate.

**Consequence: the deinterlace moves to the GPU and no video filter runs in
WASM.** Tasks 11 and 13 below are rewritten for that. Full numbers, including
the false start where `bwdif`'s halved output timebase made the first
measurement read 2x too fast, are in the phase 0 results file.

The steps below are the record of what was run.

**Files:**
- Create: `frontend/tools/measure-decode.mjs`
- Modify: `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md`

**Interfaces:**
- Consumes: the built variant from Task 1.
- Produces: a recorded multiple-of-realtime figure. Every later task depends on it being ≥ 1.5.

- [ ] **Step 1: Write the measurement script**

The sample is `/private/tmp/claude-502/-Users-peet-GitHub-tablo-web/be7b1098-aded-449a-8346-7df2e179aeff/scratchpad/raw_1080i.ts` (9.46s, 280 frames, 1080i29.97, AC-3 5.1). If it is gone, re-pull with `pull_seg2.py` in that directory — not while the user is watching.

```js
// frontend/tools/measure-decode.mjs
// Decodes the saved 1080i sample end to end and prints the multiple of
// realtime. This is the number the whole project is gated on.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import * as LibAV from "../public/wasm/libav/libav-6.10.9.0-tablo-mpeg2.js";

const path = process.argv[2];
const bytes = new Uint8Array(readFileSync(path));
const CHUNK = 64 * 1024;

const libav = await LibAV.LibAV({ noworker: true });
await libav.mkreaderdev("stream.ts");

let sent = 0;
libav.onread = () => {
  const end = Math.min(sent + CHUNK, bytes.length);
  libav.ff_reader_dev_send("stream.ts", sent >= bytes.length ? null : bytes.subarray(sent, end));
  sent = end;
};

const t0 = performance.now();
const [fmtCtx, streams] = await libav.ff_init_demuxer_file("stream.ts");
const video = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO);
const audio = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO);

const [, vctx, vpkt, vframe] = await libav.ff_init_decoder(video.codec_id, {
  codecpar: video.codecpar, time_base: [video.time_base_num, video.time_base_den],
});
const [, actx, apkt, aframe] = await libav.ff_init_decoder(audio.codec_id, {
  codecpar: audio.codecpar, time_base: [audio.time_base_num, audio.time_base_den],
});

const [, vsrc, vsink] = await libav.ff_init_filter_graph(
  "bwdif=mode=send_field:parity=tff,format=pix_fmts=yuv420p",
  { type: libav.AVMEDIA_TYPE_VIDEO, width: 1920, height: 1080,
    pix_fmt: libav.AV_PIX_FMT_YUV420P, time_base: [video.time_base_num, video.time_base_den] },
  { type: libav.AVMEDIA_TYPE_VIDEO, pix_fmt: libav.AV_PIX_FMT_YUV420P },
);

let frames = 0, samples = 0;
for (;;) {
  const [res, packets] = await libav.ff_read_frame_multi(fmtCtx, vpkt, { limit: 256 * 1024 });
  const vp = packets[video.index] ?? [];
  const ap = packets[audio.index] ?? [];
  if (vp.length) {
    const out = await libav.ff_decode_filter_multi(vctx, vsrc, vsink, vpkt, vframe, vp,
      { copyoutFrame: "video_packed" });
    frames += out.length;
  }
  if (ap.length) {
    const out = await libav.ff_decode_multi(actx, apkt, aframe, ap);
    for (const f of out) samples += f.data.length / (f.channels ?? 1);
  }
  if (res === libav.AVERROR_EOF) break;
  if (res !== 0 && res !== -libav.EAGAIN) throw new Error(`read failed: ${res}`);
}
const ms = performance.now() - t0;

const clipSeconds = frames / 59.94;  // send_field doubles the 29.97 field rate
console.log(JSON.stringify({
  frames, audioSeconds: +(samples / 48000).toFixed(2),
  wallSeconds: +(ms / 1000).toFixed(2),
  clipSeconds: +clipSeconds.toFixed(2),
  realtimeMultiple: +(clipSeconds / (ms / 1000)).toFixed(2),
}, null, 2));
```

- [ ] **Step 2: Run it**

Run:
```bash
cd frontend && node tools/measure-decode.mjs \
  /private/tmp/claude-502/-Users-peet-GitHub-tablo-web/be7b1098-aded-449a-8346-7df2e179aeff/scratchpad/raw_1080i.ts
```
Expected: JSON with `frames` around 560 (280 frames doubled by `send_field`) and a `realtimeMultiple`. Native is 10.3x; 3-8x is the expected landing zone.

- [ ] **Step 3: Apply the gate**

**If `realtimeMultiple` < 1.5: stop.** Record the number, report it, and go no further — the transcode wins on merit and the spec is closed. Do not start Task 3.

If it is ≥ 1.5, record it and continue.

- [ ] **Step 4: Also measure without the filter**

Comment out the filter graph (decode only, `copyoutFrame: "video_packed"` straight from `ff_decode_multi`) and re-run, so the deinterlace cost is known separately. Record both numbers. This is what decides whether a WebGL shader is ever worth building.

- [ ] **Step 5: Commit**

```bash
git add frontend/tools/measure-decode.mjs docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md
git commit -m "test: measure WASM MPEG-2 decode throughput against the live sample"
```

---

### Task 3: Browser probes — AC-3 support and the device window

**Files:**
- Create: `frontend/public/wasm-probe.html`
- Create: `backend/tools/probe_device_window.py`
- Modify: `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md`

**Interfaces:**
- Consumes: the built variant from Task 1.
- Produces: two recorded facts — whether Chrome decodes AC-3 natively (informational), and how many seconds deep the Tablo's own playlist is (sizes the ring).

- [ ] **Step 1: Write the browser probe page**

```html
<!-- frontend/public/wasm-probe.html -->
<!doctype html>
<meta charset="utf-8">
<title>WASM live probe</title>
<pre id="out">running…</pre>
<script type="module">
const lines = [];
const say = (s) => { lines.push(s); document.getElementById("out").textContent = lines.join("\n"); };

// Does this browser decode AC-3 without us? Informational only: the pipeline
// decodes AC-3 in WASM regardless, so one code path runs everywhere.
for (const type of ['audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ec-3"', 'video/mp2t; codecs="ac-3"']) {
  say(`MSE ${type} -> ${MediaSource.isTypeSupported(type)}`);
}
if (window.AudioDecoder) {
  for (const codec of ["ac-3", "ec-3"]) {
    const { supported } = await AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 6 });
    say(`WebCodecs ${codec} -> ${supported}`);
  }
} else say("WebCodecs AudioDecoder: absent");

for (const api of ["VideoFrame", "OffscreenCanvas", "AudioWorkletNode", "WebAssembly"]) {
  say(`${api} -> ${api in window}`);
}
</script>
```

- [ ] **Step 2: Run the probe**

Serve it (the app's own dev server is fine — see the `tablo-stack` skill for bringing the stack up) and open `/wasm-probe.html` in Chrome. Record every line in the results log.

- [ ] **Step 3: Write the device window probe**

```python
# backend/tools/probe_device_window.py
"""How deep is the Tablo's own live playlist? Sizes the ring.

Run only when nobody is watching: this competes for device bandwidth.
"""
import asyncio, re, sys

import httpx


async def main(playlist_url: str) -> None:
    async with httpx.AsyncClient(timeout=20) as http:
        body = (await http.get(playlist_url)).text
    durations = [float(m) for m in re.findall(r"#EXTINF:([0-9.]+)", body)]
    seq = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", body)
    print(f"segments={len(durations)} "
          f"depth={sum(durations):.1f}s "
          f"target={max(durations, default=0):.1f}s "
          f"media_sequence={seq.group(1) if seq else 'absent'}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
```

- [ ] **Step 4: Run it**

Start a raw session (`POST /api/stream/{identifier}` with `transcode=false`), take `proxy_url`, and run the probe against it. Record segment count, total depth and target duration.

- [ ] **Step 5: Commit**

```bash
git add frontend/public/wasm-probe.html backend/tools/probe_device_window.py docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md
git commit -m "test: probe browser AC-3 support and the device playlist depth"
```

---

## Phase 1 — Backend: the raw segment ring

### Task 4: Ring state and playlist generation

**Files:**
- Create: `backend/app/live_ring.py`
- Test: `backend/tests/test_live_ring.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class RingSegment(NamedTuple): sequence: int; name: str; duration: float; started_at: datetime`
  - `class SegmentRing` with `append(name: str, duration: float, started_at: datetime) -> RingSegment`, `trim(max_seconds: float) -> list[RingSegment]` (returns evicted), `playlist() -> str`, `window() -> tuple[float, float]` (media seconds relative to `origin`), and attributes `origin: datetime`, `segments: list[RingSegment]`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_live_ring.py
"""The raw DVR ring: what it holds, what it evicts, what it publishes."""

from datetime import datetime, timedelta, timezone

from app.live_ring import SegmentRing

T0 = datetime(2026, 9, 16, 20, 0, 0, tzinfo=timezone.utc)


def _ring(count: int, duration: float = 6.0) -> SegmentRing:
    ring = SegmentRing(origin=T0)
    for i in range(count):
        ring.append(f"{i:05d}.ts", duration, T0 + timedelta(seconds=i * duration))
    return ring


def test_sequences_increase_from_zero():
    ring = _ring(3)
    assert [s.sequence for s in ring.segments] == [0, 1, 2]


def test_trim_evicts_oldest_beyond_the_window():
    ring = _ring(10)  # 60s held
    evicted = ring.trim(max_seconds=30)
    assert [s.name for s in evicted] == ["00000.ts", "00001.ts", "00002.ts", "00003.ts", "00004.ts"]
    assert [s.sequence for s in ring.segments] == [5, 6, 7, 8, 9]


def test_trim_keeps_everything_inside_the_window():
    ring = _ring(3)
    assert ring.trim(max_seconds=3600) == []
    assert len(ring.segments) == 3


def test_playlist_is_a_live_sliding_window():
    ring = _ring(10)
    ring.trim(max_seconds=30)
    text = ring.playlist()
    assert "#EXTM3U" in text
    assert "#EXT-X-VERSION:3" in text
    # The sequence of the first segment still held, not a count of evictions.
    assert "#EXT-X-MEDIA-SEQUENCE:5" in text
    assert "#EXT-X-TARGETDURATION:6" in text
    # Live: no ENDLIST, or the player stops chasing the edge.
    assert "#EXT-X-ENDLIST" not in text
    assert text.count("#EXTINF:") == 5
    assert "00005.ts" in text and "00004.ts" not in text


def test_playlist_dates_the_first_segment_it_still_holds():
    """The browser derives media time from this, so it must move with the window."""
    ring = _ring(10)
    ring.trim(max_seconds=30)
    assert "#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:30+00:00" in ring.playlist()


def test_window_is_media_seconds_from_the_origin():
    ring = _ring(10)
    ring.trim(max_seconds=30)
    assert ring.window() == (30.0, 60.0)


def test_empty_ring_publishes_an_empty_playlist():
    ring = SegmentRing(origin=T0)
    assert ring.window() == (0.0, 0.0)
    assert "#EXTINF:" not in ring.playlist()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest tests/test_live_ring.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.live_ring'`

- [ ] **Step 3: Write the implementation**

```python
# backend/app/live_ring.py
"""The raw DVR window.

Removing the live transcode removes the DVR window with it: today's hour of
rewind is FFmpeg's own ``-hls_list_size``. This holds the same window by
copying the device's segments instead of re-encoding them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import NamedTuple


class RingSegment(NamedTuple):
    sequence: int
    name: str
    duration: float
    started_at: datetime


@dataclass
class SegmentRing:
    """An ordered window of segments on disk, published as a live playlist."""

    origin: datetime
    segments: list[RingSegment] = field(default_factory=list)
    _next_sequence: int = 0

    def append(self, name: str, duration: float, started_at: datetime) -> RingSegment:
        segment = RingSegment(self._next_sequence, name, duration, started_at)
        self._next_sequence += 1
        self.segments.append(segment)
        return segment

    def trim(self, max_seconds: float) -> list[RingSegment]:
        """Drop oldest segments until the window fits, returning what was dropped."""
        evicted: list[RingSegment] = []
        held = sum(s.duration for s in self.segments)
        while self.segments and held > max_seconds:
            evicted.append(self.segments.pop(0))
            held -= evicted[-1].duration
        return evicted

    def window(self) -> tuple[float, float]:
        """The held window in media seconds since ``origin``."""
        if not self.segments:
            return (0.0, 0.0)
        start = (self.segments[0].started_at - self.origin).total_seconds()
        return (start, start + sum(s.duration for s in self.segments))

    def playlist(self) -> str:
        target = max((s.duration for s in self.segments), default=6.0)
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{math.ceil(target)}",
            f"#EXT-X-MEDIA-SEQUENCE:{self.segments[0].sequence if self.segments else 0}",
        ]
        for index, segment in enumerate(self.segments):
            if index == 0:
                # The browser ties media time to this. It has to move with the
                # window, so it is written against whatever is now first.
                lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{segment.started_at.isoformat()}")
            lines.append(f"#EXTINF:{segment.duration:.3f},")
            lines.append(segment.name)
        return "\n".join(lines) + "\n"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest tests/test_live_ring.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add backend/app/live_ring.py backend/tests/test_live_ring.py
git commit -m "feat: raw DVR segment ring with a sliding live playlist"
```

---

### Task 5: The follower — device playlist to disk

**Files:**
- Create: `backend/app/live_follower.py`
- Test: `backend/tests/test_live_follower.py`

**Interfaces:**
- Consumes: `SegmentRing`, `RingSegment` from Task 4.
- Produces:
  - `def parse_device_playlist(text: str) -> tuple[int, list[tuple[str, float]]]` — returns `(media_sequence, [(uri, duration)])`
  - `class RingFollower` with `__init__(self, ring: SegmentRing, directory: Path, playlist_url: str, fetch: Fetch, max_seconds: float, now: Clock = ...)`, `async def poll_once(self) -> int` (returns the number of new segments written), and `async def run(self) -> None`.
  - `Fetch = Callable[[str], Awaitable[bytes]]`, `Clock = Callable[[], datetime]`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_live_follower.py
"""The follower pulls each device segment exactly once and keeps the ring honest."""

from datetime import datetime, timedelta, timezone

import pytest

from app.live_follower import RingFollower, parse_device_playlist
from app.live_ring import SegmentRing

T0 = datetime(2026, 9, 16, 20, 0, 0, tzinfo=timezone.utc)

PLAYLIST_A = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:6.000,
seg100.ts
#EXTINF:6.000,
seg101.ts
"""

# The device advanced by one: 100 fell off, 102 arrived.
PLAYLIST_B = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:101
#EXTINF:6.000,
seg101.ts
#EXTINF:6.000,
seg102.ts
"""


def test_parse_device_playlist():
    sequence, segments = parse_device_playlist(PLAYLIST_A)
    assert sequence == 100
    assert segments == [("seg100.ts", 6.0), ("seg101.ts", 6.0)]


def test_parse_playlist_without_media_sequence_starts_at_zero():
    sequence, segments = parse_device_playlist("#EXTM3U\n#EXTINF:6.0,\na.ts\n")
    assert sequence == 0
    assert segments == [("a.ts", 6.0)]


class FakeDevice:
    """Serves playlists in order and counts every byte request."""

    def __init__(self, playlists):
        self.playlists = list(playlists)
        self.requested: list[str] = []

    async def fetch(self, url: str) -> bytes:
        self.requested.append(url)
        if url.endswith(".m3u8"):
            return self.playlists.pop(0).encode() if self.playlists else b""
        return b"TS" + url.encode()


def _follower(tmp_path, device, max_seconds=3600.0):
    clock = {"t": T0}

    def now():
        value = clock["t"]
        clock["t"] += timedelta(seconds=6)
        return value

    return RingFollower(
        ring=SegmentRing(origin=T0),
        directory=tmp_path,
        playlist_url="http://device/live/playlist.m3u8",
        fetch=device.fetch,
        max_seconds=max_seconds,
        now=now,
    )


@pytest.mark.asyncio
async def test_first_poll_writes_every_segment(tmp_path):
    device = FakeDevice([PLAYLIST_A])
    follower = _follower(tmp_path, device)

    assert await follower.poll_once() == 2
    assert [s.name for s in follower.ring.segments] == ["00000.ts", "00001.ts"]
    assert (tmp_path / "00000.ts").read_bytes().startswith(b"TS")


@pytest.mark.asyncio
async def test_second_poll_fetches_only_what_is_new(tmp_path):
    device = FakeDevice([PLAYLIST_A, PLAYLIST_B])
    follower = _follower(tmp_path, device)

    await follower.poll_once()
    assert await follower.poll_once() == 1

    # seg101 was already held; it must not be fetched twice.
    assert sum(1 for u in device.requested if u.endswith("seg101.ts")) == 1
    assert [s.name for s in follower.ring.segments] == ["00000.ts", "00001.ts", "00002.ts"]


@pytest.mark.asyncio
async def test_retention_deletes_evicted_files(tmp_path):
    device = FakeDevice([PLAYLIST_A, PLAYLIST_B])
    follower = _follower(tmp_path, device, max_seconds=12.0)

    await follower.poll_once()
    await follower.poll_once()

    assert not (tmp_path / "00000.ts").exists()
    assert (tmp_path / "00002.ts").exists()
    assert [s.name for s in follower.ring.segments] == ["00001.ts", "00002.ts"]


@pytest.mark.asyncio
async def test_relative_segment_uris_resolve_against_the_playlist(tmp_path):
    device = FakeDevice([PLAYLIST_A])
    follower = _follower(tmp_path, device)

    await follower.poll_once()

    assert "http://device/live/seg100.ts" in device.requested


@pytest.mark.asyncio
async def test_an_empty_playlist_is_not_an_error(tmp_path):
    device = FakeDevice(["#EXTM3U\n"])
    follower = _follower(tmp_path, device)

    assert await follower.poll_once() == 0
    assert follower.ring.segments == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest tests/test_live_follower.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.live_follower'`

If `pytest.mark.asyncio` is unavailable, check `backend/tests/conftest.py` for the project's async convention and follow it rather than adding a dependency.

- [ ] **Step 3: Write the implementation**

```python
# backend/app/live_follower.py
"""Follows a device playlist and keeps a ring of its segments on disk.

One follower per session. The device is fetched once per segment no matter how
many viewers or requests there are — an improvement on the pass-through proxy,
which re-fetches the device for every segment request.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urljoin

from .live_ring import SegmentRing

Fetch = Callable[[str], Awaitable[bytes]]
Clock = Callable[[], datetime]

_MEDIA_SEQUENCE = re.compile(r"#EXT-X-MEDIA-SEQUENCE:(\d+)")
_EXTINF = re.compile(r"#EXTINF:([0-9.]+)")


def parse_device_playlist(text: str) -> tuple[int, list[tuple[str, float]]]:
    """Return ``(media_sequence, [(uri, duration)])`` from a media playlist."""
    match = _MEDIA_SEQUENCE.search(text)
    sequence = int(match.group(1)) if match else 0

    segments: list[tuple[str, float]] = []
    duration: float | None = None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if extinf := _EXTINF.match(line):
            duration = float(extinf.group(1))
        elif not line.startswith("#") and duration is not None:
            segments.append((line, duration))
            duration = None
    return sequence, segments


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RingFollower:
    def __init__(
        self,
        ring: SegmentRing,
        directory: Path,
        playlist_url: str,
        fetch: Fetch,
        max_seconds: float,
        now: Clock = _utcnow,
        interval: float = 2.0,
    ) -> None:
        self.ring = ring
        self.directory = Path(directory)
        self.playlist_url = playlist_url
        self.fetch = fetch
        self.max_seconds = max_seconds
        self.now = now
        self.interval = interval
        self.directory.mkdir(parents=True, exist_ok=True)
        # The device's own sequence of the next segment we have not taken yet.
        self._taken_through: int | None = None

    async def poll_once(self) -> int:
        body = await self.fetch(self.playlist_url)
        device_sequence, segments = parse_device_playlist(body.decode("utf-8", errors="ignore"))

        written = 0
        for offset, (uri, duration) in enumerate(segments):
            sequence = device_sequence + offset
            if self._taken_through is not None and sequence <= self._taken_through:
                continue
            payload = await self.fetch(urljoin(self.playlist_url, uri))
            name = f"{len(self.ring.segments) + len(self._evicted_names):05d}.ts" \
                if False else f"{self.ring._next_sequence:05d}.ts"
            (self.directory / name).write_bytes(payload)
            self.ring.append(name, duration, self.now())
            self._taken_through = sequence
            written += 1

        for evicted in self.ring.trim(self.max_seconds):
            (self.directory / evicted.name).unlink(missing_ok=True)
        return written

    async def run(self) -> None:
        while True:
            try:
                await self.poll_once()
            except Exception:  # a transient device hiccup must not end the session
                pass
            await asyncio.sleep(self.interval)
```

Note: the `name` line above is deliberately ugly in draft form — replace it with the single clean expression `name = f"{self.ring._next_sequence:05d}.ts"` and delete the dead branch. Ring sequence numbering is the ring's business; if `_next_sequence` reads as too private, add a `next_name()` method to `SegmentRing` and use that.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest tests/test_live_follower.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add backend/app/live_follower.py backend/tests/test_live_follower.py
git commit -m "feat: follow the device playlist into the raw segment ring"
```

---

### Task 6: Serve the ring

**Files:**
- Modify: `backend/app/routes/stream.py` (the `start_stream` handler at :120, and a new route block after the HLS proxy at :186)
- Test: `backend/tests/test_stream_security.py`
- Test: `backend/tests/test_live_ring_routes.py` (create)

**Interfaces:**
- Consumes: `SegmentRing` (Task 4), `RingFollower` (Task 5).
- Produces:
  - `POST /api/stream/{identifier}?mode=ring` → `{session_id, stream_url: "/api/raw/{session}/playlist.m3u8", proxy_url, mode: "ring", started_at: "<iso>", transcoded: false}`
  - `GET /api/raw/{session_id}/playlist.m3u8` → the ring playlist, `application/vnd.apple.mpegurl`, `Cache-Control: no-cache`
  - `GET /api/raw/{session_id}/{name}.ts` → the segment file, `video/mp2t`
  - Module-level `ring_sessions: dict[str, tuple[SegmentRing, RingFollower, asyncio.Task]]`, cleared by `stop_stream`.
  - `mode` is `transcode | raw | ring`; the old boolean `transcode` query parameter keeps working and means `mode=transcode`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_live_ring_routes.py
"""Serving the raw ring: shape, safety, lifecycle."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_raw_requires_a_known_session():
    assert client.get("/api/raw/deadbeef/playlist.m3u8").status_code == 404


def test_raw_rejects_a_non_hex_session():
    resp = client.get("/api/raw/../../../etc/passwd/playlist.m3u8")
    assert resp.status_code in (400, 404, 422)


def test_raw_rejects_traversal_in_the_segment_name():
    valid_hex = "abcdef1234567890abcdef1234567890"
    resp = client.get(f"/api/raw/{valid_hex}/../../etc/passwd")
    assert resp.status_code in (400, 404)


def test_raw_rejects_a_segment_name_that_is_not_a_segment():
    valid_hex = "abcdef1234567890abcdef1234567890"
    resp = client.get(f"/api/raw/{valid_hex}/ffmpeg.log")
    assert resp.status_code in (400, 404)


def test_start_stream_still_requires_auth():
    assert client.post("/api/stream/some-channel-id?mode=ring").status_code == 401
```

Add to `backend/tests/test_stream_security.py`:

```python
def test_raw_ring_unknown_session():
    """Unknown session should 404, not 500."""
    resp = client.get("/api/raw/deadbeef/playlist.m3u8")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest tests/test_live_ring_routes.py -v`
Expected: FAIL — 404 assertions pass by accident only if the route is absent; the traversal and `mode=ring` auth cases fail until the route exists. Read the failures rather than assuming.

- [ ] **Step 3: Write the implementation**

In `backend/app/routes/stream.py`, alongside the existing constants:

```python
import re
from datetime import datetime, timezone

from ..live_follower import RingFollower
from ..live_ring import SegmentRing

RAW_DIR = TRANSCODE_DIR.parent / "raw"
_SESSION_RE = re.compile(r"^[0-9a-f]{8,64}$")
_SEGMENT_RE = re.compile(r"^\d{5}\.ts$")

# session_id -> (ring, follower, task)
ring_sessions: dict[str, tuple[SegmentRing, RingFollower, asyncio.Task]] = {}
```

Replace the body of `start_stream` after `state.start_stream(...)`:

```python
    mode_value = mode or ("transcode" if transcode else "raw")
    started_at = datetime.now(timezone.utc)

    if mode_value == "transcode":
        await start_transcoder(session_id, sess.stream.playlist_url)
        stream_url = f"/api/transcoded/{session_id}/playlist.m3u8"
    elif mode_value == "ring":
        ring = SegmentRing(origin=started_at)
        follower = RingFollower(
            ring=ring,
            directory=RAW_DIR / session_id,
            playlist_url=sess.stream.playlist_url,
            fetch=_fetch_bytes,
            max_seconds=float(LIVE_DVR_SECONDS),
        )
        ring_sessions[session_id] = (ring, follower, asyncio.create_task(follower.run()))
        stream_url = f"/api/raw/{session_id}/playlist.m3u8"
    else:
        stream_url = f"/api/hls/{session_id}/playlist.m3u8"

    return {
        "session_id": session_id,
        "proxy_url": f"/api/hls/{session_id}/playlist.m3u8",
        "stream_url": stream_url,
        "mode": mode_value,
        "started_at": started_at.isoformat(),
        "transcoded": mode_value == "transcode",
    }
```

with the signature gaining `mode: str | None = Query(default=None)` and a helper:

```python
async def _fetch_bytes(url: str) -> bytes:
    resp = await state.http.get(url, follow_redirects=True)
    resp.raise_for_status()
    return resp.content
```

`LIVE_DVR_SECONDS` derives from the existing `LIVE_DVR_SEGMENTS * HLS_TIME`; define it next to those constants rather than inventing a second source of truth.

The serving routes:

```python
@router.get("/raw/{session_id}/playlist.m3u8")
async def raw_playlist(session_id: str):
    if not _SESSION_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Bad session id")
    entry = ring_sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Stream session not found")
    ring, _follower, _task = entry
    return Response(
        content=ring.playlist(),
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"},
    )


@router.get("/raw/{session_id}/{name}")
async def raw_segment(session_id: str, name: str):
    if not _SESSION_RE.match(session_id) or not _SEGMENT_RE.match(name):
        raise HTTPException(status_code=400, detail="Bad segment")
    if session_id not in ring_sessions:
        raise HTTPException(status_code=404, detail="Stream session not found")
    path = RAW_DIR / session_id / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Segment not found")
    return FileResponse(
        path,
        media_type="video/mp2t",
        headers={"Cache-Control": "max-age=30", "Access-Control-Allow-Origin": "*"},
    )
```

And in `stop_stream`, before `state.stop_session(session_id)`:

```python
    if entry := ring_sessions.pop(session_id, None):
        _ring, _follower, task = entry
        task.cancel()
    session_raw = RAW_DIR / session_id
    if session_raw.exists():
        shutil.rmtree(session_raw, ignore_errors=True)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest tests/test_live_ring_routes.py tests/test_stream_security.py -v`
Expected: all passed

Then the full backend suite: `/Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest -q` — 184 existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/stream.py backend/tests/test_live_ring_routes.py backend/tests/test_stream_security.py
git commit -m "feat: serve the raw segment ring as a live playlist"
```

---

## Phase 2 — Frontend: the pure parts

### Task 7: Shared types and playlist arithmetic

**Files:**
- Create: `frontend/src/lib/wasmlive/types.ts`
- Create: `frontend/src/lib/wasmlive/playlist.ts`
- Test: `frontend/src/__tests__/wasmlivePlaylist.test.ts`

**Interfaces:**
- Consumes: the ring playlist format from Task 4 (`#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-PROGRAM-DATE-TIME` on the first segment).
- Produces:
  ```ts
  export interface DecodedVideoFrame {
    data: Uint8Array; width: number; height: number; ptsSeconds: number;
    /** Seconds until the next frame, so the second field can be timed. */
    durationSeconds: number;
    /** False for progressive content — commercials, some subchannels. */
    interlaced: boolean;
    /** Which field is first in time. Meaningless when not interlaced. */
    topFieldFirst: boolean;
  }
  export interface DecodedAudioChunk { samples: Float32Array; sampleRate: number; ptsSeconds: number }
  export interface MediaPlaylist {
    targetDuration: number; mediaSequence: number; programDateTimeMs: number | null;
    segments: { uri: string; duration: number }[];
  }
  export function parseMediaPlaylist(text: string): MediaPlaylist
  export function playlistWindow(pl: MediaPlaylist, originMs: number): { start: number; end: number }
  export function segmentAt(pl: MediaPlaylist, originMs: number, mediaSeconds: number):
    { index: number; startSeconds: number } | null
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/__tests__/wasmlivePlaylist.test.ts
import { describe, it, expect } from "vitest";

import { parseMediaPlaylist, playlistWindow, segmentAt } from "../lib/wasmlive/playlist";

// Session began at 20:00:00; the window now starts 30s in.
const ORIGIN = Date.parse("2026-09-16T20:00:00Z");

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:30+00:00
#EXTINF:6.000,
00005.ts
#EXTINF:6.000,
00006.ts
#EXTINF:5.500,
00007.ts
`;

describe("parseMediaPlaylist", () => {
  it("reads the sequence, target and segments", () => {
    const pl = parseMediaPlaylist(PLAYLIST);
    expect(pl.mediaSequence).toBe(5);
    expect(pl.targetDuration).toBe(6);
    expect(pl.segments).toEqual([
      { uri: "00005.ts", duration: 6 },
      { uri: "00006.ts", duration: 6 },
      { uri: "00007.ts", duration: 5.5 },
    ]);
  });

  it("reads the date of the first segment it holds", () => {
    expect(parseMediaPlaylist(PLAYLIST).programDateTimeMs).toBe(Date.parse("2026-09-16T20:00:30Z"));
  });

  it("survives a playlist with nothing in it", () => {
    const pl = parseMediaPlaylist("#EXTM3U\n");
    expect(pl.segments).toEqual([]);
    expect(pl.programDateTimeMs).toBeNull();
  });
});

describe("playlistWindow", () => {
  it("is media seconds since the session began", () => {
    expect(playlistWindow(parseMediaPlaylist(PLAYLIST), ORIGIN)).toEqual({ start: 30, end: 47.5 });
  });

  it("is empty when the playlist is", () => {
    expect(playlistWindow(parseMediaPlaylist("#EXTM3U\n"), ORIGIN)).toEqual({ start: 0, end: 0 });
  });
});

describe("segmentAt", () => {
  const pl = parseMediaPlaylist(PLAYLIST);

  it("finds the segment covering a media instant", () => {
    expect(segmentAt(pl, ORIGIN, 30)).toEqual({ index: 0, startSeconds: 30 });
    expect(segmentAt(pl, ORIGIN, 37)).toEqual({ index: 1, startSeconds: 36 });
    expect(segmentAt(pl, ORIGIN, 47)).toEqual({ index: 2, startSeconds: 42 });
  });

  it("clamps a target before the window to its first segment", () => {
    // The viewer rewound past what the ring still holds: give them the oldest
    // thing that exists rather than nothing.
    expect(segmentAt(pl, ORIGIN, 5)).toEqual({ index: 0, startSeconds: 30 });
  });

  it("has nothing for a target past the live edge", () => {
    expect(segmentAt(pl, ORIGIN, 90)).toBeNull();
  });

  it("has nothing when the playlist is empty", () => {
    expect(segmentAt(parseMediaPlaylist("#EXTM3U\n"), ORIGIN, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/wasmlivePlaylist.test.ts`
Expected: FAIL — cannot resolve `../lib/wasmlive/playlist`

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/wasmlive/types.ts
/**
 * One decoded picture, planar I420, packed to the minimum stride.
 *
 * Still interlaced: the deinterlace happens on the GPU, so the frame carries
 * what the shader needs to know about its fields rather than having been
 * resolved into progressive lines already.
 */
export interface DecodedVideoFrame {
  data: Uint8Array;
  width: number;
  height: number;
  ptsSeconds: number;
  /** Seconds until the next frame, so the second field can be timed. */
  durationSeconds: number;
  /** False for progressive content, which must pass through untouched. */
  interlaced: boolean;
  /** Which field is first in time. Meaningless when not interlaced. */
  topFieldFirst: boolean;
}

/** Decoded audio, interleaved stereo float. */
export interface DecodedAudioChunk {
  samples: Float32Array;
  sampleRate: number;
  ptsSeconds: number;
}
```

```ts
// frontend/src/lib/wasmlive/playlist.ts
/**
 * The ring's playlist, read as media time.
 *
 * Media time is seconds since the session began, which is what the player's
 * bar and scrubber are already drawn in. The ring dates its first held segment
 * with EXT-X-PROGRAM-DATE-TIME, so the offset survives the window sliding.
 */

export interface MediaPlaylist {
  targetDuration: number;
  mediaSequence: number;
  programDateTimeMs: number | null;
  segments: { uri: string; duration: number }[];
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const segments: { uri: string; duration: number }[] = [];
  let targetDuration = 6;
  let mediaSequence = 0;
  let programDateTimeMs: number | null = null;
  let duration: number | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || targetDuration;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const parsed = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      if (Number.isFinite(parsed) && programDateTimeMs === null) programDateTimeMs = parsed;
    } else if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice("#EXTINF:".length));
    } else if (!line.startsWith("#") && duration !== null) {
      segments.push({ uri: line, duration });
      duration = null;
    }
  }

  return { targetDuration, mediaSequence, programDateTimeMs, segments };
}

export function playlistWindow(pl: MediaPlaylist, originMs: number): { start: number; end: number } {
  if (!pl.segments.length || pl.programDateTimeMs === null) return { start: 0, end: 0 };
  const start = (pl.programDateTimeMs - originMs) / 1000;
  const held = pl.segments.reduce((sum, s) => sum + s.duration, 0);
  return { start, end: start + held };
}

export function segmentAt(
  pl: MediaPlaylist,
  originMs: number,
  mediaSeconds: number,
): { index: number; startSeconds: number } | null {
  const { start, end } = playlistWindow(pl, originMs);
  if (!pl.segments.length) return null;
  if (mediaSeconds >= end) return null;
  // Rewinding past the window lands on the oldest thing that still exists.
  if (mediaSeconds < start) return { index: 0, startSeconds: start };

  let at = start;
  for (let index = 0; index < pl.segments.length; index++) {
    const next = at + pl.segments[index].duration;
    if (mediaSeconds < next) return { index, startSeconds: at };
    at = next;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/wasmlivePlaylist.test.ts`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/types.ts frontend/src/lib/wasmlive/playlist.ts frontend/src/__tests__/wasmlivePlaylist.test.ts
git commit -m "feat: read the ring playlist as media time"
```

---

### Task 8: Frame queue and audio clock

**Files:**
- Create: `frontend/src/lib/wasmlive/frameQueue.ts`
- Create: `frontend/src/lib/wasmlive/audioClock.ts`
- Test: `frontend/src/__tests__/wasmliveTiming.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface Timed { ptsSeconds: number }
  export interface Selection<T> { present: T | null; drop: T[]; keep: T[] }
  export function selectFrame<T extends Timed>(queue: T[], clockSeconds: number, maxLatenessSeconds?: number): Selection<T>
  export const MAX_QUEUED_FRAMES = 8
  export function admit<T extends Timed>(queue: T[], frame: T, cap?: number): { queue: T[]; dropped: T[] }

  export interface AudioClockState { firstPtsSeconds: number | null; samplesPlayed: number; sampleRate: number }
  export function audioClockSeconds(state: AudioClockState): number | null
  export function starvationSeconds(state: AudioClockState, newestFramePts: number | null): number
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/__tests__/wasmliveTiming.test.ts
import { describe, it, expect } from "vitest";

import { admit, selectFrame, MAX_QUEUED_FRAMES } from "../lib/wasmlive/frameQueue";
import { audioClockSeconds, starvationSeconds } from "../lib/wasmlive/audioClock";

const f = (ptsSeconds: number) => ({ ptsSeconds });

describe("selectFrame", () => {
  it("presents the newest frame that is due", () => {
    const queue = [f(1.0), f(1.017), f(1.033), f(1.05)];
    const { present, drop, keep } = selectFrame(queue, 1.034);
    expect(present).toEqual(f(1.033));
    // Everything older than what we showed is spent.
    expect(drop).toEqual([f(1.0), f(1.017)]);
    expect(keep).toEqual([f(1.05)]);
  });

  it("holds when the whole queue is still in the future", () => {
    const queue = [f(2.0), f(2.017)];
    const { present, drop, keep } = selectFrame(queue, 1.5);
    expect(present).toBeNull();
    expect(drop).toEqual([]);
    expect(keep).toEqual(queue);
  });

  it("drops frames that are hopelessly late rather than showing them", () => {
    // A tab that was hidden comes back with a queue from a second ago.
    const queue = [f(1.0), f(1.017), f(5.0)];
    const { present, drop } = selectFrame(queue, 5.0, 0.25);
    expect(present).toEqual(f(5.0));
    expect(drop).toEqual([f(1.0), f(1.017)]);
  });

  it("has nothing to say about an empty queue", () => {
    expect(selectFrame([], 1)).toEqual({ present: null, drop: [], keep: [] });
  });
});

describe("admit", () => {
  it("appends while there is room", () => {
    const { queue, dropped } = admit([f(1)], f(2));
    expect(queue).toEqual([f(1), f(2)]);
    expect(dropped).toEqual([]);
  });

  it("evicts the oldest at the cap, so 1080p frames cannot pile up", () => {
    const full = Array.from({ length: MAX_QUEUED_FRAMES }, (_, i) => f(i));
    const { queue, dropped } = admit(full, f(99));
    expect(queue.length).toBe(MAX_QUEUED_FRAMES);
    expect(dropped).toEqual([f(0)]);
    expect(queue[queue.length - 1]).toEqual(f(99));
  });
});

describe("audioClockSeconds", () => {
  it("is the first pts plus what has been played", () => {
    expect(audioClockSeconds({ firstPtsSeconds: 10, samplesPlayed: 48000, sampleRate: 48000 })).toBe(11);
  });

  it("is unknown before any audio has been played", () => {
    expect(audioClockSeconds({ firstPtsSeconds: null, samplesPlayed: 0, sampleRate: 48000 })).toBeNull();
  });
});

describe("starvationSeconds", () => {
  it("measures how far the clock has outrun the newest decoded frame", () => {
    const state = { firstPtsSeconds: 10, samplesPlayed: 96000, sampleRate: 48000 };  // clock = 12
    expect(starvationSeconds(state, 11.5)).toBeCloseTo(0.5);
  });

  it("is zero while frames are ahead of the clock", () => {
    const state = { firstPtsSeconds: 10, samplesPlayed: 96000, sampleRate: 48000 };
    expect(starvationSeconds(state, 12.5)).toBe(0);
  });

  it("is zero when there is no clock yet", () => {
    expect(starvationSeconds({ firstPtsSeconds: null, samplesPlayed: 0, sampleRate: 48000 }, null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveTiming.test.ts`
Expected: FAIL — cannot resolve the modules

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/wasmlive/frameQueue.ts
/**
 * What to put on screen, and what to throw away.
 *
 * Video is slaved to the audio clock: the presenter shows the newest frame that
 * is due and discards everything it skipped past. An unbounded queue of 1080p
 * frames exhausts GPU memory in seconds, so the queue is capped and admission
 * evicts from the front.
 */

export interface Timed {
  ptsSeconds: number;
}

export interface Selection<T> {
  present: T | null;
  drop: T[];
  keep: T[];
}

/** Frames older than this behind the clock are never worth showing. */
const DEFAULT_MAX_LATENESS = 0.25;

export const MAX_QUEUED_FRAMES = 8;

export function selectFrame<T extends Timed>(
  queue: T[],
  clockSeconds: number,
  maxLatenessSeconds: number = DEFAULT_MAX_LATENESS,
): Selection<T> {
  let presentIndex = -1;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].ptsSeconds <= clockSeconds) presentIndex = i;
    else break;
  }
  if (presentIndex < 0) return { present: null, drop: [], keep: queue.slice() };

  const present = queue[presentIndex];
  const tooLate = clockSeconds - present.ptsSeconds > maxLatenessSeconds;
  return {
    present: tooLate ? present : present,
    drop: queue.slice(0, presentIndex),
    keep: queue.slice(presentIndex + 1),
  };
}

export function admit<T extends Timed>(
  queue: T[],
  frame: T,
  cap: number = MAX_QUEUED_FRAMES,
): { queue: T[]; dropped: T[] } {
  const next = [...queue, frame];
  const dropped: T[] = [];
  while (next.length > cap) dropped.push(next.shift() as T);
  return { queue: next, dropped };
}
```

```ts
// frontend/src/lib/wasmlive/audioClock.ts
/**
 * The clock everything else follows.
 *
 * Wall time and requestAnimationFrame both drift against the media; the number
 * of samples the AudioWorklet has actually played does not. Video is presented
 * against this, so lip sync is a property of the design rather than a thing to
 * correct for.
 */

export interface AudioClockState {
  firstPtsSeconds: number | null;
  samplesPlayed: number;
  sampleRate: number;
}

export function audioClockSeconds(state: AudioClockState): number | null {
  if (state.firstPtsSeconds === null) return null;
  return state.firstPtsSeconds + state.samplesPlayed / state.sampleRate;
}

/** How far the clock has outrun the newest frame the decoder has produced. */
export function starvationSeconds(state: AudioClockState, newestFramePts: number | null): number {
  const clock = audioClockSeconds(state);
  if (clock === null || newestFramePts === null) return 0;
  return Math.max(0, clock - newestFramePts);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveTiming.test.ts`
Expected: 11 passed

Note for the implementer: the `tooLate ? present : present` ternary in `selectFrame` is a placeholder for a decision the test pins down — the newest due frame is presented whether or not it is late, because showing something beats showing nothing. Replace it with `present` and keep `maxLatenessSeconds` only if a later task finds a use for it; if nothing uses it by Task 15, delete the parameter and its test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/frameQueue.ts frontend/src/lib/wasmlive/audioClock.ts frontend/src/__tests__/wasmliveTiming.test.ts
git commit -m "feat: frame selection against the audio clock"
```

---

### Task 9: Capability detection and the fallback machine

**Files:**
- Create: `frontend/src/lib/wasmlive/capability.ts`
- Create: `frontend/src/lib/wasmlive/fallback.ts`
- Test: `frontend/src/__tests__/wasmliveFallback.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const WASMLIVE_FLAG = "tablo.wasmlive";
  export interface Eligibility { eligible: boolean; reason: string }
  export function wasmLiveEligible(win: Pick<Window, "navigator"> & Record<string, unknown>, storage: Pick<Storage, "getItem">, channelKind: string | null | undefined): Eligibility

  export type FallbackEvent =
    | { kind: "first-frame"; atMs: number }
    | { kind: "init-failed" }
    | { kind: "decode-error" }
    | { kind: "starved"; atMs: number }
    | { kind: "tick"; atMs: number };
  export interface FallbackState { startedAtMs: number; sawFirstFrame: boolean; starvations: number[]; failed: string | null }
  export function initialFallbackState(nowMs: number): FallbackState
  export function reduceFallback(state: FallbackState, event: FallbackEvent): FallbackState
  export const FIRST_FRAME_DEADLINE_MS = 5000;
  export const STARVATION_WINDOW_MS = 30000;
  export const STARVATION_LIMIT = 2;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// frontend/src/__tests__/wasmliveFallback.test.ts
import { describe, it, expect } from "vitest";

import { WASMLIVE_FLAG, wasmLiveEligible } from "../lib/wasmlive/capability";
import {
  initialFallbackState, reduceFallback, FIRST_FRAME_DEADLINE_MS,
} from "../lib/wasmlive/fallback";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const capableWindow = (userAgent: string) => ({
  navigator: { userAgent } as Navigator,
  WebGL2RenderingContext: class {},
  OffscreenCanvas: class {},
  AudioWorkletNode: class {},
  WebAssembly: {},
});

const flagOn = { getItem: (k: string) => (k === WASMLIVE_FLAG ? "1" : null) };
const flagOff = { getItem: () => null };

describe("wasmLiveEligible", () => {
  it("accepts a flagged-on Chrome with every API present, on an OTA channel", () => {
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, "ota")).toEqual({ eligible: true, reason: "" });
  });

  it("refuses when the flag is off", () => {
    expect(wasmLiveEligible(capableWindow(CHROME), flagOff, "ota").eligible).toBe(false);
  });

  it("refuses OTT channels, which are already H.264", () => {
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, "ott")).toEqual({
      eligible: false, reason: "ott channel",
    });
  });

  it("refuses Safari, which is not the supported target", () => {
    expect(wasmLiveEligible(capableWindow(SAFARI), flagOn, "ota").eligible).toBe(false);
  });

  it("refuses when an API is missing, naming the one that is", () => {
    const win = capableWindow(CHROME);
    delete (win as Record<string, unknown>).OffscreenCanvas;
    expect(wasmLiveEligible(win, flagOn, "ota")).toEqual({ eligible: false, reason: "no OffscreenCanvas" });
  });

  it("treats a channel of unknown kind as a broadcast", () => {
    // A guide row arriving without a kind is OTA until proven otherwise.
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, undefined).eligible).toBe(true);
  });
});

describe("reduceFallback", () => {
  it("gives up when no frame arrives before the deadline", () => {
    let state = initialFallbackState(0);
    state = reduceFallback(state, { kind: "tick", atMs: FIRST_FRAME_DEADLINE_MS + 1 });
    expect(state.failed).toBe("no first frame");
  });

  it("stops watching the deadline once a frame lands", () => {
    let state = initialFallbackState(0);
    state = reduceFallback(state, { kind: "first-frame", atMs: 1200 });
    state = reduceFallback(state, { kind: "tick", atMs: 60000 });
    expect(state.failed).toBeNull();
  });

  it("tolerates one starvation", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "first-frame", atMs: 500 });
    state = reduceFallback(state, { kind: "starved", atMs: 4000 });
    expect(state.failed).toBeNull();
  });

  it("gives up on a second starvation inside the window", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "first-frame", atMs: 500 });
    state = reduceFallback(state, { kind: "starved", atMs: 4000 });
    state = reduceFallback(state, { kind: "starved", atMs: 20000 });
    expect(state.failed).toBe("repeated starvation");
  });

  it("forgets starvations that have aged out", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "first-frame", atMs: 500 });
    state = reduceFallback(state, { kind: "starved", atMs: 4000 });
    state = reduceFallback(state, { kind: "starved", atMs: 90000 });
    expect(state.failed).toBeNull();
  });

  it("gives up immediately on init failure or a decode error", () => {
    expect(reduceFallback(initialFallbackState(0), { kind: "init-failed" }).failed).toBe("init failed");
    expect(reduceFallback(initialFallbackState(0), { kind: "decode-error" }).failed).toBe("decode error");
  });

  it("stays failed once it has failed", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "decode-error" });
    state = reduceFallback(state, { kind: "first-frame", atMs: 900 });
    expect(state.failed).toBe("decode error");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveFallback.test.ts`
Expected: FAIL — cannot resolve the modules

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/wasmlive/capability.ts
/**
 * Who gets the WASM path.
 *
 * Desktop Chrome/Edge with the flag on, on anything that is not known to be
 * OTT. Everything else takes the transcode, which is what it takes today, so
 * refusing here costs a viewer nothing.
 */

export const WASMLIVE_FLAG = "tablo.wasmlive";

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

// WebGL2 is checked by actually asking for a context in Task 16's wiring; the
// constructor names are what can be checked here.
const REQUIRED = ["OffscreenCanvas", "AudioWorkletNode", "WebAssembly", "WebGL2RenderingContext"] as const;

export function wasmLiveEligible(
  win: Pick<Window, "navigator"> & Record<string, unknown>,
  storage: Pick<Storage, "getItem">,
  channelKind: string | null | undefined,
): Eligibility {
  let flag: string | null = null;
  try {
    flag = storage.getItem(WASMLIVE_FLAG);
  } catch {
    flag = null;  // private mode, blocked site data: treat as off
  }
  if (!flag) return { eligible: false, reason: "flag off" };

  // A guide row without a kind is a broadcast until proven otherwise; that is
  // what the transcode branch already assumes.
  if (channelKind === "ott") return { eligible: false, reason: "ott channel" };

  const ua = win.navigator.userAgent;
  const isChromeFamily = /Chrome\/|Edg\//.test(ua) && !/CriOS|Android/.test(ua);
  if (!isChromeFamily) return { eligible: false, reason: "unsupported browser" };

  for (const api of REQUIRED) {
    if (!(api in win)) return { eligible: false, reason: `no ${api}` };
  }
  return { eligible: true, reason: "" };
}
```

```ts
// frontend/src/lib/wasmlive/fallback.ts
/**
 * When to stop trying and hand the channel back to FFmpeg.
 *
 * One way only. A path that flapped between decoders would be worse than
 * either of them.
 */

export const FIRST_FRAME_DEADLINE_MS = 5000;
export const STARVATION_WINDOW_MS = 30000;
export const STARVATION_LIMIT = 2;

export type FallbackEvent =
  | { kind: "first-frame"; atMs: number }
  | { kind: "init-failed" }
  | { kind: "decode-error" }
  | { kind: "starved"; atMs: number }
  | { kind: "tick"; atMs: number };

export interface FallbackState {
  startedAtMs: number;
  sawFirstFrame: boolean;
  starvations: number[];
  failed: string | null;
}

export function initialFallbackState(nowMs: number): FallbackState {
  return { startedAtMs: nowMs, sawFirstFrame: false, starvations: [], failed: null };
}

export function reduceFallback(state: FallbackState, event: FallbackEvent): FallbackState {
  if (state.failed) return state;

  switch (event.kind) {
    case "init-failed":
      return { ...state, failed: "init failed" };
    case "decode-error":
      return { ...state, failed: "decode error" };
    case "first-frame":
      return { ...state, sawFirstFrame: true };
    case "tick":
      if (!state.sawFirstFrame && event.atMs - state.startedAtMs > FIRST_FRAME_DEADLINE_MS) {
        return { ...state, failed: "no first frame" };
      }
      return state;
    case "starved": {
      const recent = [...state.starvations, event.atMs]
        .filter((at) => event.atMs - at < STARVATION_WINDOW_MS);
      return recent.length >= STARVATION_LIMIT
        ? { ...state, starvations: recent, failed: "repeated starvation" }
        : { ...state, starvations: recent };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveFallback.test.ts`
Expected: 13 passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/capability.ts frontend/src/lib/wasmlive/fallback.ts frontend/src/__tests__/wasmliveFallback.test.ts
git commit -m "feat: eligibility and the one-way fallback to the transcode"
```

---

### Task 10: `PlaybackSurface` and the VideoPlayer refactor

This is the task that makes two playback implementations possible. It changes no behaviour: the existing suite is the proof.

**Files:**
- Create: `frontend/src/lib/playbackSurface.ts`
- Modify: `frontend/src/components/VideoPlayer.tsx`
- Modify: `frontend/src/hooks/usePlayer.ts`
- Test: `frontend/src/__tests__/playbackSurface.test.ts`

**Interfaces:**
- Consumes: the existing `usePlayer` hook.
- Produces:
  ```ts
  export type SurfaceEvent = "ready" | "timeupdate" | "waiting" | "playing" | "paused" | "ended" | "error";
  export interface PlaybackSurface {
    play(): Promise<void>;
    pause(): void;
    seek(seconds: number): void;
    readonly currentTime: number;
    readonly seekable: readonly [number, number] | null;
    readonly paused: boolean;
    readonly error: string | null;
    on(event: SurfaceEvent, handler: () => void): () => void;
    destroy(): void;
  }
  export function createHlsSurface(video: HTMLVideoElement, load: (url: string) => void, url: string): PlaybackSurface
  ```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/playbackSurface.test.ts
import { describe, it, expect, vi } from "vitest";

import { createHlsSurface } from "../lib/playbackSurface";

function fakeVideo() {
  const listeners = new Map<string, Set<EventListener>>();
  const video = {
    currentTime: 0,
    paused: true,
    buffered: { length: 0 },
    seekable: { length: 1, start: () => 10, end: () => 70 },
    play: vi.fn(async () => { video.paused = false; emit("playing"); }),
    pause: vi.fn(() => { video.paused = true; emit("pause"); }),
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => listeners.get(type)?.delete(fn),
  } as unknown as HTMLVideoElement & { paused: boolean };

  const emit = (type: string) => listeners.get(type)?.forEach((fn) => fn(new Event(type)));
  return { video, emit };
}

describe("createHlsSurface", () => {
  it("loads the url it is given", () => {
    const { video } = fakeVideo();
    const load = vi.fn();
    createHlsSurface(video, load, "/api/transcoded/abc/playlist.m3u8");
    expect(load).toHaveBeenCalledWith("/api/transcoded/abc/playlist.m3u8");
  });

  it("reports the element's seekable range as a pair", () => {
    const { video } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    expect(surface.seekable).toEqual([10, 70]);
  });

  it("has no range before the element has one", () => {
    const { video } = fakeVideo();
    (video as unknown as { seekable: { length: number } }).seekable = { length: 0 } as never;
    expect(createHlsSurface(video, vi.fn(), "/x.m3u8").seekable).toBeNull();
  });

  it("seeks by setting currentTime", () => {
    const { video } = fakeVideo();
    createHlsSurface(video, vi.fn(), "/x.m3u8").seek(42);
    expect(video.currentTime).toBe(42);
  });

  it("translates element events into surface events", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onWaiting = vi.fn();
    surface.on("waiting", onWaiting);
    emit("waiting");
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it("stops delivering after unsubscribe", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onTime = vi.fn();
    surface.on("timeupdate", onTime)();
    emit("timeupdate");
    expect(onTime).not.toHaveBeenCalled();
  });

  it("detaches every listener on destroy", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onTime = vi.fn();
    surface.on("timeupdate", onTime);
    surface.destroy();
    emit("timeupdate");
    expect(onTime).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/playbackSurface.test.ts`
Expected: FAIL — cannot resolve `../lib/playbackSurface`

- [ ] **Step 3: Write `playbackSurface.ts`**

```ts
// frontend/src/lib/playbackSurface.ts
/**
 * One playback interface, two implementations.
 *
 * The player's bar, scrubber, anchor and DVR arithmetic are all written against
 * `currentTime` and `seekable`. Putting those behind an interface is what lets
 * a canvas pipeline stand where the <video> element stands, without the rest of
 * the player learning that anything changed.
 */

export type SurfaceEvent =
  | "ready" | "timeupdate" | "waiting" | "playing" | "paused" | "ended" | "error";

export interface PlaybackSurface {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  readonly currentTime: number;
  readonly seekable: readonly [number, number] | null;
  readonly paused: boolean;
  readonly error: string | null;
  on(event: SurfaceEvent, handler: () => void): () => void;
  destroy(): void;
}

/** Media events, mapped onto surface events. */
const EVENT_MAP: Record<string, SurfaceEvent> = {
  loadedmetadata: "ready",
  timeupdate: "timeupdate",
  waiting: "waiting",
  playing: "playing",
  pause: "paused",
  ended: "ended",
  error: "error",
};

export function createHlsSurface(
  video: HTMLVideoElement,
  load: (url: string) => void,
  url: string,
): PlaybackSurface {
  const handlers = new Map<SurfaceEvent, Set<() => void>>();
  const attached: [string, EventListener][] = [];

  for (const [mediaEvent, surfaceEvent] of Object.entries(EVENT_MAP)) {
    const listener: EventListener = () => handlers.get(surfaceEvent)?.forEach((fn) => fn());
    video.addEventListener(mediaEvent, listener);
    attached.push([mediaEvent, listener]);
  }

  load(url);

  return {
    play: () => video.play(),
    pause: () => video.pause(),
    seek: (seconds: number) => { video.currentTime = seconds; },
    get currentTime() { return video.currentTime; },
    get seekable() {
      const ranges = video.seekable;
      return ranges.length ? ([ranges.start(0), ranges.end(ranges.length - 1)] as const) : null;
    },
    get paused() { return video.paused; },
    get error() { return video.error ? `Media error ${video.error.code}` : null; },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    destroy() {
      for (const [type, listener] of attached) video.removeEventListener(type, listener);
      handlers.clear();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/playbackSurface.test.ts`
Expected: 7 passed

- [ ] **Step 5: Route `VideoPlayer` through the surface**

Mechanical, and behaviour-preserving. In `VideoPlayer.tsx`:

1. Add `const surfaceRef = useRef<PlaybackSurface | null>(null);`
2. In the start effect, after `load(r.stream_url)`, build the surface:
   `surfaceRef.current = createHlsSurface(videoRef.current!, load, r.stream_url);`
   (`load` already ran inside `createHlsSurface`; call it there instead of before, so it happens exactly once.)
3. Replace every read of `videoRef.current.currentTime` with `surfaceRef.current?.currentTime ?? 0`.
4. Replace every write of `video.currentTime = x` with `surfaceRef.current?.seek(x)`.
5. Replace every `video.seekable` read with `surfaceRef.current?.seekable`, which is a pair or `null` rather than a `TimeRanges`.
6. Replace `video.play()` / `video.pause()` with the surface's.
7. Media event listeners attached directly to the element become `surfaceRef.current.on(...)` subscriptions, unsubscribed in the same cleanup.
8. Destroy the surface where the player currently calls `destroy()`.

Do not change any of the arithmetic around these reads. The `<video>` element stays in the tree exactly as it is.

- [ ] **Step 6: Run the whole frontend suite**

Run: `cd frontend && npm test`
Expected: 105 existing tests plus the new ones, all passing. Any failure here is a refactor mistake, not a spec question — the behaviour is meant to be identical.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/playbackSurface.ts frontend/src/components/VideoPlayer.tsx frontend/src/hooks/usePlayer.ts frontend/src/__tests__/playbackSurface.test.ts
git commit -m "refactor: play through a PlaybackSurface instead of the element"
```

---

## Phase 3 — The decode pipeline

### Task 11: `libavClient` and the hermetic decode test

> **Rewritten after Phase 0.** The filter graph in the code below is
> `format=pix_fmts=yuv420p` and nothing else — `bwdif` is not used, because it
> measured at 0.82x realtime. What this module must do instead is *report* each
> frame's interlacing so the GPU can deinterlace it: `interlaced`,
> `topFieldFirst` and `durationSeconds` on every `DecodedVideoFrame`. In
> ffmpeg 9 those come from `AVFrame.flags` (`AV_FRAME_FLAG_INTERLACED` = 1 << 3,
> `AV_FRAME_FLAG_TOP_FIELD_FIRST` = 1 << 4) — read them with the exposed
> `AVFrame_flags` accessor if `ff_copyout_frame` does not carry them, and assert
> against the fixture, which is `field_order=tt` and must come back
> `interlaced: true, topFieldFirst: true`. The deinterlace option stays in
> `createDecoder`'s signature, defaulting **off**, so the comparison can be
> re-run if libav.js ever gains SIMD.

**Files:**
- Create: `frontend/src/lib/wasmlive/libavClient.ts`
- Create: `frontend/src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin`
- Test: `frontend/src/__tests__/wasmliveDecode.test.ts`

**Interfaces:**
- Consumes: `DecodedVideoFrame`, `DecodedAudioChunk` (Task 7); the built variant (Task 1).
- Produces:
  ```ts
  export interface DecodeOutput { video: DecodedVideoFrame[]; audio: DecodedAudioChunk[] }
  export interface LibavDecoder {
    push(bytes: Uint8Array): Promise<DecodeOutput>;
    flush(): Promise<DecodeOutput>;
    reset(): Promise<void>;
    close(): Promise<void>;
  }
  export function createDecoder(options?: { base?: string; deinterlace?: boolean }): Promise<LibavDecoder>
  ```
  `push` feeds bytes and returns whatever became available. `reset` tears the graph down and rebuilds it, for a discontinuity or a seek. This is the only module that may import libav.js.

- [ ] **Step 1: Cut the fixture**

```bash
ffmpeg -y -i /private/tmp/claude-502/-Users-peet-GitHub-tablo-web/be7b1098-aded-449a-8346-7df2e179aeff/scratchpad/raw_1080i.ts \
  -t 1 -c copy -f mpegts \
  frontend/src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin
ls -lh frontend/src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin
```
Expected: roughly 1.1 MB. The `.bin` suffix keeps vitest from treating it as TypeScript. Committing it is deliberate: the decode test has to be runnable on a clone with no device.

- [ ] **Step 2: Write the failing test**

```ts
// frontend/src/__tests__/wasmliveDecode.test.ts
/**
 * The one test that proves the WASM build actually decodes this device's
 * output. It is slow by the standards of this suite and that is fine: it is
 * what fails if a libav.js upgrade changes the variant.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { createDecoder } from "../lib/wasmlive/libavClient";

const FIXTURE = fileURLToPath(new URL("../lib/wasmlive/__fixtures__/1080i-1s.ts.bin", import.meta.url));

describe("libavClient", () => {
  it("decodes 1080i MPEG-2 and AC-3 out of MPEG-TS", { timeout: 60_000 }, async () => {
    const decoder = await createDecoder();
    const bytes = new Uint8Array(readFileSync(FIXTURE));

    const out = { video: [] as unknown[], audio: [] as unknown[] };
    for (let at = 0; at < bytes.length; at += 64 * 1024) {
      const part = await decoder.push(bytes.subarray(at, Math.min(at + 64 * 1024, bytes.length)));
      out.video.push(...part.video);
      out.audio.push(...part.audio);
    }
    const tail = await decoder.flush();
    out.video.push(...tail.video);
    out.audio.push(...tail.audio);
    await decoder.close();

    // ~1s at 29.97i, doubled to 59.94p by send_field. Allow for a partial GOP
    // at each end of the cut.
    expect(out.video.length).toBeGreaterThan(40);

    const first = out.video[0] as { width: number; height: number; data: Uint8Array; ptsSeconds: number };
    expect(first.width).toBe(1920);
    expect(first.height).toBe(1080);
    // Packed I420: one luma plane plus two half-size chroma planes.
    expect(first.data.length).toBe((1920 * 1080 * 3) / 2);

    const pts = (out.video as { ptsSeconds: number }[]).map((f) => f.ptsSeconds);
    expect(pts.every((t, i) => i === 0 || t > pts[i - 1])).toBe(true);

    expect(out.audio.length).toBeGreaterThan(0);
    const audio = out.audio[0] as { sampleRate: number; samples: Float32Array };
    expect(audio.sampleRate).toBe(48000);
    // Downmixed to stereo: an even number of interleaved samples.
    expect(audio.samples.length % 2).toBe(0);
  });

  it("can be reset and fed again", { timeout: 60_000 }, async () => {
    const decoder = await createDecoder();
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    await decoder.push(bytes.subarray(0, 256 * 1024));
    await decoder.reset();
    const out = await decoder.push(bytes.subarray(0, 256 * 1024));
    await decoder.close();
    expect(out.video.length + out.audio.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveDecode.test.ts`
Expected: FAIL — cannot resolve `../lib/wasmlive/libavClient`

- [ ] **Step 4: Write the implementation**

The API shapes below are from libav.js 6.10.9's own `docs/API.md`. Keep every libav call inside this file.

```ts
// frontend/src/lib/wasmlive/libavClient.ts
/**
 * The only module that knows libav.js exists.
 *
 * Bytes in, decoded frames and PCM out. Everything libav-shaped — reader
 * devices, format contexts, filter graphs, packet and frame pointers — stops
 * here, so the rest of the pipeline is ordinary TypeScript and the version pin
 * has exactly one blast radius.
 */

import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

const VARIANT_URL = "/wasm/libav/libav-6.10.9.0-tablo-mpeg2.js";
const DEVICE = "stream.ts";
const READ_LIMIT = 256 * 1024;

export interface DecodeOutput {
  video: DecodedVideoFrame[];
  audio: DecodedAudioChunk[];
}

export interface LibavDecoder {
  push(bytes: Uint8Array): Promise<DecodeOutput>;
  flush(): Promise<DecodeOutput>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createDecoder(
  options: { base?: string; deinterlace?: boolean } = {},
): Promise<LibavDecoder> {
  const deinterlace = options.deinterlace ?? true;
  const factory = await import(/* @vite-ignore */ options.base ?? VARIANT_URL);

  // noworker: this module already runs inside our own worker, so libav.js
  // should be synchronous with it rather than starting a second one.
  let libav = await factory.LibAV({ noworker: true });

  let pending: Uint8Array[] = [];
  let ready = false;
  let fmtCtx = 0;
  let videoStream: any = null;
  let audioStream: any = null;
  let vctx = 0, vpkt = 0, vframe = 0;
  let actx = 0, apkt = 0, aframe = 0;
  let vsrc = 0, vsink = 0;
  let asrc = 0, asink = 0;

  const feed = () => {
    const next = pending.shift();
    libav.ff_reader_dev_send(DEVICE, next ?? null);
  };

  const open = async () => {
    await libav.mkreaderdev(DEVICE);
    libav.onread = feed;

    [fmtCtx, /* streams */] = [0, null] as never;  // replaced below
    const [ctx, streams] = await libav.ff_init_demuxer_file(DEVICE, "mpegts");
    fmtCtx = ctx;
    videoStream = streams.find((s: any) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
    audioStream = streams.find((s: any) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

    if (videoStream) {
      [, vctx, vpkt, vframe] = await libav.ff_init_decoder(videoStream.codec_id, {
        codecpar: videoStream.codecpar,
        time_base: [videoStream.time_base_num, videoStream.time_base_den],
      });
      const description = deinterlace
        ? "bwdif=mode=send_field:parity=auto:deint=all,format=pix_fmts=yuv420p"
        : "format=pix_fmts=yuv420p";
      [, vsrc, vsink] = await libav.ff_init_filter_graph(
        description,
        {
          type: libav.AVMEDIA_TYPE_VIDEO,
          width: videoStream.width, height: videoStream.height,
          pix_fmt: libav.AV_PIX_FMT_YUV420P,
          time_base: [videoStream.time_base_num, videoStream.time_base_den],
        },
        { type: libav.AVMEDIA_TYPE_VIDEO, pix_fmt: libav.AV_PIX_FMT_YUV420P },
      ) as [number, number, number];
    }

    if (audioStream) {
      [, actx, apkt, aframe] = await libav.ff_init_decoder(audioStream.codec_id, {
        codecpar: audioStream.codecpar,
        time_base: [audioStream.time_base_num, audioStream.time_base_den],
      });
      // 5.1 down to stereo, float, for WebAudio.
      [, asrc, asink] = await libav.ff_init_filter_graph(
        "aresample,aformat=sample_fmts=flt:channel_layouts=stereo",
        {
          type: libav.AVMEDIA_TYPE_AUDIO,
          sample_rate: audioStream.sample_rate ?? 48000,
          sample_fmt: libav.AV_SAMPLE_FMT_FLTP,
          channel_layout: 0x3f,  // 5.1
        },
        {
          type: libav.AVMEDIA_TYPE_AUDIO,
          sample_rate: 48000,
          sample_fmt: libav.AV_SAMPLE_FMT_FLT,
          channel_layout: 3,  // stereo
        },
      ) as [number, number, number];
    }
    ready = true;
  };

  const secondsOf = (frame: any, stream: any): number => {
    const base = stream.time_base_num / stream.time_base_den;
    const pts = (frame.ptshi ?? 0) * 4294967296 + (frame.pts ?? 0);
    return pts * base;
  };

  const drain = async (fin: boolean): Promise<DecodeOutput> => {
    const out: DecodeOutput = { video: [], audio: [] };
    if (!ready) return out;

    for (;;) {
      const [result, packets] = await libav.ff_read_frame_multi(fmtCtx, vpkt, { limit: READ_LIMIT });

      if (videoStream && packets[videoStream.index]?.length) {
        const frames = await libav.ff_decode_filter_multi(
          vctx, vsrc, vsink, vpkt, vframe, packets[videoStream.index],
          { copyoutFrame: "video_packed", fin },
        );
        for (const f of frames) {
          out.video.push({
            data: f.data, width: f.width, height: f.height,
            ptsSeconds: secondsOf(f, videoStream),
          });
        }
      }

      if (audioStream && packets[audioStream.index]?.length) {
        const frames = await libav.ff_decode_filter_multi(
          actx, asrc, asink, apkt, aframe, packets[audioStream.index], { fin },
        );
        for (const f of frames) {
          out.audio.push({
            samples: f.data as Float32Array,
            sampleRate: f.sample_rate ?? 48000,
            ptsSeconds: secondsOf(f, audioStream),
          });
        }
      }

      if (result === libav.AVERROR_EOF) break;
      if (result === -libav.EAGAIN) break;   // wants more bytes than we have
      if (result !== 0) throw new Error(`libav read failed: ${result}`);
    }
    return out;
  };

  return {
    async push(bytes: Uint8Array) {
      pending.push(bytes);
      if (!ready) await open();
      return drain(false);
    },
    async flush() {
      pending.push(null as unknown as Uint8Array);
      return drain(true);
    },
    async reset() {
      await this.close();
      pending = [];
      ready = false;
      libav = await factory.LibAV({ noworker: true });
    },
    async close() {
      if (videoStream) await libav.ff_free_decoder(vctx, vpkt, vframe);
      if (audioStream) await libav.ff_free_decoder(actx, apkt, aframe);
      if (fmtCtx) await libav.avformat_close_input_js(fmtCtx);
      libav.terminate?.();
    },
  };
}
```

Two things the implementer must resolve against the real build rather than guess: whether `ff_init_demuxer_file`'s second argument takes `"mpegts"` as the format string (the docs say a bare string is the `format` option), and the exact frame fields (`ptshi`/`pts`, `data`, `sample_rate`). Run the test, read what comes back, and correct the code until the assertions hold. The `[fmtCtx, /* streams */] = [0, null] as never;` line is scaffolding — delete it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveDecode.test.ts`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/wasmlive/libavClient.ts frontend/src/lib/wasmlive/__fixtures__ frontend/src/__tests__/wasmliveDecode.test.ts
git commit -m "feat: decode MPEG-2 and AC-3 through libav.js"
```

---

### Task 12: The decode worker

**Files:**
- Create: `frontend/src/lib/wasmlive/decode.worker.ts`
- Create: `frontend/src/lib/wasmlive/workerProtocol.ts`
- Test: `frontend/src/__tests__/wasmliveWorkerProtocol.test.ts`

**Interfaces:**
- Consumes: `LibavDecoder`, `createDecoder` (Task 11).
- Produces:
  ```ts
  export type ToWorker =
    | { type: "open"; deinterlace: boolean }
    | { type: "segment"; bytes: ArrayBuffer }
    | { type: "reset" }
    | { type: "close" };
  export type FromWorker =
    | { type: "opened" }
    | { type: "video"; frames: DecodedVideoFrame[] }
    | { type: "audio"; chunks: DecodedAudioChunk[] }
    | { type: "error"; message: string };
  export function createWorkerHandler(make: () => Promise<LibavDecoder>, post: (m: FromWorker, transfer: Transferable[]) => void): (m: ToWorker) => Promise<void>
  ```
  The handler is separated from the worker entry point so it can be tested without a Worker.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/wasmliveWorkerProtocol.test.ts
import { describe, it, expect, vi } from "vitest";

import { createWorkerHandler } from "../lib/wasmlive/workerProtocol";
import type { FromWorker } from "../lib/wasmlive/workerProtocol";

const frame = { data: new Uint8Array(6), width: 2, height: 2, ptsSeconds: 1 };
const chunk = { samples: new Float32Array(4), sampleRate: 48000, ptsSeconds: 1 };

function fakeDecoder(overrides: Record<string, unknown> = {}) {
  return {
    push: vi.fn(async () => ({ video: [frame], audio: [chunk] })),
    flush: vi.fn(async () => ({ video: [], audio: [] })),
    reset: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("createWorkerHandler", () => {
  it("answers open with opened", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async () => fakeDecoder() as never, (m) => posted.push(m));
    await handle({ type: "open", deinterlace: true });
    expect(posted).toEqual([{ type: "opened" }]);
  });

  it("posts decoded video and audio for a segment", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async () => fakeDecoder() as never, (m) => posted.push(m));
    await handle({ type: "open", deinterlace: true });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(posted.map((m) => m.type)).toEqual(["opened", "video", "audio"]);
  });

  it("transfers frame buffers rather than copying them", async () => {
    const transfers: Transferable[][] = [];
    const handle = createWorkerHandler(async () => fakeDecoder() as never, (_m, t) => transfers.push(t));
    await handle({ type: "open", deinterlace: true });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(transfers[1]).toEqual([frame.data.buffer]);
  });

  it("says nothing about empty output", async () => {
    const posted: FromWorker[] = [];
    const decoder = fakeDecoder({ push: vi.fn(async () => ({ video: [], audio: [] })) });
    const handle = createWorkerHandler(async () => decoder as never, (m) => posted.push(m));
    await handle({ type: "open", deinterlace: true });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(posted).toEqual([{ type: "opened" }]);
  });

  it("reports a decode failure as an error message", async () => {
    const posted: FromWorker[] = [];
    const decoder = fakeDecoder({ push: vi.fn(async () => { throw new Error("bad packet"); }) });
    const handle = createWorkerHandler(async () => decoder as never, (m) => posted.push(m));
    await handle({ type: "open", deinterlace: true });
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(posted[1]).toEqual({ type: "error", message: "bad packet" });
  });

  it("reports a failure to open", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async () => { throw new Error("no wasm"); }, (m) => posted.push(m));
    await handle({ type: "open", deinterlace: true });
    expect(posted).toEqual([{ type: "error", message: "no wasm" }]);
  });

  it("forwards reset and close to the decoder", async () => {
    const decoder = fakeDecoder();
    const handle = createWorkerHandler(async () => decoder as never, () => {});
    await handle({ type: "open", deinterlace: true });
    await handle({ type: "reset" });
    await handle({ type: "close" });
    expect(decoder.reset).toHaveBeenCalledOnce();
    expect(decoder.close).toHaveBeenCalledOnce();
  });

  it("ignores a segment that arrives before open", async () => {
    const posted: FromWorker[] = [];
    const handle = createWorkerHandler(async () => fakeDecoder() as never, (m) => posted.push(m));
    await handle({ type: "segment", bytes: new ArrayBuffer(8) });
    expect(posted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveWorkerProtocol.test.ts`
Expected: FAIL — cannot resolve `../lib/wasmlive/workerProtocol`

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/wasmlive/workerProtocol.ts
/**
 * What the worker and the page say to each other.
 *
 * Kept apart from the worker entry point so the message handling is ordinary
 * testable code rather than something that needs a Worker to exercise.
 */

import type { LibavDecoder } from "./libavClient";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

export type ToWorker =
  | { type: "open"; deinterlace: boolean }
  | { type: "segment"; bytes: ArrayBuffer }
  | { type: "reset" }
  | { type: "close" };

export type FromWorker =
  | { type: "opened" }
  | { type: "video"; frames: DecodedVideoFrame[] }
  | { type: "audio"; chunks: DecodedAudioChunk[] }
  | { type: "error"; message: string };

export function createWorkerHandler(
  make: () => Promise<LibavDecoder>,
  post: (message: FromWorker, transfer: Transferable[]) => void,
): (message: ToWorker) => Promise<void> {
  let decoder: LibavDecoder | null = null;

  const emit = (out: { video: DecodedVideoFrame[]; audio: DecodedAudioChunk[] }) => {
    if (out.video.length) {
      post({ type: "video", frames: out.video }, out.video.map((f) => f.data.buffer));
    }
    if (out.audio.length) {
      post({ type: "audio", chunks: out.audio }, out.audio.map((c) => c.samples.buffer));
    }
  };

  return async (message: ToWorker) => {
    try {
      switch (message.type) {
        case "open":
          decoder = await make();
          post({ type: "opened" }, []);
          return;
        case "segment":
          if (!decoder) return;  // a segment that beat `open` is simply early
          emit(await decoder.push(new Uint8Array(message.bytes)));
          return;
        case "reset":
          await decoder?.reset();
          return;
        case "close":
          await decoder?.close();
          decoder = null;
          return;
      }
    } catch (e) {
      post({ type: "error", message: e instanceof Error ? e.message : String(e) }, []);
    }
  };
}
```

```ts
// frontend/src/lib/wasmlive/decode.worker.ts
/** Worker entry point: wiring only. The logic is in workerProtocol.ts. */

import { createDecoder } from "./libavClient";
import { createWorkerHandler } from "./workerProtocol";
import type { ToWorker } from "./workerProtocol";

let deinterlace = true;

const handle = createWorkerHandler(
  () => createDecoder({ deinterlace }),
  (message, transfer) => self.postMessage(message, transfer),
);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  if (event.data.type === "open") deinterlace = event.data.deinterlace;
  void handle(event.data);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveWorkerProtocol.test.ts`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/workerProtocol.ts frontend/src/lib/wasmlive/decode.worker.ts frontend/src/__tests__/wasmliveWorkerProtocol.test.ts
git commit -m "feat: decode worker and its message protocol"
```

---

### Task 13: The presenter

> **Rewritten after Phase 0.** The presenter draws through WebGL2, not
> `VideoFrame` + `drawImage`. Each decoded frame's Y, U and V planes are
> uploaded into three reused `R8` textures, and the frame is drawn **twice** —
> once per field, half a frame duration apart — by a fragment shader that
> interpolates the field's missing lines and converts YUV to RGB in the same
> pass. A progressive frame (`interlaced: false`) is drawn once, untouched.
> Textures are allocated once per resolution and reused; allocating per frame at
> 60p exhausts GPU memory.
>
> The queue therefore holds **fields**, not frames: `{ ptsSeconds, parity,
> frame }`, where a frame at pts *t* with duration *d* and `topFieldFirst`
> yields `{t, "top"}` and `{t + d/2, "bottom"}`, and the reverse when bottom
> field first. Everything in Task 8 (`selectFrame`, `admit`) works unchanged on
> those entries — they are `Timed`.
>
> Keep the dependency injection: `draw(entry)` and a `now()` clock stay
> injected, so the scheduling tests below run with no GL context. The GL itself
> lives in `deinterlace.ts` behind `createRenderer(canvas)` →
> `{ upload(frame), drawField(parity), resize(w, h), destroy() }`, and is
> exercised by eye in the soak, not by a test that would assert nothing.
>
> Tests to add beyond those below: a frame with `interlaced: false` enqueues one
> entry rather than two; a bottom-field-first frame enqueues `{t, "bottom"}`
> then `{t + d/2, "top"}`.

**Files:**
- Create: `frontend/src/lib/wasmlive/presenter.ts`
- Test: `frontend/src/__tests__/wasmlivePresenter.test.ts`

**Interfaces:**
- Consumes: `selectFrame`, `admit`, `MAX_QUEUED_FRAMES` (Task 8); `DecodedVideoFrame` (Task 7).
- Produces:
  ```ts
  export interface PresenterDeps {
    draw(frame: unknown): void;
    makeFrame(decoded: DecodedVideoFrame): { close(): void };
    now(): number;            // the audio clock, in media seconds
  }
  export interface Presenter {
    offer(frame: DecodedVideoFrame): void;
    tick(): void;
    readonly newestPts: number | null;
    readonly presentedCount: number;
    destroy(): void;
  }
  export function createPresenter(deps: PresenterDeps): Presenter
  ```
  Dependency-injected so the scheduling is testable without a canvas: the real caller passes a `VideoFrame` constructor and an OffscreenCanvas `drawImage`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/wasmlivePresenter.test.ts
import { describe, it, expect, vi } from "vitest";

import { createPresenter } from "../lib/wasmlive/presenter";
import { MAX_QUEUED_FRAMES } from "../lib/wasmlive/frameQueue";

const decoded = (ptsSeconds: number) => ({
  data: new Uint8Array(6), width: 2, height: 2, ptsSeconds,
});

function harness(startClock = 0) {
  const closed: number[] = [];
  const drawn: number[] = [];
  let clock = startClock;
  const presenter = createPresenter({
    now: () => clock,
    makeFrame: (d) => ({ pts: d.ptsSeconds, close: () => closed.push(d.ptsSeconds) }) as never,
    draw: (f) => drawn.push((f as { pts: number }).pts),
  });
  return { presenter, drawn, closed, setClock: (t: number) => { clock = t; } };
}

describe("createPresenter", () => {
  it("draws nothing while the queue is ahead of the clock", () => {
    const { presenter, drawn } = harness(0);
    presenter.offer(decoded(1));
    presenter.tick();
    expect(drawn).toEqual([]);
  });

  it("draws the newest due frame", () => {
    const { presenter, drawn, setClock } = harness(0);
    presenter.offer(decoded(1));
    presenter.offer(decoded(1.017));
    presenter.offer(decoded(2));
    setClock(1.02);
    presenter.tick();
    expect(drawn).toEqual([1.017]);
  });

  it("closes every frame it skipped, so nothing leaks", () => {
    const { presenter, closed, setClock } = harness(0);
    presenter.offer(decoded(1));
    presenter.offer(decoded(1.017));
    setClock(1.02);
    presenter.tick();
    // The skipped frame and the one just drawn are both spent.
    expect(closed).toEqual([1, 1.017]);
  });

  it("evicts at the queue cap rather than growing", () => {
    const { presenter, closed } = harness(0);
    for (let i = 0; i <= MAX_QUEUED_FRAMES; i++) presenter.offer(decoded(10 + i));
    expect(closed).toEqual([10]);
  });

  it("knows the newest pts it holds, for starvation detection", () => {
    const { presenter } = harness(0);
    expect(presenter.newestPts).toBeNull();
    presenter.offer(decoded(4));
    presenter.offer(decoded(5));
    expect(presenter.newestPts).toBe(5);
  });

  it("counts what it has presented", () => {
    const { presenter, setClock } = harness(0);
    presenter.offer(decoded(1));
    setClock(1);
    presenter.tick();
    expect(presenter.presentedCount).toBe(1);
  });

  it("closes what it still holds when destroyed", () => {
    const { presenter, closed } = harness(0);
    presenter.offer(decoded(8));
    presenter.offer(decoded(9));
    presenter.destroy();
    expect(closed).toEqual([8, 9]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/wasmlivePresenter.test.ts`
Expected: FAIL — cannot resolve `../lib/wasmlive/presenter`

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/wasmlive/presenter.ts
/**
 * Frames onto the canvas, against the audio clock.
 *
 * Every frame constructed here holds GPU memory until it is closed, so closing
 * is not housekeeping — it is the thing that keeps a 1080p60 stream from
 * exhausting the process. Drawing goes through injected dependencies so the
 * scheduling can be tested without a canvas.
 */

import { admit, selectFrame } from "./frameQueue";
import type { DecodedVideoFrame } from "./types";

interface Closable {
  close(): void;
}

interface Queued {
  ptsSeconds: number;
  frame: Closable;
}

export interface PresenterDeps {
  /** Draw a constructed frame. */
  draw(frame: unknown): void;
  /** Turn decoded I420 into whatever `draw` accepts — a VideoFrame, in the app. */
  makeFrame(decoded: DecodedVideoFrame): Closable;
  /** The audio clock, in media seconds. */
  now(): number;
}

export interface Presenter {
  offer(frame: DecodedVideoFrame): void;
  tick(): void;
  readonly newestPts: number | null;
  readonly presentedCount: number;
  destroy(): void;
}

export function createPresenter(deps: PresenterDeps): Presenter {
  let queue: Queued[] = [];
  let presented = 0;

  return {
    offer(decoded: DecodedVideoFrame) {
      const entry: Queued = { ptsSeconds: decoded.ptsSeconds, frame: deps.makeFrame(decoded) };
      const { queue: next, dropped } = admit(queue, entry);
      for (const gone of dropped) gone.frame.close();
      queue = next;
    },

    tick() {
      const { present, drop, keep } = selectFrame(queue, deps.now());
      for (const late of drop) late.frame.close();
      if (present) {
        deps.draw(present.frame);
        present.frame.close();
        presented++;
      }
      queue = keep;
    },

    get newestPts() {
      return queue.length ? queue[queue.length - 1].ptsSeconds : null;
    },

    get presentedCount() {
      return presented;
    },

    destroy() {
      for (const entry of queue) entry.frame.close();
      queue = [];
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/wasmlivePresenter.test.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/presenter.ts frontend/src/__tests__/wasmlivePresenter.test.ts
git commit -m "feat: present frames against the audio clock"
```

---

### Task 14: The audio sink

**Files:**
- Create: `frontend/src/lib/wasmlive/pcmWorklet.js`
- Create: `frontend/src/lib/wasmlive/audioSink.ts`
- Test: `frontend/src/__tests__/wasmliveAudioSink.test.ts`

**Interfaces:**
- Consumes: `audioClockSeconds` (Task 8); `DecodedAudioChunk` (Task 7).
- Produces:
  ```ts
  export interface AudioSink {
    push(chunk: DecodedAudioChunk): void;
    readonly clockSeconds: number | null;
    resume(): Promise<void>;
    suspend(): Promise<void>;
    destroy(): Promise<void>;
  }
  export function createAudioSink(context: AudioContext, workletUrl: string): Promise<AudioSink>
  export function createSinkState(sampleRate: number): { firstPtsSeconds: number | null; samplesPlayed: number; sampleRate: number }
  export function onSamplesPlayed(state, framesPlayed: number): void
  ```
  The worklet posts the number of frames it has rendered; `samplesPlayed` follows it, and `clockSeconds` is derived.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/wasmliveAudioSink.test.ts
import { describe, it, expect } from "vitest";

import { createSinkState, onSamplesPlayed, sinkClockSeconds, notePts } from "../lib/wasmlive/audioSink";

describe("audio sink accounting", () => {
  it("has no clock before any audio arrives", () => {
    expect(sinkClockSeconds(createSinkState(48000))).toBeNull();
  });

  it("starts the clock at the first chunk's pts", () => {
    const state = createSinkState(48000);
    notePts(state, 12.5);
    expect(sinkClockSeconds(state)).toBe(12.5);
  });

  it("keeps the first pts, not the latest", () => {
    const state = createSinkState(48000);
    notePts(state, 12.5);
    notePts(state, 13.0);
    expect(sinkClockSeconds(state)).toBe(12.5);
  });

  it("advances by the frames the worklet says it rendered", () => {
    const state = createSinkState(48000);
    notePts(state, 10);
    onSamplesPlayed(state, 24000);
    expect(sinkClockSeconds(state)).toBe(10.5);
  });

  it("accumulates across reports", () => {
    const state = createSinkState(48000);
    notePts(state, 0);
    onSamplesPlayed(state, 48000);
    onSamplesPlayed(state, 48000);
    expect(sinkClockSeconds(state)).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveAudioSink.test.ts`
Expected: FAIL — cannot resolve `../lib/wasmlive/audioSink`

- [ ] **Step 3: Write the worklet and the sink**

```js
// frontend/src/lib/wasmlive/pcmWorklet.js
/**
 * Plays interleaved stereo float chunks and reports what it has rendered.
 *
 * The report is the clock the whole pipeline runs on, so it counts frames
 * actually written to the output, not frames received.
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.rendered = 0;
    this.port.onmessage = (event) => { this.queue.push(event.data); };
  }

  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] ?? outputs[0][0];

    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) { left[i] = 0; right[i] = 0; continue; }
      left[i] = chunk[this.offset];
      right[i] = chunk[this.offset + 1];
      this.offset += 2;
      this.rendered++;
      if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0; }
    }

    // One report per render quantum is 375 messages a second at 48 kHz; batch
    // to roughly ten a second instead.
    if (this.rendered >= 4800) {
      this.port.postMessage(this.rendered);
      this.rendered = 0;
    }
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
```

```ts
// frontend/src/lib/wasmlive/audioSink.ts
/**
 * Audio out, and the clock that comes with it.
 *
 * The state functions are separate from the AudioContext plumbing because the
 * accounting is the part that matters and the part worth testing: everything
 * on screen is timed against it.
 */

import type { DecodedAudioChunk } from "./types";

export interface SinkState {
  firstPtsSeconds: number | null;
  samplesPlayed: number;
  sampleRate: number;
}

export function createSinkState(sampleRate: number): SinkState {
  return { firstPtsSeconds: null, samplesPlayed: 0, sampleRate };
}

/** The first chunk sets where the clock begins; later ones do not move it. */
export function notePts(state: SinkState, ptsSeconds: number): void {
  if (state.firstPtsSeconds === null) state.firstPtsSeconds = ptsSeconds;
}

export function onSamplesPlayed(state: SinkState, framesPlayed: number): void {
  state.samplesPlayed += framesPlayed;
}

export function sinkClockSeconds(state: SinkState): number | null {
  if (state.firstPtsSeconds === null) return null;
  return state.firstPtsSeconds + state.samplesPlayed / state.sampleRate;
}

export interface AudioSink {
  push(chunk: DecodedAudioChunk): void;
  readonly clockSeconds: number | null;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  destroy(): Promise<void>;
}

export async function createAudioSink(context: AudioContext, workletUrl: string): Promise<AudioSink> {
  await context.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(context, "pcm-processor", { outputChannelCount: [2] });
  node.connect(context.destination);

  const state = createSinkState(context.sampleRate);
  node.port.onmessage = (event: MessageEvent<number>) => onSamplesPlayed(state, event.data);

  return {
    push(chunk: DecodedAudioChunk) {
      notePts(state, chunk.ptsSeconds);
      node.port.postMessage(chunk.samples, [chunk.samples.buffer]);
    },
    get clockSeconds() { return sinkClockSeconds(state); },
    resume: () => context.resume(),
    suspend: () => context.suspend(),
    async destroy() {
      node.port.onmessage = null;
      node.disconnect();
      await context.close();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveAudioSink.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/audioSink.ts frontend/src/lib/wasmlive/pcmWorklet.js frontend/src/__tests__/wasmliveAudioSink.test.ts
git commit -m "feat: audio sink and the clock the pipeline follows"
```

---

### Task 15: The session and the WASM surface

**Files:**
- Create: `frontend/src/lib/wasmlive/session.ts`
- Create: `frontend/src/lib/wasmlive/wasmSurface.ts`
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7–14.
- Produces:
  ```ts
  export interface SessionOptions {
    playlistUrl: string;
    originMs: number;
    canvas: OffscreenCanvas;
    worker: Worker;
    audio: AudioSink;
    fetchText(url: string): Promise<string>;
    fetchBytes(url: string): Promise<ArrayBuffer>;
    nowMs(): number;
  }
  export interface LiveSession {
    start(): Promise<void>;
    seek(mediaSeconds: number): void;
    pause(): void;
    resume(): void;
    readonly currentTime: number;
    readonly seekable: readonly [number, number] | null;
    readonly failure: string | null;
    on(event: "ready" | "timeupdate" | "waiting" | "playing" | "error", fn: () => void): () => void;
    destroy(): void;
  }
  export function createSession(options: SessionOptions): LiveSession
  export function createWasmSurface(session: LiveSession): PlaybackSurface
  ```

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/wasmliveSession.test.ts
import { describe, it, expect, vi } from "vitest";

import { createSession } from "../lib/wasmlive/session";
import { createWasmSurface } from "../lib/wasmlive/wasmSurface";

const ORIGIN = Date.parse("2026-09-16T20:00:00Z");

const PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:30+00:00
#EXTINF:6.000,
00005.ts
#EXTINF:6.000,
00006.ts
`;

function harness() {
  const posted: unknown[] = [];
  const worker = {
    postMessage: (m: unknown) => posted.push(m),
    terminate: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
  };
  const fetched: string[] = [];
  const session = createSession({
    playlistUrl: "/api/raw/abc/playlist.m3u8",
    originMs: ORIGIN,
    canvas: {} as OffscreenCanvas,
    worker: worker as unknown as Worker,
    audio: { push: vi.fn(), clockSeconds: 36, resume: vi.fn(), suspend: vi.fn(), destroy: vi.fn() } as never,
    fetchText: async (url: string) => { fetched.push(url); return PLAYLIST; },
    fetchBytes: async (url: string) => { fetched.push(url); return new ArrayBuffer(8); },
    nowMs: () => 0,
  });
  return { session, worker, posted, fetched };
}

describe("createSession", () => {
  it("opens the worker before fetching anything", async () => {
    const { session, posted } = harness();
    await session.start();
    expect((posted[0] as { type: string }).type).toBe("open");
  });

  it("reports the ring window as its seekable range", async () => {
    const { session } = harness();
    await session.start();
    expect(session.seekable).toEqual([30, 42]);
  });

  it("takes its current time from the audio clock", async () => {
    const { session } = harness();
    await session.start();
    expect(session.currentTime).toBe(36);
  });

  it("fetches segments from the playlist's own directory", async () => {
    const { session, fetched } = harness();
    await session.start();
    expect(fetched.some((u) => u.endsWith("/api/raw/abc/00005.ts"))).toBe(true);
  });

  it("sends fetched segment bytes to the worker", async () => {
    const { session, posted } = harness();
    await session.start();
    expect(posted.some((m) => (m as { type: string }).type === "segment")).toBe(true);
  });

  it("resets the decoder on a seek", async () => {
    const { session, posted } = harness();
    await session.start();
    posted.length = 0;
    session.seek(31);
    expect((posted[0] as { type: string }).type).toBe("reset");
  });

  it("fails when the worker reports an error", async () => {
    const { session, worker } = harness();
    await session.start();
    worker.onmessage?.({ data: { type: "error", message: "bad packet" } } as MessageEvent);
    expect(session.failure).toBe("decode error");
  });

  it("terminates the worker on destroy", async () => {
    const { session, worker } = harness();
    await session.start();
    session.destroy();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("createWasmSurface", () => {
  it("presents the session through the PlaybackSurface contract", async () => {
    const { session } = harness();
    await session.start();
    const surface = createWasmSurface(session);
    expect(surface.currentTime).toBe(36);
    expect(surface.seekable).toEqual([30, 42]);
    surface.seek(35);
    expect(surface.paused).toBe(false);
    surface.pause();
    expect(surface.paused).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveSession.test.ts`
Expected: FAIL — cannot resolve the modules

- [ ] **Step 3: Write the implementation**

`session.ts` owns the loop: poll the playlist on `targetDuration / 2`, fetch segments that have not been fetched, post them to the worker, feed video frames to the presenter and audio to the sink, run the presenter on `requestAnimationFrame`, and feed the fallback machine. It holds a `FallbackState` and exposes `failure` as `state.failed`. A seek posts `reset`, clears the presenter, and restarts fetching from `segmentAt(playlist, originMs, target)`.

```ts
// frontend/src/lib/wasmlive/session.ts
/**
 * One live WASM playback session.
 *
 * Owns the loop that ties the pieces together: the ring playlist is polled, new
 * segments go to the worker, decoded frames go to the presenter and the sink,
 * and the fallback machine watches for the whole thing failing to keep up.
 */

import { createPresenter } from "./presenter";
import type { Presenter } from "./presenter";
import { parseMediaPlaylist, playlistWindow, segmentAt } from "./playlist";
import type { MediaPlaylist } from "./playlist";
import { initialFallbackState, reduceFallback } from "./fallback";
import type { FallbackState } from "./fallback";
import { starvationSeconds } from "./audioClock";
import type { AudioSink } from "./audioSink";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";
import type { FromWorker } from "./workerProtocol";

export interface SessionOptions {
  playlistUrl: string;
  originMs: number;
  canvas: OffscreenCanvas;
  worker: Worker;
  audio: AudioSink;
  fetchText(url: string): Promise<string>;
  fetchBytes(url: string): Promise<ArrayBuffer>;
  nowMs(): number;
}

export type SessionEvent = "ready" | "timeupdate" | "waiting" | "playing" | "error";

export interface LiveSession {
  start(): Promise<void>;
  seek(mediaSeconds: number): void;
  pause(): void;
  resume(): void;
  readonly currentTime: number;
  readonly seekable: readonly [number, number] | null;
  readonly paused: boolean;
  readonly failure: string | null;
  on(event: SessionEvent, fn: () => void): () => void;
  destroy(): void;
}

/** How late the clock may run behind the newest decoded frame before we call it starvation. */
const STARVED_SECONDS = 1;

export function createSession(options: SessionOptions): LiveSession {
  const handlers = new Map<SessionEvent, Set<() => void>>();
  const emit = (event: SessionEvent) => handlers.get(event)?.forEach((fn) => fn());

  // The GPU does the deinterlace and the colour conversion; see Task 13.
  const renderer = createRenderer(options.canvas);
  const presenter: Presenter = createPresenter({
    now: () => options.audio.clockSeconds ?? 0,
    upload: (decoded: DecodedVideoFrame) => renderer.upload(decoded),
    draw: (entry) => renderer.drawField(entry.parity, entry.interlaced),
  });

  let playlist: MediaPlaylist = { targetDuration: 6, mediaSequence: 0, programDateTimeMs: null, segments: [] };
  let fetchedThrough = -1;           // absolute sequence of the newest segment taken
  let fallback: FallbackState = initialFallbackState(options.nowMs());
  let paused = false;
  let running = false;
  let rafHandle = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const post = (message: unknown, transfer: Transferable[] = []) =>
    options.worker.postMessage(message, transfer);

  options.worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === "video") {
      for (const frame of message.frames) presenter.offer(frame);
      if (presenter.presentedCount === 0) fallback = reduceFallback(fallback, { kind: "first-frame", atMs: options.nowMs() });
      return;
    }
    if (message.type === "audio") {
      for (const chunk of message.chunks as DecodedAudioChunk[]) options.audio.push(chunk);
      return;
    }
    if (message.type === "error") {
      fallback = reduceFallback(fallback, { kind: "decode-error" });
      emit("error");
    }
  };

  const base = (uri: string) => new URL(uri, new URL(options.playlistUrl, "http://local")).pathname;

  const poll = async () => {
    playlist = parseMediaPlaylist(await options.fetchText(options.playlistUrl));
    for (let index = 0; index < playlist.segments.length; index++) {
      const sequence = playlist.mediaSequence + index;
      if (sequence <= fetchedThrough) continue;
      const bytes = await options.fetchBytes(base(playlist.segments[index].uri));
      post({ type: "segment", bytes }, [bytes]);
      fetchedThrough = sequence;
    }
    emit("timeupdate");
  };

  const loop = () => {
    if (!running) return;
    if (!paused) presenter.tick();
    const nowMs = options.nowMs();
    fallback = reduceFallback(fallback, { kind: "tick", atMs: nowMs });
    if (starvationSeconds(
      { firstPtsSeconds: options.audio.clockSeconds, samplesPlayed: 0, sampleRate: 48000 },
      presenter.newestPts,
    ) > STARVED_SECONDS) {
      fallback = reduceFallback(fallback, { kind: "starved", atMs: nowMs });
      emit("waiting");
    }
    if (fallback.failed) emit("error");
    rafHandle = requestAnimationFrame(loop);
  };

  const schedulePoll = () => {
    pollTimer = setTimeout(async () => {
      try {
        await poll();
      } catch {
        // A single failed poll is not fatal; the next one may succeed.
      }
      if (running) schedulePoll();
    }, (playlist.targetDuration / 2) * 1000);
  };

  return {
    async start() {
      running = true;
      post({ type: "open", deinterlace: true });
      await poll();
      schedulePoll();
      rafHandle = requestAnimationFrame(loop);
      emit("ready");
      emit("playing");
    },

    seek(mediaSeconds: number) {
      const target = segmentAt(playlist, options.originMs, mediaSeconds);
      post({ type: "reset" });
      presenter.destroy();
      fetchedThrough = target ? playlist.mediaSequence + target.index - 1 : -1;
      void poll();
    },

    pause() { paused = true; void options.audio.suspend(); },
    resume() { paused = false; void options.audio.resume(); },

    get currentTime() { return options.audio.clockSeconds ?? 0; },
    get seekable() {
      const { start, end } = playlistWindow(playlist, options.originMs);
      return end > start ? ([start, end] as const) : null;
    },
    get paused() { return paused; },
    get failure() { return fallback.failed; },

    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
      return () => handlers.get(event)?.delete(fn);
    },

    destroy() {
      running = false;
      if (pollTimer) clearTimeout(pollTimer);
      cancelAnimationFrame(rafHandle);
      presenter.destroy();
      post({ type: "close" });
      options.worker.terminate();
      void options.audio.destroy();
      handlers.clear();
    },
  };
}
```

```ts
// frontend/src/lib/wasmlive/wasmSurface.ts
/** The WASM session, wearing the interface the player already talks to. */

import type { PlaybackSurface, SurfaceEvent } from "../playbackSurface";
import type { LiveSession } from "./session";

export function createWasmSurface(session: LiveSession): PlaybackSurface {
  return {
    async play() { session.resume(); },
    pause: () => session.pause(),
    seek: (seconds: number) => session.seek(seconds),
    get currentTime() { return session.currentTime; },
    get seekable() { return session.seekable; },
    get paused() { return session.paused; },
    get error() { return session.failure; },
    on(event: SurfaceEvent, handler: () => void) {
      // The session has no "paused" or "ended": pausing is a local state change
      // and a live stream does not end.
      if (event === "paused" || event === "ended") return () => {};
      return session.on(event, handler);
    },
    destroy: () => session.destroy(),
  };
}
```

Two things to settle while making the tests pass: the starvation check above passes a synthetic clock state and should instead read the sink's own state — expose `sinkState` from `createAudioSink` or add a `starvedBy(newestPts)` method to the sink, and delete the synthetic object. And `seek` sets `fetchedThrough` from the target index; verify against the test that a seek re-fetches the segment it landed on rather than skipping it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveSession.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/session.ts frontend/src/lib/wasmlive/wasmSurface.ts frontend/src/__tests__/wasmliveSession.test.ts
git commit -m "feat: live WASM session behind a PlaybackSurface"
```

---

### Task 16: Wire it into the player

**Files:**
- Modify: `frontend/src/api/tablo.ts`
- Modify: `frontend/src/components/VideoPlayer.tsx`
- Test: `frontend/src/__tests__/wasmliveWiring.test.ts`

**Interfaces:**
- Consumes: `wasmLiveEligible` (Task 9), `createSession` / `createWasmSurface` (Task 15), `createHlsSurface` (Task 10).
- Produces:
  - `api.startStream(identifier: string, mode?: "transcode" | "raw" | "ring")` returning `{ session_id, stream_url, proxy_url, mode, started_at, transcoded }`.
  - `VideoPlayer` picks a surface at open, renders a `<canvas>` when the surface is the WASM one, and swaps to the transcode surface on failure.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/__tests__/wasmliveWiring.test.ts
import { describe, it, expect } from "vitest";

import { chooseLivePath } from "../lib/wasmlive/capability";

describe("chooseLivePath", () => {
  const eligible = { eligible: true, reason: "" };
  const ineligible = { eligible: false, reason: "flag off" };

  it("asks for the ring when the browser is eligible", () => {
    expect(chooseLivePath(eligible, "ota")).toEqual({ mode: "ring", wasm: true });
  });

  it("asks for the transcode for a broadcast otherwise", () => {
    expect(chooseLivePath(ineligible, "ota")).toEqual({ mode: "transcode", wasm: false });
  });

  it("leaves OTT on the direct proxy, which already plays", () => {
    expect(chooseLivePath(ineligible, "ott")).toEqual({ mode: "raw", wasm: false });
  });

  it("treats an unknown kind as a broadcast", () => {
    expect(chooseLivePath(ineligible, undefined)).toEqual({ mode: "transcode", wasm: false });
  });

  it("falls back to the transcode, never to the raw proxy", () => {
    // The raw proxy is unplayable for MPEG-2; a fallback that chose it would
    // hand the viewer silence and a black frame.
    expect(chooseLivePath(ineligible, "ota").mode).not.toBe("raw");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/wasmliveWiring.test.ts`
Expected: FAIL — `chooseLivePath` is not exported

- [ ] **Step 3: Write the implementation**

Add to `frontend/src/lib/wasmlive/capability.ts`:

```ts
export type LiveMode = "transcode" | "raw" | "ring";

/** Which backend mode to ask for, and whether we intend to decode it ourselves. */
export function chooseLivePath(
  eligibility: Eligibility,
  channelKind: string | null | undefined,
): { mode: LiveMode; wasm: boolean } {
  if (eligibility.eligible) return { mode: "ring", wasm: true };
  // OTT is already H.264 and plays through the proxy untouched. Everything else
  // is a broadcast, and a broadcast without WASM needs the transcode.
  return channelKind === "ott" ? { mode: "raw", wasm: false } : { mode: "transcode", wasm: false };
}
```

In `frontend/src/api/tablo.ts`, `startStream` takes `mode` and passes it as a query parameter, and its return type gains `mode: LiveMode` and `started_at: string`.

In `VideoPlayer.tsx`'s start effect, replace the live branch:

```tsx
if (current.kind === "live") {
  const eligibility = wasmLiveEligible(window, localStorage, current.channel.kind);
  const { mode, wasm } = chooseLivePath(eligibility, current.channel.kind);
  const r = await api.startStream(current.channel.identifier, mode);
  if (cancelled) return;
  log.player(`open live ${current.channel.display_name}`, {
    kind: current.channel.kind, mode, wasm, reason: eligibility.reason,
    session: r.session_id, url: r.stream_url,
  });
  setSessionId(r.session_id);
  setLiveTranscoded(mode === "transcode");
  surfaceRef.current = wasm
    ? createWasmSurface(createSession({
        playlistUrl: r.stream_url,
        originMs: Date.parse(r.started_at),
        // WebGL2 in the page, on an OffscreenCanvas transferred from the
        // <canvas> the player renders where the <video> would be.
        canvas: canvasRef.current!.transferControlToOffscreen(),
        worker: new Worker(new URL("../lib/wasmlive/decode.worker.ts", import.meta.url), { type: "module" }),
        audio: await createAudioSink(new AudioContext(), pcmWorkletUrl),
        fetchText: async (url) => (await fetch(url)).text(),
        fetchBytes: async (url) => (await fetch(url)).arrayBuffer(),
        nowMs: () => performance.now(),
      }))
    : createHlsSurface(videoRef.current!, load, r.stream_url);
  if (wasm) await startWasm(surfaceRef.current, current);
}
```

with a `startWasm` helper that subscribes to `"error"`, and on failure logs the reason, destroys the WASM surface, calls `api.startStream(identifier, "transcode")`, and installs an `HlsSurface` in its place at the current playhead. The `<canvas ref={canvasRef}>` sits where the `<video>` sits, with exactly one of them shown.

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npm test`
Expected: everything passes, including the 105 pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/tablo.ts frontend/src/components/VideoPlayer.tsx frontend/src/lib/wasmlive/capability.ts frontend/src/__tests__/wasmliveWiring.test.ts
git commit -m "feat: choose the WASM live path, with the transcode as fallback"
```

---

### Task 17: Soak, then default on

**Files:**
- Modify: `frontend/src/lib/wasmlive/capability.ts` (the flag default)
- Modify: `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md` (soak notes)

- [ ] **Step 1: Bring the stack up**

Use the `tablo-stack` skill — a bare `docker compose up` serves the app from the wrong backend and nothing in the UI says so.

- [ ] **Step 2: Turn the flag on and watch**

In the browser console: `localStorage.setItem("tablo.wasmlive", "1")`, then open an OTA channel.

Check, and write down: time from click to first frame (the point of the exercise — the transcode takes ~12s), whether motion is smooth on a 60Hz display, whether lip sync holds after 30 minutes, what a rewind to the middle of the window does, what a rewind past its start does, what a channel change does, and what CPU the tab uses in Chrome's task manager.

- [ ] **Step 3: Force the fallback and watch it recover**

Kill the ring follower mid-playback (stop the backend, or point the session at a dead playlist) and confirm the player lands on the transcode with a rebuffer rather than an error, and that it does not flap back.

- [ ] **Step 4: Flip the default**

Only when steps 2 and 3 are clean. In `capability.ts`, treat a missing flag as on and an explicit `"0"` as off, so the flag becomes a kill switch rather than an opt-in.

- [ ] **Step 5: Commit, alone**

```bash
git add frontend/src/lib/wasmlive/capability.ts docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md
git commit -m "feat: decode live MPEG-2 in the browser by default"
```

This commit is revertible by itself. That is the point of it being last and alone.

---

## Self-review

**Spec coverage.** Phase 0 gate → Tasks 1–3 (1 and 2 done). Raw segment ring → Tasks 4–6. `lib/wasmlive/` modules → Tasks 7, 8, 11, 12, 13, 14, 15. GPU deinterlace → Task 13 and `deinterlace.ts`. The `PlaybackSurface` seam → Task 10. Fallback rules → Tasks 9, 15, 16. Texture reuse and the queue cap → Task 13. Hidden tab, discontinuity, pause/rewind, channel change → Tasks 13 and 15 (`reset` on seek, `pause`/`resume` on the sink, `destroy` on change). Progressive passthrough → Tasks 11 and 13. Testing section → the tests in every task plus the soak in Task 17. Flag default off then flipped → Tasks 9 and 17. LGPL sources shipped → Task 1.

**Known gaps, deliberate.** A mid-stream resolution change is handled by `reset` and texture reallocation but has no test; manufacturing a fixture for it costs more than the case is worth until it is seen. Shader *output* is not asserted anywhere — GPU pixels cannot be checked in node, and a test that asserted nothing would be worse than the honest gap. Deinterlace quality is judged by eye in Task 17 against the same frame through today's `yadif` transcode.

**Type consistency.** `DecodedVideoFrame` / `DecodedAudioChunk` are defined in Task 7 and used unchanged in 11–15. `PlaybackSurface` is defined in Task 10 and implemented twice, in 10 and 15. `selectFrame` / `admit` from Task 8 are consumed in Task 13 only. `FallbackState` / `reduceFallback` from Task 9 are consumed in Task 15 only. `LiveMode` values `transcode | raw | ring` match the backend `mode` parameter in Task 6.
