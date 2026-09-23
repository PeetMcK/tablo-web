# A self-contained macOS `.app` — design

**Date:** 2026-09-23
**Status:** design only, nothing built
**Depends on:** `2026-09-15-macos-hardware-transcode-design.md`
**Touches:** `backend/app/main.py`, `backend/app/transcode_cache.py`,
`backend/app/routes/stream.py`, `backend/app/routes/iptv.py`, new
`packaging/` tree, `CLAUDE.md`, `.claude/skills/tablo-stack/`

---

## What this is, and what makes it plausible

Today the app is two halves that have to be started in the right order with
the right compose files, and `CLAUDE.md` opens with a warning about what
happens when they are not. The goal here is one icon: no Docker, no Homebrew,
no `run-native.sh`.

The reason this is a small job rather than a rewrite is that the hard part
already happened for another reason. `2026-09-15-macos-hardware-transcode-design.md`
moved the backend out of the container and into a native macOS process, because
Apple does not pass the Media Engine into Docker's Linux VM. That process is
already what a `.app` wants to contain. The data directory is already
`~/Library/Application Support/tablo-web`, already chosen over Caches so macOS
cannot purge kept recordings, and needs no change at all.

**What is left in Docker is nginx**, and what nginx does is:

| | |
|---|---|
| Serve `frontend/dist` | 3.9 MB of static files |
| Proxy `/api` to the backend | `default.conf.template` |
| Buffer the download route | a measured workaround, 210 MB/s direct against 102 MB/s proxied |

Inside one process, all three stop existing. FastAPI serves the files, there is
no proxy, and the download route is direct - so the buffering tuning it needed,
and the IPv6/resolver comment above it, become dead weight rather than
something to port.

---

## The shape

```
Tablo.app/Contents/
  MacOS/Tablo               tiny launcher (Swift), menu-bar agent
  Resources/
    backend/                PyInstaller onedir output
    web/                    frontend/dist
    ffmpeg, ffprobe         static, LGPL, no x264
```

The launcher starts the backend on a loopback port, waits for it to answer,
opens the browser, and sits in the menu bar with Open / Quit. The backend is a
child process, so quitting kills it.

---

## Step 1 — FastAPI serves the frontend

Worth doing on its own merit, before any packaging: it removes Docker from the
dev loop and deletes the failure mode `CLAUDE.md` warns about.

Every API route is under `/api` - checked, all eleven routers carry that
prefix, `stream` via `include_router(..., prefix="/api")` - so a static mount
at `/` cannot collide with one. Mounted after the routers, with an SPA
fallback so client-side routes (`#/library/rec/74778`) survive a reload.

The web root is a bundled path in the `.app` and a repo path in development,
so it is an environment variable with a sensible default rather than a
constant.

`allow_origins=["*"]` in `main.py` exists because the frontend was served from
a different origin. Same-origin serving makes it unnecessary; it should narrow
or go, which is a small security improvement carried along for free.

---

## Step 2 — Bundle Python

`backend/.venv` is 95 MB and holds **eight native extensions** - pydantic-core,
uvloop, cryptography's `_cffi_backend`, watchfiles' Rust notifier, websockets'
speedups, PyYAML, charset-normalizer. That rules out anything that expects pure
Python, and it is exactly what PyInstaller's onedir mode handles.

**PyInstaller 6.22.3 supports Python 3.14** (`requires_python <3.16,>=3.8`,
3.14 in its classifiers), which was the one thing that could have blocked this
outright - the backend runs 3.14.

Known work:

- FastAPI and uvicorn need hidden imports; uvicorn's `[standard]` extras pull
  `uvloop`, `httptools` and `websockets` in dynamically.
- `tablo-api` is a third-party package whose data files, if any, need
  collecting.
- The lifespan migrations in `main.py` read paths from `state.py`; those must
  resolve against Application Support, not the bundle, or the first launch
  writes inside the `.app` and breaks on the next update.

---

## Step 3 — Bundle FFmpeg

The fiddly one, and the one with a licence trap.

Homebrew's `ffmpeg` is a **420 KB binary against 36 dynamic libraries**.
Copying it means `dylibbundler` and `install_name_tool` rewriting every path.
A static build avoids all of that and is the recommendation.

**The licence point matters more than the linking.** This repo is MIT.
Homebrew's ffmpeg is built `--enable-gpl --enable-libx264`, and shipping that
inside a distributed app drags GPL obligations along with it.

It is also unnecessary, and not marginally so: **x264 is unreachable on macOS
and the bundle ships without it.** Decided 2026-09-23.

Separate the two things "H.264 support" can mean, because only one is GPL:

| | Licence | In the bundle |
|---|---|---|
| **libx264**, the encoder | GPL | **no** |
| FFmpeg's built-in **h264 decoder** | LGPL | yes, and needed - previews and thumbnails decode H.264, and so does anything the box encoded itself |

Nothing on this path can reach the encoder. `run-native.sh` pins
`h264_videotoolbox`; when the Media Engine is unavailable the profile's own
`-allow_sw 1` falls back to *VideoToolbox's* software encoder rather than to
x264; and a `.app` has no container, which is the only place `libx264` was
ever the answer. The rest of what FFmpeg does here - MPEG-2 decode, `bwdif`,
`scale`, AAC encode, `h264_videotoolbox` - is built in and none of it is GPL.

Two consequences for the code:

- `video_encoder()` defaults to `"libx264"`, chosen when the container was the
  normal case. In the bundle that default is a silent path to an encoder that
  is not there, so the bundled build must default to `h264_videotoolbox` and
  fail loudly rather than fall back to nothing.
- The `libx264` profile itself stays in `_profiles()`. It costs nothing, it is
  still right for the Linux container, and `2026-09-22-hardware-encode-path-design.md`
  has sweeping its `-crf` as step one - this decision is about what the macOS
  *bundle* carries, not about removing support.

Six call sites hardcode the executable name:

```
transcode_cache.py:307   ffprobe   the interlace probe
transcode_cache.py:1344  ffmpeg    (thumbnail/preview)
transcode_cache.py:2109  ffmpeg    the window encode
routes/stream.py:949     ffmpeg
routes/stream.py:1335    ffmpeg    live
routes/iptv.py:277       ffmpeg
```

All six should resolve through one helper reading `FFMPEG_BIN`/`FFPROBE_BIN`,
defaulting to the bundled binaries when running from an `.app` and to `PATH`
otherwise. The `run-native.sh` preflight - which checks ffmpeg exists and has
`h264_videotoolbox` - becomes a startup check in the app, and its two error
messages ("install it with brew") need rewriting for a user who has no
terminal.

---

## Step 4 — The launcher

A menu-bar agent (`LSUIElement`), not a window:

- Pick a free loopback port rather than fixing 8000, and hand it to the
  backend. Two copies of the app, or a stray `run-native.sh`, must not fight
  over one port. The frontend calls `/api` relatively, so nothing needs to
  learn the number.
- Poll the backend until it answers, then open the browser at the port.
- Quit terminates the child. The backend already resumes kept downloads on
  boot, so a hard stop is recoverable, but an in-flight FFmpeg leaves a partial
  window - the existing `_startup_cleanup` sweep is what catches that, and it
  greps for a marker in the command line, so the bundled path must keep that
  marker (`test_live_ffmpeg_carries_the_marker_the_sweep_looks_for` pins it).

### Browser, not WKWebView

A WKWebView window would look more like an app, and it is the wrong call here
for a measured reason: **the WASM MPEG-2 path gates on a Chrome user agent**
(`wasmLiveEligible`, and the jsdom note in `pipResume.test.tsx` spells out that
neither WebGL2 nor OffscreenCanvas nor a Chrome UA is present). Under Safari's
engine the eligibility check says no and every MPEG-2 recording silently takes
the transcode path instead - slower, and it spends the Media Engine on work the
browser was doing for free.

So: open the user's own browser. A WKWebView shell is a later option, and only
after that path is re-tested under WebKit rather than assumed.

---

## What the `.app` costs

| | |
|---|---|
| Python runtime and deps | ~70 MB (from a 95 MB venv) |
| FFmpeg, static | ~80 MB |
| Frontend | 3.9 MB |
| **Total** | **~150-200 MB** |

---

## Signing, and who this is for

Ad-hoc signing is enough to run it on the machine that built it. Anything else
- another Mac, a download - needs a Developer ID signature and notarisation, or
Gatekeeper refuses it. That is an Apple Developer Program membership, and it is
worth deciding up front which of the two this is for, because it changes
whether hardened runtime and entitlements matter.

---

## What this does not solve

- **Windows and Linux.** Nothing here transfers except step 1. Those platforms
  need `2026-09-22-hardware-encode-path-design.md` first, and their own
  packaging after.
- **Updates.** No mechanism. Sparkle is the usual answer; out of scope.
- **The device on the network.** Unchanged - the app still discovers a Tablo
  and still needs the LAN.

---

## Work order

1. **FastAPI serves `dist`**, with the web root as an environment variable.
   No packaging, immediately useful, removes Docker from the dev loop.
2. **One resolver for the FFmpeg binaries** across all six call sites, plus a
   startup capability check with a message aimed at a user rather than a
   developer.
3. **PyInstaller onedir** for the backend, run from the terminal to prove it
   boots and transcodes before any bundle exists.
4. **Static LGPL FFmpeg**, no x264, dropped in beside it.
5. **The launcher and the bundle**, ad-hoc signed.
6. **Notarisation**, only if this leaves this machine.

Steps 1 and 2 stand on their own and improve the current setup whether or not
the bundle is ever built.
