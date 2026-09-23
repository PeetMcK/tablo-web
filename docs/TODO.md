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

## A self-contained macOS `.app`

**Spec:** `docs/superpowers/specs/2026-09-23-macos-app-bundle-design.md`
(design only, nothing built)
**Plan:** not written
**Branch:** none

One icon instead of two halves started in the right order with the right
compose files. Most of it is already done and was done for another reason: the
backend is a native macOS process because Apple will not pass the Media Engine
into Docker's Linux VM, and that process is what a bundle wants to contain.
The data directory is already Application Support and needs no change.

What is left in Docker is nginx — serving 3.9 MB of static files, proxying
`/api`, and buffering the download route. Inside one process all three stop
existing.

The two steps worth doing regardless of whether the bundle is ever built:
serve `frontend/dist` from FastAPI (removes Docker from the dev loop, and with
it the wrong-backend failure mode `CLAUDE.md` opens with), and resolve the
FFmpeg binaries through one helper instead of six hardcoded `"ffmpeg"` strings.

Decided 2026-09-23: **the floor is macOS 11 Big Sur**, and the app icon is
built and committed already (`packaging/AppIcon.icon`, compiled by
`packaging/build-icon.sh`). The floor constrains every bundled binary, not just
our code - the Python runtime and its eight native wheels and the static FFmpeg
all have to run there - and it leaves one question open: Big Sur runs on Intel
too, so the bundle is either universal2 or the requirement says "Apple Silicon"
out loud.

Decided 2026-09-23: **the bundle ships an LGPL FFmpeg with no x264.** Homebrew's
is built `--enable-gpl --enable-libx264` against an MIT repo, and on macOS the
encoder is unreachable anyway - VideoToolbox is pinned, its own `-allow_sw 1`
is the fallback, and a `.app` has no container. FFmpeg's built-in h264
*decoder* is LGPL and stays; previews need it. The `libx264` profile stays in
the tree for the Linux container.
