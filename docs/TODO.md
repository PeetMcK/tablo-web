# TODO

Work that is designed or decided but not yet built. A spec here means the
design is settled; it does not mean an implementation plan exists.

## Fill a blank channel from a listings feed

**Spec:** `docs/superpowers/specs/2026-09-21-epg-gap-fill-design.md` (approved)
**Plan:** not written
**Branch:** `worktree-epg-gap-fill`

13.5 THENEST and 7.4 KIDS carry a synthetic `S999…` identifier and zero
airings, and the device will never list them. IPTV-EPG's free US feed has The
Nest. Point a blank channel at a feed channel, confirm the match against
what's actually on screen, and fill the grid — show-only, since an imported
airing has no `airing_path` for the device to schedule against.

Next step is the implementation plan. It starts at the schema V10 migration;
the one open question the spec carried (are feed channel ids durable?) was
answered yes on 2026-09-21, so nothing blocks it.

## Hardware encoding on Windows and Linux

**Spec:** `docs/superpowers/specs/2026-09-22-hardware-encode-path-design.md`
(design only, nothing verified against hardware)
**Plan:** not written
**Branch:** none

macOS is done and measured. The `h264_vaapi` and `h264_nvenc` profiles in
`_profiles()` were written from FFmpeg's documented pipelines and have never
been run; `docker-compose.gpu.yml` carries the same warning. QSV and AMF have
no profile at all.

The 2026-09-22 quality work carries over for free — B-frames, the 720 cap and
the interlace probe are properties of H.264 and the source, not of
VideoToolbox. What does not carry is rate control: every encoder's quality
knob is on its own scale and two of them run backwards, so each one has to be
swept against the portable target of 0.072 bits per pixel.

Two steps need no hardware and are worth doing first: sweeping `-crf` for
x264, which is the fallback every platform lands on and has never been
measured, and replacing `TRANSCODE_VIDEO_ENCODER` with a startup trial encode.
`ffmpeg -encoders` is not evidence — the macOS spec measured every hardware
encoder listed and inert.
