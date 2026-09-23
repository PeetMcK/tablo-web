# The hardware encode path on Windows and Linux — design

**Date:** 2026-09-22
**Status:** design only, nothing verified against hardware
**Depends on:** `2026-09-15-macos-hardware-transcode-design.md`
**Touches:** `backend/app/transcode_cache.py`, `backend/app/routes/stream.py`,
`docker-compose.gpu.yml`, new compose overlays, `backend/run-native.sh`

---

## What this is for

macOS is done: the backend runs natively, VideoToolbox does the encoding, and
`2026-09-15-macos-hardware-transcode-design.md` measured why that split exists
at all. Everything below is the same problem on hardware nobody here has.

**Nothing in this document has been run.** The `h264_vaapi` and `h264_nvenc`
profiles already in `_profiles()` were written from FFmpeg's documented
pipelines and carry `UNVERIFIED` comments; `docker-compose.gpu.yml` carries the
same warning. This spec says what to measure and what shape the answers take,
so whoever has the hardware is not also doing the design.

---

## What is already portable

Three findings from the 2026-09-22 quality work are properties of H.264 and the
source, not of VideoToolbox, and every encoder inherits them:

| | |
|---|---|
| **B-frames and GOP** | `-bf 3 -g 600`, shared by every profile as `B_FRAME_FLAGS`. Without them the macOS encoder produced no B-frames and a keyframe every 12 frames: 7.77 MB where 5.12 MB carried the same 30s at a better SSIM. |
| **The 720 cap** | `height_cap_filter`. The device's own transcode beat ours while using fewer bits, because it covers a quarter of the pixel rate. 1080i is 1920×540 per field, so the lines above 720 are interpolated rather than broadcast. |
| **The interlace probe** | `probe_interlaced`, one `ffprobe` per recording. `bwdif=send_field` doubles the declared frame rate whatever it processes, and HLS is constant-rate, so on progressive channels half of every segment was a duplicate frame. |

These are already in the code and need no per-encoder work. What does not carry
is everything to do with **rate control**, below.

---

## The one number to hit

Sharpness is bits per pixel, and the target is the device's own figure:

| | Resolution | Rate | Bitrate | bits/px |
|---|---|---|---|---|
| Tablo's own transcode | 1280×720 | 29.97 | 1.98 Mbps | **0.0718** |
| Ours before this work | 1920×1080 | 59.94 | 2.49 Mbps | 0.0200 |
| Ours now (VideoToolbox, `-q:v 55`) | 1280×720 | 59.94 | 2.90 Mbps | 0.0524 |

`bits/px = bitrate / (width × height × fps)`. It is comparable across
encoders, resolutions and frame rates, which is exactly what a quality setting
is not — so **every encoder is tuned by sweeping its own quality knob until it
lands near 0.072, not by copying a number from another encoder.**

The scales are unrelated and two of them run backwards:

| Encoder | Knob | Direction | Our value |
|---|---|---|---|
| `h264_videotoolbox` | `-q:v` 1–100 | higher is better | 55 (measured) |
| `libx264` | `-crf` 0–51 | **lower** is better | 23 (never swept) |
| `h264_nvenc` | `-cq` 0–51 | **lower** is better | 23 (guess) |
| `h264_vaapi` | `-qp` 0–51 | **lower** is better | 23 (guess) |
| `h264_qsv` | `-global_quality` | **lower** is better | no profile exists |
| `h264_amf` | `-qp_i`/`-qp_p` | **lower** is better | no profile exists |

`TRANSCODE_QUALITY` overrides whichever knob the selected profile uses, so the
sweep needs no code change — only `_profiles()` defaults do.

### How to sweep

`/tmp` scripts were thrown away, so the method, not the file:

1. Take 30s of real MPEG-2 off the device (`POST /api/recordings/{id}/watch-vod`,
   then fetch ~30 segments and concatenate them).
2. Encode it with the **whole** chain — deinterlace as the probe decides,
   square pixels, height cap, encoder flags, `-force_key_frames` at 6s — and
   **write HLS, not MP4**. MP4 hides the duplicate-frame fault entirely,
   because it tolerates variable frame rate.
3. Read back `bitrate / (w × h × fps)` and compare to 0.072.
4. Confirm quality independently with SSIM against a `libx264 -qp 0` encode of
   the same clip. Bits per pixel is a budget, not a measurement of the result.

---

## Per-encoder open questions

### NVENC (NVIDIA, Linux and Windows)

- Takes software frames directly, so no upload filter. The existing profile is
  `-preset p4 -cq 23 -rc vbr`; `p4` is the middle of p1–p7 and unmeasured.
- **B-frames:** supported on Turing and later, *not* on Maxwell/Pascal for
  H.264. `-bf 3` on a card that cannot do it is silently ignored or refused —
  check the frame types in the output, do not trust the absence of an error.
- Needs the NVIDIA Container Toolkit for Docker; bare metal needs only the
  driver.

### VAAPI (Intel and AMD, Linux only)

- The pipeline is already shaped in `_profiles()`: `-vaapi_device` before the
  input, `format=nv12,hwupload` at the **end** of the filter chain, and
  `pix_fmt` unset because the frames are on the GPU by then. That ordering is
  load-bearing and `test_the_cap_runs_after_the_squaring` pins it.
- **B-frames:** driver-dependent, and absent from Intel's low-power (`VDENC`)
  path, which is what many iGPUs default to. Measure frame types.
- Needs `/dev/dri` in the container (`docker-compose.gpu.yml` does this) and
  the right driver package: `intel-media-va-driver-non-free` for Intel,
  `mesa-va-drivers` for AMD. The container image must carry one.

### QSV (Intel, Windows and Linux)

No profile exists. On Linux it is an alternative front-end to the same silicon
VAAPI drives; on Windows it is the only Intel option. Needs `-load_plugin` on
older parts and its own upload filter (`hwupload=extra_hw_frames=64`).

### AMF (AMD, Windows)

No profile exists. Windows-only; AMD on Linux goes through VAAPI.

### The container question

On macOS the backend must run natively because Apple does not pass the Media
Engine into Docker's Linux VM — that is the whole reason for the split
documented in `CLAUDE.md` and the `tablo-stack` skill. **On Linux that
constraint disappears**: `/dev/dri` and the NVIDIA runtime both cross into a
container. So a Linux deploy can put the backend back in Compose and the
two-halves warning in `CLAUDE.md` does not apply there. Windows has no
equivalent — Docker Desktop's WSL2 backend does not expose AMF or QSV, so
Windows means a native process, as macOS does.

---

## Detection, instead of an environment variable

`TRANSCODE_VIDEO_ENCODER` is set by hand today: `run-native.sh` pins
`h264_videotoolbox`, `docker-compose.gpu.yml` pins `h264_vaapi`, and
`video_encoder()` falls back to `libx264`. That is fine for two known hosts and
wrong for a distributable build.

**`ffmpeg -encoders` is not evidence.** Every encoder is compiled into the
image whether or not a device exists behind it — the macOS spec measured
exactly that, with `h264_nvenc`, `h264_vaapi` and `h264_vulkan` all listed and
all inert. The only proof is an encode:

```
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 30 \
       -c:v <candidate> <its flags> -f null -
```

Run once at startup, in a preference order (platform-appropriate hardware
first, `libx264` last), take the first that exits zero, log which and why.
Roughly a second per candidate, once per process.

Two failure modes to respect, both seen in this codebase already:

- **It can succeed and still be wrong.** `-a53cc` defaults to true on
  VideoToolbox and kills the encode outright on caption-carrying OTA streams
  ("Unexpected end of SEI NAL Unit parsing size"). A trial encode of `testsrc2`
  carries no captions and would pass. Probe with the flags the real path uses.
- **It can succeed and be slower than software.** A trial encode says a device
  answers, not that it is fast. Live needs ≥1.0× realtime or playback stalls;
  worth timing the trial and refusing a hardware encoder that comes in under
  software.

---

## Live, which is not the same problem

`live_ffmpeg_cmd` deliberately overrides the shared profile after `prof.flags`,
where FFmpeg lets the last option win:

- `-bf 0` — B-frames make the encoder hold frames back, and live has no slack
  above realtime.
- `-q:v 40` (VideoToolbox only) — the recordings profile was raised to 55 for
  the device's sharpness at ~3× the bitrate. A recording is written once and
  read later; live is pushing bits at a player in real time.
- `-g 60`, and `deinterlace_filter(default="frame")` — 30p, because field mode
  measured 0.9× realtime against ~1.8× in frame mode.

**Every hardware encoder needs its own version of those three overrides**, and
the `-q:v` one is currently gated on `prof.name == "h264_videotoolbox"`
precisely because the knob differs. Adding an encoder without revisiting this
silently gives live the recordings bitrate.

---

## Captions

`-a53cc 0` is a VideoToolbox workaround, not a general setting. Unknown for
every other encoder: whether they re-inject A/53 captions correctly, whether
they need the same guard, or whether they drop captions silently. The window
logs also carry `cc_fifo cannot transcode captions` from `bwdif` at a doubled
frame rate — that message should disappear on progressive channels now the
filter is skipped, and is worth re-checking on an interlaced one.

---

## Work order

1. **Sweep `-crf` for x264.** No hardware needed, and it is the fallback every
   platform lands on. 23 has never been measured against 0.072 bits/px.
2. **Detection with a trial encode**, plus the timing check. Also no hardware
   needed to write; testable with a deliberately broken candidate.
3. **One real GPU**, whichever is available first: verify the existing VAAPI or
   NVENC profile end to end, sweep its knob, check frame types for B-frames,
   check captions, then delete its `UNVERIFIED` comment.
4. **Live overrides** for that encoder, with a realtime measurement.
5. **QSV and AMF profiles**, which are new code rather than verification.

Steps 1 and 2 are worth doing here. Everything from 3 needs the hardware.

---

## What would make this spec wrong

- If a hardware encoder cannot hit 0.072 bits/px at a sane bitrate — fixed
  function encoders are less efficient than x264 at the same quality, and the
  gap is largest at low bitrates. The answer would be a higher bitrate on
  hardware, not a worse picture, and the trade should be measured rather than
  assumed.
- If B-frames turn out unavailable on the target part. Then that encoder's
  output is roughly a third larger for the same picture, and the 720 cap
  matters more than it does here.
