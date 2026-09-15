# Hardware Transcoding on macOS (VideoToolbox)

**Date:** 2026-09-15
**Status:** Implemented and measured
**Depends on:** `2026-09-15-recording-playback-design.md`

---

## Problem

Transcoding is the binding constraint on this app. Every recording must be
re-encoded (the Gen 4 records raw MPEG-2; no browser decodes it), and the encoder
is pure software.

Measured on the target host:

| | |
|---|---|
| Encoder | `libx264 -preset veryfast` |
| Throughput | ~4.5× realtime with 3 concurrent windows |
| CPU under load | **780%** of 1000% available |
| A 3h30m recording | ~45 min to fully cache |
| Single 60s window | ~29s cold, ~26s of it encoding |

The host is an **Apple M1 Max with 10 cores and an idle Media Engine**. The
hardware H.264 encoder that should be doing this work is never touched.

## Why it is currently unreachable

Not a missing flag. Verified in the running container:

```
ffmpeg -encoders | grep -ci videotoolbox   →  0
ls /dev/dri                                →  No such file or directory
uname -m                                   →  aarch64
```

The backend runs in a **Linux VM** under Docker Desktop (Apple
Virtualization.framework). VideoToolbox is a macOS framework; Apple does not pass
the Media Engine through to Linux guests. The `h264_nvenc`, `h264_vaapi` and
`h264_vulkan` encoders compiled into the container image are equally inert —
there is no device behind any of them.

The only way to reach the encoder is to run the backend **as a macOS process**.

---

## Approach

Move the backend to the host; leave everything else alone.

```
  before                          after
  ┌──────────────────┐            ┌──────────────────┐
  │ nginx  :7070     │            │ nginx  :7070     │   container
  │   └─ backend:8000│            │   └─ host.docker │
  │ backend (Linux)  │            └────────┬─────────┘
  │   └─ libx264     │                     │ :8000
  └──────────────────┘            ┌────────▼─────────┐
                                  │ uvicorn (macOS)  │   host process
                                  │   └─ h264_video- │
                                  │      toolbox     │
                                  └──────────────────┘
```

Containerized deployment stays the default and keeps working on CPU. Native mode
is opt-in, for hosts that have hardware worth using.

### Why not the alternatives

- **GPU passthrough to the container** — not offered by Apple Virtualization.framework.
  No configuration achieves this.
- **Run everything natively** — loses the one-command deployment for no gain;
  nginx and the SPA have no hardware dependency.
- **Remote encode box** — real option for a Linux host with an Intel iGPU
  (`h264_vaapi` via `--device /dev/dri`), but that is a different deployment, not
  this one. The encoder is already env-selectable, so that path costs no code.

---

## Changes required

### 1. Make the two remaining paths configurable

`TRANSCODE_CACHE_DIR` already reads from the environment. `CONFIG_PATH` does not:

```python
# state.py:15 — currently hardcoded
CONFIG_PATH = Path("/data/config.json")
```

Becomes env-driven with the container path as default, so nothing changes for
existing deployments. Native mode points it at
`~/Library/Application Support/tablo-web/`.

### 2. Encoder-specific flags

The encoder is already selectable via `TRANSCODE_VIDEO_ENCODER`, and
`_QUALITY_FLAGS` already carries a VideoToolbox entry. Two corrections are needed
before it will actually work:

- **VideoToolbox does not support `-crf`.** Rate control is `-q:v` (1-100, higher
  is better) or a target bitrate. Passing `-crf` is at best ignored.
- **`-maxrate`/`-bufsize` are applied unconditionally** in `_encode_window` and
  are x264 concepts. They must move into the per-encoder table rather than being
  appended for every encoder.

Proposed table:

```python
_ENCODER_FLAGS = {
    "libx264": [
        "-preset", "veryfast", "-crf", "23",
        "-maxrate", "4000k", "-bufsize", "8000k",
    ],
    "h264_videotoolbox": [
        # -realtime 0 lets it run as fast as the Media Engine allows rather than
        # pacing to wall clock; -allow_sw 1 falls back to software rather than
        # failing outright if the engine is saturated.
        "-realtime", "0", "-allow_sw", "1",
        "-q:v", os.environ.get("TRANSCODE_QUALITY", "55"),
        "-profile:v", "high",
    ],
    "h264_vaapi": ["-qp", "23"],
    "h264_nvenc": ["-preset", "p4", "-cq", "23"],
}
```

`-force_key_frames` stays — segment-boundary alignment is what lets the playlist
be published before encoding, and it is encoder-independent.

**Unverified:** whether `h264_videotoolbox` honors `-force_key_frames` exactly.
If it does not, window segment counts could drift from what the playlist declares.
This must be measured before the mode is considered usable; see Verification.

### 3. Concurrency

`TRANSCODE_CONCURRENCY` defaults to 3, chosen for CPU encoding. The Media Engine
is a fixed-function unit — running several jobs against it does not multiply
throughput and mostly adds contention. Native mode should default to 1-2.

The SIGSTOP/SIGCONT prioritization still applies and needs no change.

### 4. Frontend proxy target

`nginx.conf` hardcodes `proxy_pass http://backend:8000`. Native mode needs
`http://host.docker.internal:8000`. Templated via `envsubst` at container start,
defaulting to `backend:8000`.

### 5. Launching

A `docker-compose.native.yml` that drops the backend service, plus a documented
host command:

```bash
brew install ffmpeg
cd backend && pip install -r requirements.txt
TRANSCODE_VIDEO_ENCODER=h264_videotoolbox \
TRANSCODE_CONCURRENCY=2 \
TABLO_CONFIG_PATH=~/Library/Application\ Support/tablo-web/config.json \
TRANSCODE_CACHE_DIR=~/Library/Caches/tablo-web/recordings \
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Bound to `127.0.0.1`, not `0.0.0.0` — the app still has no authentication, and a
host process is not confined by the container's network the way the current
backend is.

A launchd plist for run-at-login is a follow-up, not part of this.

---

## Verification

This is a performance change, so it stands or falls on measurement. The same
recording (`object_id 80888`, 12615s) encoded both ways:

1. **Correctness first.** Encode window 120 under each encoder and compare:
   - segment count matches `segments_in_window` (the playlist is pre-published,
     so a mismatch breaks seeking)
   - `ffprobe` start_time honors `-output_ts_offset` (otherwise playback snaps
     back at window boundaries — a bug already fixed once for x264)
   - output is `h264` / `1280x720`, plays in the browser
2. **Throughput.** Wall-clock for one cold 60s window, and for ten sequential
   windows, at concurrency 1 and 2.
3. **CPU.** `docker stats` equivalent for the host process during a fill.
4. **Size and quality.** Bytes per window; spot-check a few frames.

### Measured results (2026-09-15, M1 Max, ffmpeg 9.0.1)

One 60s window at offset 2:00:00 of `object_id 80888`, on the host:

| encoder | wall | CPU | output | segments | `-output_ts_offset` |
|---|---|---|---|---|---|
| `libx264 -preset veryfast -crf 23` | 11.5s | **47.4s** | 30 MB | 10 ✓ | honored |
| `h264_videotoolbox -q:v 55` | 7.3s | 5.3s | 51 MB | 10 ✓ | honored |
| `h264_videotoolbox -q:v 40` | 7.8s | **5.1s** | **22 MB** | 10 ✓ | honored |
| `h264_videotoolbox -b:v 4000k` | 14.1s | 5.9s | 25 MB | 10 ✓ | honored |

**CPU drops 9.3x**, and at `-q:v 40` the output is smaller than x264's. Wall clock
barely improves because the job is bound by pulling segments from the Tablo, not
by encoding — the win is that the machine is no longer saturated, which is what
made background prefetch unusable alongside playback.

`-force_key_frames` is honored exactly: 10 segments, matching what the published
playlist declares. The window model needed no change.

### `-a53cc 0` is mandatory

VideoToolbox initially encoded **nothing**, failing every frame with:

```
[h264_videotoolbox] Unexpected end of SEI NAL Unit parsing size.
[h264_videotoolbox] Error copying packet data: -1094995529
```

The encoder's `-a53cc` option defaults to **true**. These recordings carry closed
captions (`qualifiers: ["cc"]`), FFmpeg extracts them as A/53 side data, and
VideoToolbox fails re-injecting them as SEI. A synthetic source encoded fine,
which is what isolated it. No filter, pixel format, or scaling change helps —
only disabling caption passthrough.

Consequence: closed captions are dropped on the hardware path. Recovering them
would mean muxing captions as a separate track rather than embedded SEI.

---

## Risks

| Risk | Handling |
|---|---|
| `-force_key_frames` not honored exactly → segment count drift | Gate the whole mode on verification step 1; keep x264 the default |
| Quality worse at a given size — VideoToolbox is weaker than x264 per bit | `TRANSCODE_QUALITY` exposed; measure before defaulting |
| Host ffmpeg version drift | Log `ffmpeg -version` and the selected encoder at startup |
| Native backend bypasses container isolation | Bind 127.0.0.1 only; document that the auth gap from the security audit applies more sharply here |
| Two supported deployments to maintain | Container path stays the default and is what CI builds; native is documented opt-in |

## Out of scope

- HEVC or AV1 output. AV1 is the wrong trade here regardless — see the
  measurements in the recording-playback work; encode time, not bitrate, is the
  constraint, and the MPEG-TS segment container cannot carry AV1 without moving
  to fMP4.
- Hardware **decode** of the MPEG-2 source. Worth investigating separately —
  decode may be a meaningful share of the per-window cost.
- launchd/service integration.
- Any change to the cache, playlist, or window model. This swaps an encoder and
  nothing else.
