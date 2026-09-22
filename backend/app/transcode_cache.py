"""Window-addressed transcode cache for recordings.

Recordings are MPEG-2 (the Gen 4 hardware has no encoder and stores the raw ATSC
stream), which no browser can decode, so playback requires a transcode. They are
also immutable once ``video_details.state == "finished"``, so the output is
cached on ``/data`` and reused rather than re-encoded per view.

The recording is divided into fixed windows of ``WINDOW_SECONDS``. Each window is
transcoded independently with ``-ss``/``-t``, which has two consequences:

* **The playlist can be published complete before anything is encoded.** Window
  count and segment count are pure functions of the source duration, so the
  player sees the whole timeline immediately and can seek anywhere.
* **Windows can be filled in any order and in parallel.** Seeking into a cold
  region transcodes just that window; a background filler works through the rest.

Measured on a Tablo 4G QUAD: seeking into the device's HLS source costs a flat
~5s regardless of offset, and encoding runs at ~0.44s per second of output. A
lone 6s segment would therefore be ~83% startup overhead, which is why the unit
of work is a 60s window rather than a single segment.
"""

from __future__ import annotations

import asyncio
import bisect
import contextlib
import math
import os
import shutil
import signal
import struct
import time
import urllib.request
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from urllib.parse import urljoin

from . import store
from .vod_index import parse_vod_playlist

CACHE_ROOT = Path(os.environ.get("TRANSCODE_CACHE_DIR", "/data/cache/recordings"))
CACHE_BUDGET_BYTES = int(float(os.environ.get("TRANSCODE_CACHE_GB", "250")) * 1024**3)

SEGMENT_SECONDS = 6
WINDOW_SECONDS = 60
SEGMENTS_PER_WINDOW = WINDOW_SECONDS // SEGMENT_SECONDS

# Independent windows can encode concurrently. Kept well below the core count so
# a background fill cannot starve an on-demand seek, which shares this machinery.
#
# This is a GLOBAL budget, not per-recording. Three offline copies filling at
# once previously ran three encoders each - nine competing jobs, which dropped
# throughput from ~4.5x realtime to 0.7x and made every fill crawl.
PREFETCH_CONCURRENCY = int(os.environ.get("TRANSCODE_CONCURRENCY", "3"))

# Software x264 by default.
#
# No hardware encoder is reachable inside the container on Apple Silicon:
# VideoToolbox is a macOS framework and is not exposed to a Linux guest, and
# there is no /dev/dri node for VAAPI. Running the backend natively on macOS is
# what makes h264_videotoolbox available - see
# docs/superpowers/specs/2026-09-15-macos-hardware-transcode-design.md
# Read at call time rather than import time, so the selection is testable
# without reloading this module - which would swap out the classes below for
# fresh objects and break anything holding a reference to them.
def video_encoder() -> str:
    return os.environ.get("TRANSCODE_VIDEO_ENCODER", "libx264")


@dataclass(frozen=True)
class EncoderProfile:
    """See ``encoder_profile``."""

    """Everything an encoder needs, not just its name.

    Hardware encoders differ in more than the codec: VAAPI needs the device
    opened before the input and frames uploaded to it by a filter, and rejects
    the software pixel format. Rate control differs too - `-maxrate`/`-bufsize`
    are x264 concepts that other encoders ignore.
    """

    name: str
    flags: list[str]
    pre_input: list[str] = field(default_factory=list)
    filters: list[str] = field(default_factory=list)
    # Software pixel format. None where the encoder takes hardware frames.
    pix_fmt: str | None = "yuv420p"


def _profiles() -> dict[str, EncoderProfile]:
    # Quality is interpreted per encoder: CRF for x264 (lower is better),
    # -q:v for VideoToolbox (1-100, higher is better), -qp for VAAPI.
    q = os.environ.get("TRANSCODE_QUALITY")
    # DRM render node, only meaningful on a Linux host with /dev/dri passed in.
    vaapi_device = os.environ.get("VAAPI_DEVICE", "/dev/dri/renderD128")
    return {
        "libx264": EncoderProfile(
            name="libx264",
            flags=["-preset", "veryfast", "-crf", q or "23",
                   "-maxrate", "4000k", "-bufsize", "8000k"],
        ),
        # macOS Media Engine. -realtime 0 lets it run flat out rather than pacing
        # to wall clock; -allow_sw 1 falls back to software instead of failing
        # outright when the engine is unavailable.
        # macOS Media Engine. Measured against libx264 -preset veryfast on the
        # same 60s window: CPU 47.4s -> 5.1s, output 30 MB -> 22 MB.
        #
        # -a53cc 0 is mandatory, not tuning. It defaults to true, and these
        # recordings carry closed captions; VideoToolbox fails re-injecting them
        # as SEI ("Unexpected end of SEI NAL Unit parsing size") and encodes
        # nothing at all.
        #
        # -realtime 0 lets it run flat out rather than pacing to wall clock;
        # -allow_sw 1 falls back to software instead of failing when the engine
        # is unavailable. q:v 40 was chosen by measurement - 55 produced files
        # two thirds larger than x264 for no visible gain.
        "h264_videotoolbox": EncoderProfile(
            name="h264_videotoolbox",
            flags=["-realtime", "0", "-allow_sw", "1", "-a53cc", "0",
                   "-q:v", q or "40", "-profile:v", "high"],
        ),
        # Intel/AMD on Linux. UNVERIFIED - no VAAPI hardware was available to
        # test against; the shape follows FFmpeg's documented VAAPI pipeline.
        "h264_vaapi": EncoderProfile(
            name="h264_vaapi",
            flags=["-qp", q or "23"],
            pre_input=["-vaapi_device", vaapi_device],
            filters=["format=nv12", "hwupload"],
            pix_fmt=None,
        ),
        # NVIDIA on Linux. UNVERIFIED. Takes software frames directly, so no
        # upload filter is needed.
        "h264_nvenc": EncoderProfile(
            name="h264_nvenc",
            flags=["-preset", "p4", "-cq", q or "23", "-rc", "vbr"],
        ),
    }


def should_retarget(here: int, filling: list[int], here_ready: bool = False) -> bool:
    """True when the playhead has left the windows currently being filled.

    A prefetch batch runs the best part of a minute, and the playhead used to be
    re-read only between batches - so seeking away left the fill grinding
    through windows nobody was going to watch. One window past the end is not a
    miss: that is simply where playback is heading next.

    Being *behind* the batch only counts when the viewer's own window is missing,
    which means they seeked back into a gap and are waiting on it. Otherwise the
    fill is simply ahead, which is the whole point of prefetching: ``filling``
    skips windows already on disk, so every batch after the first starts past
    the playhead. Treating that as a backwards seek killed the batch, recomputed
    an identical one from the same playhead, and killed that too - a livelock
    that froze the cache while playback rode a single on-demand window.
    """
    if not filling:
        return False
    if here > filling[-1] + 1:
        return True
    return here < filling[0] and not here_ready


def fill_limit(first: int, total: int) -> int:
    """Last window prefetch should reach, given the playhead is in ``first``.

    Defaults to the end of the recording: prefetch runs at roughly 10x realtime,
    so twenty minutes of watching encodes the rest of a three-hour game and
    every later seek lands in cache instead of waiting on a transcode.
    """
    if LOOKAHEAD_WINDOWS > 0:
        return min(total, first + LOOKAHEAD_WINDOWS)
    return total


def deinterlace_filter(env_var: str = "TRANSCODE_DEINTERLACE",
                       default: str = "field") -> list[str]:
    """Deinterlacing, applied before any encoder-specific filtering.

    ``env_var``/``default`` let callers pick their own default and override
    knob. Recordings default to ``field`` (60p, throughput can absorb it); live
    passes ``default="frame"`` (30p) because it must stay above realtime — see
    the note on why field halves encoder throughput and starved live playback.

    ATSC is split down the middle: ABC and FOX broadcast 720p60 progressive,
    CBS and NBC broadcast 1080i. Measured across six recordings off this
    antenna, KTMFABC and KTMFFOX came back 121/121 progressive while KPAX (CBS)
    and KECI (NBC) came back 121/121 top-field-first. Encoding those fields as
    if they were frames is what puts comb teeth on every moving edge.

    ``deint=interlaced`` processes only frames actually flagged interlaced, so
    the 720p60 channels pass through untouched and keep their frame rate. That
    matters more than it looks: with ``send_field`` an unconditional filter
    would double the rate of progressive content for nothing.

    Modes, measured on one 1080i window (VideoToolbox, 60s of output):

        off                   7.5s   27 MB   8.0x realtime
        frame  -> 29.97p      7.6s   27 MB   7.9x realtime   (combing gone, free)
        field  -> 59.94p     11.6s   48 MB   5.2x realtime   (true 60p motion)

    ``field`` is the default because 1080i carries 59.94 fields per second -
    half of them are discarded by ``frame``, which is why deinterlaced 1080i
    otherwise looks less fluid than the 720p60 channels beside it. Sports is
    exactly the content that shows it.

    bwdif over yadif: same cost here, visibly better on the diagonal edges that
    interlacing damages most.
    """
    mode = os.environ.get(env_var, default).lower()
    if mode in ("off", "none", "0", ""):
        return []
    if mode == "frame":
        return ["bwdif=mode=send_frame:parity=auto:deint=interlaced"]
    return ["bwdif=mode=send_field:parity=auto:deint=interlaced"]


def square_pixels_filter() -> list[str]:
    """Bake an anamorphic picture's real shape into its pixels.

    Broadcast SD is a 16:9 picture stored in a 4:3 grid with non-square pixels.
    The shape lives in the sample aspect, which MPEG-2 carries and H.264 keeps
    in its VUI - and which `h264_videotoolbox` throws away. Measured on
    704x480 with SAR 40:33:

        libx264              sample_aspect_ratio=40:33   display=16:9
        h264_videotoolbox    sample_aspect_ratio=N/A     display=N/A

    A player handed the second draws the coded 1.47, and everything in it is
    tall and thin - which is what Saturday Night Live looked like. It is the
    same fault `deinterlace.ts` fixes on the MPEG-2 path by sizing the canvas
    to the display shape (see 05b0153); this is the H.264 half, which was
    missed because x264 does carry it and the containerised backend uses x264.
    Only the native macOS path, which is the fast one and the default, is
    affected.

    `setsar` cannot help: it sets what the encoder then discards. So the
    correction goes into the pixel grid, where nothing downstream has to
    understand it - 704x480 becomes 852x480 and is simply 16:9.

    Free on HD. `iw*sar` is the width itself when the pixels are already
    square, so 1280x720 passes through unchanged; verified against the encoder.
    Widths are rounded to even because H.264 chroma subsampling requires it,
    which costs at most one column - 852 where 853 is exact, a tenth of a per
    cent.
    """
    return ["scale=trunc(iw*sar/2)*2:ih", "setsar=1"]


def encoder_profile() -> EncoderProfile:
    """Full FFmpeg configuration for the selected encoder."""
    name = video_encoder()
    return _profiles().get(
        name,
        EncoderProfile(name=name, flags=["-crf", os.environ.get("TRANSCODE_QUALITY", "23")]),
    )


VIDEO_BITRATE_BPS = 4_000_000
MIN_FREE_BYTES = 2 * 1024**3

# How long a caller will wait for a cold window before giving up.
WINDOW_WAIT_TIMEOUT = 120

# A single cold segment is measured at ~8-9s (device seek, then one segment of
# encoding). Waiting the full window timeout for one instead means the client's
# fragment timeout fires first, and it responds by requesting somewhere else -
# which starts yet another encode. Failing early enough for hls.js to retry the
# same segment keeps that from compounding.
SEGMENT_WAIT_TIMEOUT = 25

# Distinct windows a viewer may have in flight at once.
#
# On-demand work is deliberately outside the prefetch semaphore - someone
# waiting should not queue behind background filling - but it was previously
# unbounded, and _reap_abandoned only collects windows whose waiter has already
# gone. A client holding many requests open at once therefore evaded both:
# 105 concurrent windows were observed, each with its own FFmpeg and its own
# device session, which saturated the host and starved every request past its
# timeout. A viewer can only be in one place, so anything beyond the newest few
# requests is a client storm; the oldest is dropped to make room.
MAX_ONDEMAND_WINDOWS = int(os.environ.get("TRANSCODE_MAX_ONDEMAND", "8"))

# And per recording. Scrubbing away from a cold spot has to abandon it at once,
# or the encoder stays busy with somewhere the viewer has already left and the
# new target queues behind it. Two, so ordinary playback can hold the window it
# is in plus the one it is about to reach.
# Two was too tight: a seek costs a window or two on its own, so a couple of
# clicks tripped the cap and killed work the viewer still wanted. Four abandons
# a genuinely stale scrub target while leaving room to click around.
MAX_ONDEMAND_PER_RECORDING = int(os.environ.get("TRANSCODE_MAX_ONDEMAND_PER_REC", "4"))

# How long a background fill defers to a viewer's request before going ahead.
ONDEMAND_YIELD_SECONDS = float(os.environ.get("TRANSCODE_ONDEMAND_YIELD", "6"))

# Seconds decoded before the window's real start and then discarded.
#
# `-ss` before `-i` is a fast seek: it jumps to the nearest point at or before
# the target and starts decoding there, which on MPEG-2 is usually mid-GOP. The
# resulting frames reference an I-frame that was never decoded, so the window
# opens with visible corruption and the player can stall on it. Seeking a little
# early and discarding the difference gives the decoder a clean run-up.
SEEK_PREROLL = 3.0

# Windows to keep encoded ahead of the playhead while watching. 0 means the
# rest of the recording.
#
# This was capped at 30 because filling eagerly once pinned every core long
# after playback stopped - but that was libx264 at 780% of 1000%. On hardware
# the same fill costs ~78%, and the encoder is bound by the device rather than
# the CPU, so there is nothing left to protect by stopping early. What actually
# prevents a runaway is the idle watchdog below plus release-on-close, both of
# which still apply.
#
# The point of filling the whole thing: prefetch runs at roughly 10x realtime,
# so twenty minutes of watching encodes the rest of a three-hour game, and every
# seek after that lands in cache instead of waiting on a transcode.
LOOKAHEAD_WINDOWS = int(os.environ.get("TRANSCODE_LOOKAHEAD_WINDOWS", "0"))

# Prefetch stops if the viewer has not checked in for this long, so closing the
# tab cannot leave encoders running.
WATCH_IDLE_TIMEOUT = 45

# BIF is Roku's scrub-preview format, which the Tablo already serves.
_BIF_MAGIC = b"\x89BIF\r\n\x1a\n"
_BIF_SENTINEL = 0xFFFFFFFF

# How long a device saying "no pack" is taken at its word.
#
# Two recordings get that answer: one still being written, and one the device
# never built a snap grid for at all (a damaged capture - `clean: false`,
# `size: 0`). The first becomes available within about five minutes of the
# recording ending, and the second never does, so the answer is remembered
# rather than final: long enough that a scrub costs one device round-trip
# instead of forty, short enough that a pack published later is still picked up.
BIF_REFUSAL_TTL = 300


def _http_get(url: str, timeout: int = 120) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def _http_get_range(url: str, first: int, last: int, timeout: int = 180,
                    on_bytes: "Callable[[int], None] | None" = None) -> bytes:
    """One byte range of one device file, inclusive of both ends.

    The device publishes a recording as byte ranges of a handful of large
    files, so a whole window is usually one contiguous read. That matters: a
    window is sixty one-second segments, and asking for them one at a time is
    sixty round trips the box answers slowly under load - measured 2026-09-22,
    sixteen concurrent segment readers pushed its ping from 3ms to 85ms and the
    fill *down* to 4.3 Mb/s, while a single bulk range read held 41 Mb/s.

    Read in chunks rather than in one call so `on_bytes` sees the transfer as
    it happens. Counting only completed windows made a step function out of a
    smooth thing: a window's bytes all landed on the instant it finished, and
    the readout jumped however steady the wire was.
    """
    req = urllib.request.Request(url, headers={"Range": f"bytes={first}-{last}"})
    out = bytearray()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        while True:
            chunk = r.read(TRANSFER_CHUNK)
            if not chunk:
                break
            out += chunk
            if on_bytes is not None:
                on_bytes(len(chunk))
    return bytes(out)


# Completed windows kept for the throughput readout.
#
# Enough to cover RATE_WINDOW_SECONDS at any plausible speed: windows finish in
# clumps of however many run at once, and a copied window can take a couple of
# seconds, so thirty seconds of a fast fill is dozens of them. Older samples
# cost a little memory and are ignored by the arithmetic below.
RATE_SAMPLES = 64

# The stretch of time the readout describes.
#
# Windows land in bursts - several finish within a second or two, then nothing
# for ten seconds while the next lot run - so measuring "the last few samples"
# swings wildly depending on where in that cycle the question is asked.
# Counting what a fixed stretch produced is steady by construction, and thirty
# seconds is long enough to contain a few bursts without being so long that a
# download slowing down takes a minute to show it.
RATE_WINDOW_SECONDS = 30.0

# How much of a range read to take at a time. Big enough that the syscalls are
# irrelevant beside the network, small enough that a 15 MB window is a few
# dozen samples rather than one.
TRANSFER_CHUNK = 512 * 1024

# Chunks kept for the transfer readout. Thirty seconds of a fast fill at half a
# megabyte a chunk is a few thousand; this bounds that without truncating the
# window at any rate worth reporting.
TRANSFER_SAMPLES = 8192

# Readings of how much content a transcode has produced, kept for the rate
# that feeds its estimate. One is taken per query, which the library makes
# every couple of seconds, so this covers the window comfortably.
PRODUCED_SAMPLES = 256

# No window has landed in this long, and nothing is encoding, so report idle
# rather than a stale average.
#
# Generous on purpose: a sample is only recorded when a window *finishes*, and
# a window takes 35-40s on CPU (longer on a slow device seek). A threshold near
# that makes the readout blink out between completions even though the download
# is running steadily. An active encoder overrides this entirely.
RATE_IDLE_AFTER = 180.0


def eta_seconds(duration: float, cached: float, realtime: float) -> float | None:
    """How long an offline copy still has to run, or None where nothing honest
    can be said.

    `realtime` is output seconds per wall second - the same figure the card
    shows as "5.5x" - so this is the remaining content divided by it. The
    frontend renders the same arithmetic; keeping it here too is what lets the
    log say what the screen says, and what makes a prediction checkable against
    the clock afterwards.
    """
    if not (duration > 0) or not (realtime > 0):
        return None
    # Windows overrun their nominal length, so what is cached can pass the
    # recording's duration. That is finished, not negative time remaining.
    return max(0.0, duration - cached) / realtime


class CacheState(str, Enum):
    ABSENT = "absent"
    PARTIAL = "partial"
    COMPLETE = "complete"
    FAILED = "failed"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class CacheMeta:
    object_id: int
    path: str
    source_duration: int = 0
    #: What the device said this recording's video is: "h264" for one the box
    #: encoded itself, "mpeg2" for a broadcast passed through, None where it
    #: said something nobody has seen. An H.264 source is copied rather than
    #: re-encoded - the offline copy is trying to produce exactly what the
    #: device already holds - and everything else takes the encoder.
    source_codec: str | None = None
    #: What the device says this recording weighs. A copied recording lands at
    #: that size - nothing is re-encoded - so it is what the progress and the
    #: estimate are really about. None for anything the device did not say.
    source_bytes: int | None = None
    created_at: str = field(default_factory=_now)
    last_access: str = field(default_factory=_now)
    error: str | None = None
    # Kept offline on purpose: exempt from LRU eviction, and removable only by an
    # explicit user action.
    pinned: bool = False
    # Snapshot of the library fields, so a pinned recording still renders after
    # the Tablo has deleted it and it no longer appears in /recordings/airings.
    info: dict | None = None
    # Paused offline copy: still wanted, just not being worked on right now.
    paused: bool = False


class CacheFull(RuntimeError):
    """Raised when a job cannot start without evicting an in-progress transcode."""


class InsufficientDisk(RuntimeError):
    """Raised when free space is too low to safely start a transcode."""


def window_count(duration: int) -> int:
    return max(1, math.ceil(duration / WINDOW_SECONDS))


def window_length(duration: int, w: int) -> float:
    """Seconds covered by window ``w``. The final window is usually short."""
    return min(WINDOW_SECONDS, max(0.0, duration - w * WINDOW_SECONDS))


def segments_in_window(duration: int, w: int) -> int:
    return max(1, math.ceil(window_length(duration, w) / SEGMENT_SECONDS))


class TranscodeCache:
    """Owns the lifecycle of cached recording transcodes.

    ``session_starter`` is injected rather than imported so this module carries no
    device-auth concerns and can be tested without a Tablo. It takes a recording
    path and returns the device's watch response (``playlist_url``, ...).
    """

    def __init__(
        self,
        session_starter: Callable[[str], Awaitable[dict]],
        root: Path = CACHE_ROOT,
        budget_bytes: int = CACHE_BUDGET_BYTES,
    ) -> None:
        self._start_session = session_starter
        self.root = root
        self.budget = budget_bytes
        # In-flight window encodes, keyed (object_id, window).
        self._window_jobs: dict[tuple[int, int], asyncio.Task] = {}
        self._prefetch: dict[int, asyncio.Task] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        # Windows requested by a viewer rather than by the background filler.
        # A dict rather than a set purely for insertion order, so the oldest
        # claim can be identified when the limit is reached.
        self._ondemand: dict[tuple[int, int], None] = {}
        # Live encoder processes, so background ones can be suspended while a
        # viewer waits. Declining to start new prefetch windows is not enough:
        # the ones already running keep the CPU busy for their full duration.
        self._procs: dict[tuple[int, int], tuple[object, bool]] = {}
        # object_id -> (playhead seconds, monotonic time of last heartbeat)
        self._watch: dict[int, tuple[float, float]] = {}
        # object_id -> recent (finished at, bytes written, encode seconds,
        # output seconds). Sampled per completed window rather than by polling
        # the directory, which is an rglob over every segment.
        self._rate: dict[int, deque[tuple[float, int, float, float]]] = {}
        # Parsed BIF indices, so a scrub does not re-read the header per frame.
        self._bif_cache: dict[int, list[tuple[int, int, int]]] = {}
        # object_id -> when the device last offered no pack for it. See
        # BIF_REFUSAL_TTL.
        self._bif_refused: dict[int, float] = {}
        # Shared across every prefetch loop. Created lazily: there is no running
        # event loop at import time.
        self._prefetch_slots: asyncio.Semaphore | None = None
        #: When the current run of windows began, per recording, so the line
        #: printed at the end can be compared against the estimates printed
        #: along the way. Cleared when the copy completes.
        self._fill_started: dict[int, float] = {}
        #: Bytes off the wire, as they land: (when, how many). This is the
        #: transfer itself rather than the windows made out of it, which is
        #: what makes the throughput readout steady and the estimate honest.
        self._bytes: dict[int, deque[tuple[float, int]]] = {}
        #: Recent answers from `entry_bytes`, which walks every file a cache
        #: entry owns. Progress and the estimate both ask for it, and the
        #: library asks for those every couple of seconds per card - a 142
        #: window copy is ~1400 files, so without this a listing would stat
        #: hundreds of thousands of times a minute.
        self._bytes_seen: dict[int, tuple[float, int]] = {}
        #: Readings of content produced, for a transcode's estimate: (when,
        #: seconds of output that existed then).
        self._produced: dict[int, deque[tuple[float, float]]] = {}
        # Directory creation is lazy: this object is constructed at import time,
        # and CI imports the app on a runner with no /data volume.

    # ------------------------------------------------------------------
    # Layout
    # ------------------------------------------------------------------

    def dir_for(self, object_id: int) -> Path:
        return self.root / str(int(object_id))

    def window_dir(self, object_id: int, w: int) -> Path:
        return self.dir_for(object_id) / f"w{int(w):05d}"

    def read_meta(self, object_id: int) -> CacheMeta | None:
        try:
            row = store.read_recording(object_id)
        except Exception:
            return None
        return CacheMeta(**row) if row else None

    def write_meta(self, meta: CacheMeta) -> None:
        # The directory is still created here: the encoded segments and the
        # per-window .done markers live on disk, and only the metadata moved.
        self.dir_for(meta.object_id).mkdir(parents=True, exist_ok=True)
        store.write_recording(asdict(meta))

    def _lock(self, object_id: int) -> asyncio.Lock:
        return self._locks.setdefault(object_id, asyncio.Lock())

    # ------------------------------------------------------------------
    # Window readiness
    # ------------------------------------------------------------------

    def window_ready(self, object_id: int, w: int) -> bool:
        """A window is ready when its marker exists.

        A marker file rather than a metadata field: windows complete out of order
        and concurrently, and a shared JSON document would need locking on every
        completion.
        """
        return (self.window_dir(object_id, w) / ".done").exists()

    def windows_done(self, object_id: int) -> int:
        d = self.dir_for(object_id)
        if not d.exists():
            return 0
        return sum(1 for m in d.glob("w*/.done"))

    def state(self, object_id: int) -> CacheState:
        meta = self.read_meta(object_id)
        if meta is None:
            return CacheState.ABSENT
        total = window_count(meta.source_duration)
        done = self.windows_done(object_id)
        if done >= total:
            return CacheState.COMPLETE
        active = bool(self._prefetch.get(object_id)) or any(
            k[0] == object_id for k in self._window_jobs
        )
        # A recorded error means a stopped download that could not finish — show
        # it FAILED at any progress (a 92%-then-source-gone keep still needs a
        # Resume). While work is actively running the error is cleared, so an
        # in-flight fill reads PARTIAL, not FAILED.
        if meta.error and not active:
            return CacheState.FAILED
        return CacheState.PARTIAL

    def progress(self, object_id: int) -> float:
        meta = self.read_meta(object_id)
        if meta is None or not meta.source_duration:
            return 0.0
        if meta.source_bytes:
            # A copy lands at the size the device reports, so the fraction on
            # disk is the real answer - and it moves continuously rather than
            # in steps of one window.
            return min(1.0, self.entry_bytes_cached(object_id) / meta.source_bytes)
        # Content produced, not windows finished: the same evidence the
        # estimate uses, so the bar and the time agree - and it moves every six
        # seconds rather than once a minute.
        return min(1.0, self.produced_seconds_sampled(object_id) / meta.source_duration)

    def cached_ranges(self, object_id: int) -> list[list[float]]:
        """Encoded regions as merged [start, end] second ranges.

        Windows fill in whatever order the viewer asks for, so a single
        "percent complete" figure cannot say *where* the cache is. Seeking an
        hour in leaves the opening minutes cached and adds a separate island.
        """
        meta = self.read_meta(object_id)
        if meta is None:
            return []
        done = sorted(
            int(m.parent.name[1:])
            for m in self.dir_for(object_id).glob("w*/.done")
        )
        ranges: list[list[float]] = []
        for w in done:
            start = w * WINDOW_SECONDS
            end = start + window_length(meta.source_duration, w)
            if ranges and abs(ranges[-1][1] - start) < 0.001:
                ranges[-1][1] = end
            else:
                ranges.append([start, end])
        return ranges

    def cached_seconds(self, object_id: int) -> float:
        return sum(e - s for s, e in self.cached_ranges(object_id))

    def produced_seconds_sampled(self, object_id: int) -> float:
        """`produced_seconds`, recording the reading for the rate.

        The library asks for progress every couple of seconds, which is a
        better cadence than anything this module could schedule for itself.
        """
        produced = self.produced_seconds(object_id)
        self._note_produced(object_id, produced)
        return produced

    def produced_seconds(self, object_id: int) -> float:
        """Seconds of output that exist, counting part-finished windows.

        A window is a minute and a segment is six seconds, so counting only
        finished windows makes progress lurch once a minute - and leaves the
        rate built on it sampled just as coarsely. FFmpeg lists a segment in
        the window's own index as it finalises it, which is the same evidence
        `segment_ready` already trusts to serve one.
        """
        meta = self.read_meta(object_id)
        if meta is None or not meta.source_duration:
            return 0.0
        total = 0.0
        for w in range(window_count(meta.source_duration)):
            length = window_length(meta.source_duration, w)
            if self.window_ready(object_id, w):
                total += length
                continue
            index = self.window_dir(object_id, w) / "index.m3u8"
            try:
                listed = index.read_text().count(".ts")
            except OSError:
                continue
            # Never more than the window holds: the last window of a recording
            # is short, and a segment that overruns it is still inside it.
            total += min(length, listed * SEGMENT_SECONDS)
        return total

    def _note_produced(self, object_id: int, seconds: float) -> None:
        """Record how much output existed just now, for the rate below."""
        samples = self._produced.setdefault(object_id, deque(maxlen=PRODUCED_SAMPLES))
        now = time.monotonic()
        # One reading a second is plenty; the library asks far more often than
        # a segment can appear.
        if samples and now - samples[-1][0] < 1.0:
            return
        samples.append((now, seconds))

    def average_rate(self, object_id: int) -> float:
        """Content produced per wall second across this run of windows.

        The honest headline for a download. Megabits per second describes the
        picture rather than the work - a frozen frame encodes in no time and
        produces almost nothing - and the last thirty seconds of anything
        wanders. This is what the whole run has actually averaged, which is
        what "how long will this take" is really asking about.

        Zero before the run has started, or where it produced nothing.
        """
        began = self._fill_started.get(object_id)
        if began is None:
            return 0.0
        elapsed = time.monotonic() - began
        if elapsed < 1.0:
            return 0.0
        return self.produced_seconds(object_id) / elapsed

    def produced_rate(self, object_id: int) -> float:
        """Seconds of output appearing per second, over the trailing window."""
        samples = self._produced.get(object_id)
        if not samples:
            return 0.0
        now = time.monotonic()
        start = now - RATE_WINDOW_SECONDS
        within = [s for s in samples if s[0] >= start]
        if len(within) < 1:
            return 0.0
        first_at, first_seconds = within[0]
        span = now - first_at
        if span < 1.0:
            return 0.0
        grew = self.produced_seconds(object_id) - first_seconds
        return max(0.0, grew) / span

    def _note_bytes(self, object_id: int, count: int, at: float | None = None) -> None:
        """Record bytes arriving for a recording."""
        samples = self._bytes.setdefault(object_id, deque(maxlen=TRANSFER_SAMPLES))
        samples.append((at if at is not None else time.monotonic(), count))

    def transfer_rate(self, object_id: int) -> float:
        """Bytes per second off the wire over the last RATE_WINDOW_SECONDS.

        Zero when nothing has arrived in that window, which is the honest
        answer for a download that is between windows or has stopped.
        """
        samples = self._bytes.get(object_id)
        if not samples:
            return 0.0
        now = time.monotonic()
        start = now - RATE_WINDOW_SECONDS
        within = [s for s in samples if s[0] >= start]
        if not within:
            return 0.0
        # Measured over what the fill has actually had, so a run younger than
        # the window is not divided by time before it began.
        span = now - max(start, within[0][0])
        if span < 1.0:
            return 0.0
        return sum(count for _at, count in within) / span

    def eta(self, object_id: int) -> float | None:
        """Seconds until this offline copy is finished, or None if unknowable.

        Two different questions wearing the same coat. A copied recording is a
        transfer: the device says what it weighs, nothing re-encodes it, so
        what is left is bytes on the wire and the answer is arithmetic. A
        transcode's output size is nobody's to know until it exists, so that
        one is still content produced over how fast it is being produced.
        """
        meta = self.read_meta(object_id)
        if meta is None:
            return None
        if meta.source_bytes:
            per_second = self.transfer_rate(object_id)
            if per_second > 0:
                return max(
                    0.0, meta.source_bytes - self.entry_bytes_cached(object_id)) / per_second
            return None
        # A transcode's output size is nobody's to know until it exists, so
        # this half is content: runtime left, over runtime appearing. Both are
        # watched at segment granularity rather than window, which is what
        # keeps the answer from lurching once a minute.
        produced = self.produced_seconds(object_id)
        self._note_produced(object_id, produced)
        # The run's average, not the last half minute: what remains will take
        # about as long as what came before, and a momentary stall or sprint
        # should not rewrite the answer.
        rate = self.average_rate(object_id) or self.produced_rate(object_id)
        if rate <= 0:
            # Nothing has been watched appearing yet; fall back to what the
            # finished windows say about themselves.
            rate = self.rate(object_id)["realtime"]
        return eta_seconds(meta.source_duration, produced, rate)

    def rate(self, object_id: int) -> dict[str, float]:
        """Current throughput for a recording being cached.

        Averaged over the encode time of the last few completed windows rather
        than wall clock, so a paused or queued recording reads as idle instead
        of as a rate decaying towards zero.
        """
        idle = {"mbps": 0.0, "realtime": 0.0}
        samples = self._rate.get(object_id)
        if not samples:
            return idle
        # Wall clock, not loop time: this is asked for from contexts that have
        # no running loop, and elapsed real time is what a throughput figure
        # means anyway.
        now = time.monotonic()
        # A live encoder is direct evidence the download is moving, and it
        # outranks sample age: the first window of a fresh run can be most of a
        # minute away from producing one.
        encoding = any(key[0] == object_id for key in self._procs)
        if not encoding and now - samples[-1][0] > RATE_IDLE_AFTER:
            return idle

        # What a fixed stretch of wall clock produced, not the sum of the
        # windows' own elapsed times.
        #
        # Windows run several at a time, so their elapsed times overlap and
        # adding them up describes one window rather than the download.
        # Measured on a real fill: the card read 5x and 11 Mb/s while six
        # windows were in flight and the device was really handing over closer
        # to 60 Mb/s - the readout was out by the concurrency factor, and so
        # was every estimate built on it.
        #
        # The span between the first and last completion is the honest
        # denominator, and what landed *within* it is everything but the first
        # sample - that one marks the span's start rather than falling inside
        # it.
        oldest = samples[0][0]
        window_start = now - RATE_WINDOW_SECONDS
        within = [s for s in samples if s[0] >= window_start]
        # A fill that started less than the window ago is measured over what it
        # has actually had: dividing its output by a stretch of time that
        # includes minutes before it began would halve the number for no reason.
        span = now - max(window_start, oldest)
        # Too short a stretch says nothing: a sample landing this instant would
        # divide a minute of video by no time at all and report millions. Two
        # seconds is below any real burst cycle, so this only catches the
        # degenerate case rather than the concurrency it is meant to measure.
        if span < 2.0:
            span = 0.0
        if not within or span <= 0:
            # Nothing has landed in the window yet - the first windows of a run
            # can be most of a minute away from finishing. Their own elapsed
            # time is the only denominator there is.
            within = list(samples)
            span = sum(s[2] for s in samples)
        if span <= 0:
            return idle

        written = sum(s[1] for s in within)
        produced = sum(s[3] for s in within)
        return {
            "mbps": round(written * 8 / span / 1e6, 2),
            "realtime": round(produced / span, 2),
        }

    def heartbeat(self, object_id: int, position: float | None = None) -> None:
        """Record that a viewer is still watching, and roughly where.

        Prefetch follows this. Without it the filler has no idea whether anyone
        is still there, which is how it ended up encoding a whole game after
        playback had stopped.
        """
        prev = self._watch.get(object_id)
        pos = position if position is not None else (prev[0] if prev else 0.0)
        self._watch[object_id] = (pos, asyncio.get_event_loop().time())

    def touch(self, object_id: int) -> None:
        meta = self.read_meta(object_id)
        if meta:
            meta.last_access = _now()
            self.write_meta(meta)

    # ------------------------------------------------------------------
    # Playlist
    # ------------------------------------------------------------------

    def segment_files(self, object_id: int) -> list[Path]:
        """Every cached segment, in playback order.

        Windows that were never encoded are skipped rather than faked. An
        export of a partial cache is therefore shorter than the recording, with
        the missing stretches simply absent - which is why callers gate exports
        on a complete cache instead of quietly handing over a file with holes.
        """
        meta = self.read_meta(object_id)
        if meta is None or not meta.source_duration:
            return []
        out: list[Path] = []
        for w in range(window_count(meta.source_duration)):
            if not self.window_ready(object_id, w):
                continue
            wd = self.window_dir(object_id, w)
            for n in range(segments_in_window(meta.source_duration, w)):
                seg = wd / f"seg_{n:02d}.ts"
                if seg.exists():
                    out.append(seg)
        return out

    # ------------------------------------------------------------------
    # Scrub-preview thumbnails
    # ------------------------------------------------------------------

    def bif_path(self, object_id: int) -> Path:
        """The preview pack, in the durable store rather than the cache.

        It used to live at `dir_for(object_id)/preview.bif`, inside the
        directory `evict` rmtree's to reclaim disk - so the pack went with the
        media. That is wrong twice over. The scrub preview is the smaller half:
        the viewer's chosen card picture is stored as a *position* into this
        pack (`recording_art.cover_frame_ms`) rather than as a copy of the
        frame, and a position is only as durable as the thing it indexes. A
        card whose picture had been deliberately chosen went blank the first
        time the cache came under pressure.

        Packs already written to the old location are moved on first use, so
        nothing has to be pulled from the device again.
        """
        dest = store.preview_path(object_id)
        if not dest.exists():
            legacy = self.dir_for(object_id) / "preview.bif"
            if legacy.is_file():
                try:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    legacy.replace(dest)
                except OSError:
                    return legacy
        return dest

    async def fetch_bif(self, object_id: int, path: str) -> bool:
        """Pull the device's thumbnail pack and keep it beside the recording.

        The Tablo already renders scrub previews for its own apps and serves
        them as BIF - a JPEG sprite with a millisecond index, one frame every
        ~10s. There is nothing to generate: 13 MB and about two seconds for a
        3.5h recording, against 6.9 GB of video.

        Stored rather than proxied per request so a kept offline copy still has
        previews once the Tablo has deleted the recording, which is the same
        promise the video itself makes.
        """
        dest = self.bif_path(object_id)
        if dest.exists():
            return True
        if self.preview_missing(object_id):
            return False
        try:
            session = await self._start_session(path)
            url = session.get("bif_url_hd") or session.get("bif_url_sd")
            if not url:
                # Remembered, so a pointer sweeping the strip does not spend a
                # device session per frame discovering the same null url.
                self._bif_refused[int(object_id)] = time.monotonic()
                print(f"[cache] {object_id} bif: device offers none", flush=True)
                return False
            data = await asyncio.to_thread(_http_get, url)
            if not data.startswith(_BIF_MAGIC):
                print(f"[cache] {object_id} bif: unexpected format", flush=True)
                return False
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".bif.part")
            tmp.write_bytes(data)
            tmp.replace(dest)
            self._bif_refused.pop(int(object_id), None)
            frames = struct.unpack("<I", data[12:16])[0]
            print(f"[cache] {object_id} bif: {frames} frames, "
                  f"{len(data) / 1024**2:.1f} MB", flush=True)
            return True
        except Exception as e:
            print(f"[cache] {object_id} bif failed: {e}", flush=True)
            return False

    def _bif_index(self, object_id: int) -> list[tuple[int, int, int]]:
        """(timestamp_ms, offset, length) per frame, cached in memory.

        The header's ``interval`` field reads 1 on this device, which cannot be
        literal for 1290 frames across 3.5 hours, so the per-frame timestamps in
        the index are used instead. The final entry is a 0xFFFFFFFF sentinel
        whose offset marks end-of-file, which is what gives the last frame its
        length.
        """
        cached = self._bif_cache.get(object_id)
        if cached is not None:
            return cached

        path = self.bif_path(object_id)
        if not path.exists():
            return []
        try:
            data = path.read_bytes()
            if not data.startswith(_BIF_MAGIC):
                return []
            count = struct.unpack("<I", data[12:16])[0]
            raw = [
                struct.unpack("<II", data[64 + i * 8: 72 + i * 8])
                for i in range(count + 1)
            ]
            index = [
                (raw[i][0], raw[i][1], raw[i + 1][1] - raw[i][1])
                for i in range(count)
                if raw[i][0] != _BIF_SENTINEL
            ]
        except (OSError, struct.error, IndexError):
            index = []
        self._bif_cache[object_id] = index
        return index

    def preview_frame(self, object_id: int, seconds: float) -> bytes | None:
        """The stored thumbnail at or just before ``seconds``."""
        index = self._bif_index(object_id)
        if not index:
            return None
        target = max(0, int(seconds * 1000))
        # Frames are ordered, so take the last one at or before the target.
        pos = bisect.bisect_right(index, target, key=lambda e: e[0]) - 1
        _, offset, length = index[max(0, pos)]
        try:
            with open(self.bif_path(object_id), "rb") as f:
                f.seek(offset)
                return f.read(length)
        except OSError:
            return None

    def encoding_progress(self, object_id: int) -> dict | None:
        """How far along the window a viewer is currently waiting on is.

        The wait before playback resumes is one window being encoded, and its
        segments appear in order, so the count of finished segments is real
        progress rather than an animation. A spinner could only say "something
        is happening"; this can say how much longer.

        Returns None when nothing is being encoded on demand for this recording.
        """
        keys = [k for k in self._ondemand if k[0] == object_id]
        if not keys:
            return None
        # The newest claim is where the viewer actually is.
        _, w = keys[-1]
        meta = self.read_meta(object_id)
        if meta is None or not meta.source_duration:
            return None
        total = segments_in_window(meta.source_duration, w)
        wd = self.window_dir(object_id, w)
        ready = 0
        if (wd / ".done").exists():
            ready = total
        else:
            index = wd / "index.m3u8"
            if index.exists():
                try:
                    ready = index.read_text().count(".ts")
                except OSError:
                    ready = 0
        return {
            "window": w,
            "start": w * WINDOW_SECONDS,
            "segments_ready": min(ready, total),
            "segments_total": total,
        }

    def preview_available(self, object_id: int) -> bool:
        return self.bif_path(object_id).exists()

    def preview_missing(self, object_id: int) -> bool:
        """The device was asked for this pack recently and had none to give.

        Distinct from "not here yet": packs are fetched lazily, on the first
        frame anybody asks for, so an absent one usually only means nobody has
        scrubbed this recording yet. This says the device itself has nothing -
        which is the answer for a recording still being written, and the
        permanent answer for one whose capture was damaged and never got a snap
        grid built.
        """
        at = self._bif_refused.get(int(object_id))
        if at is None:
            return False
        if time.monotonic() - at >= BIF_REFUSAL_TTL:
            del self._bif_refused[int(object_id)]
            return False
        return not self.preview_available(object_id)

    def export_path(self, object_id: int) -> Path:
        return self.dir_for(object_id) / "export.mp4"

    async def build_mp4(self, object_id: int) -> Path:
        """Remux the cached segments into one MP4 on disk, and return it.

        Built to a file rather than streamed to the client. Streaming meant the
        response had no Content-Length, so a browser could only show a growing
        byte count with no total and no estimate, and the download could not be
        resumed. Staging costs a wait up front but is faster end to end:
        measured on a 3h35m recording, 6.9 GB remuxed at 382 MB/s (~20s) and
        then served at link speed, against ~70s streamed through nginx.

        The segments are already H.264/AAC, so nothing is re-encoded.

        FFmpeg reads the same VOD playlist the player uses, rather than the
        segment bytes concatenated together. Each window carries absolute
        timestamps from ``-output_ts_offset``, and feeding that stream to the
        MPEG-TS demuxer produced a file ffmpeg could read but strict players
        could not: QuickTime stopped after the first segment even though the
        header claimed the full 3h35m. The HLS demuxer understands what those
        timestamps mean and rebases them, giving ``start_time=0`` and an exact
        duration.
        """
        segments = self.segment_files(object_id)
        if not segments:
            raise FileNotFoundError(f"nothing cached for {object_id}")
        playlist = self.build_playlist(object_id)
        if not playlist:
            raise FileNotFoundError(f"no playlist for {object_id}")

        out = self.export_path(object_id)
        async with self._lock(object_id):
            # A second request while one is building waits on the lock and then
            # finds the finished file rather than starting a duplicate remux.
            if out.exists():
                return out
            tmp = out.with_suffix(".mp4.part")
            tmp.unlink(missing_ok=True)
            self._check_disk(sum(s.stat().st_size for s in segments))

            # The playlist's segment URIs are relative, so it has to sit beside
            # the window directories it names.
            index = self.dir_for(object_id) / "export.m3u8"
            index.write_text(playlist)
            try:
                await self._remux(index, tmp)
            finally:
                index.unlink(missing_ok=True)
            tmp.replace(out)
        return out

    async def _remux(self, index: Path, dest: Path) -> None:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            # The TS carries absolute timestamps from the window offsets; let
            # FFmpeg rebuild presentation stamps rather than trusting the seam.
            # Local segments only. 'file' is the whole whitelist on purpose:
            # the playlist is ours, but the demuxer must not be able to reach
            # the network on the strength of a URI.
            "-protocol_whitelist", "file",
            "-allowed_extensions", "ALL",
            "-i", str(index),
            "-c", "copy",
            # The segments carry AAC in ADTS framing, which is how MPEG-TS
            # holds it; MP4 needs the raw form with the config in the sample
            # entry. Without this the muxer rejects the first audio packet with
            # "Malformed AAC bitstream detected" and the export dies a fraction
            # of a second in, having written only a header.
            "-bsf:a", "aac_adtstoasc",
            # Writing to a real file, so the header can be rewritten at the end:
            # +faststart puts the index at the front, which is what lets a player
            # seek immediately instead of reading the whole file first.
            "-movflags", "+faststart",
            "-f", "mp4", str(dest),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            err = (await proc.stderr.read()).decode(errors="replace")
        except asyncio.CancelledError:
            proc.kill()
            raise

        rc = await proc.wait()
        if rc != 0 or not dest.exists():
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"remux failed (rc={rc}): {err.strip()[-400:]}")

    def build_playlist(self, object_id: int) -> str | None:
        """Full-length VOD playlist, published before anything is encoded.

        Structure is derived from the source duration, so the player gets the
        entire timeline up front and can seek anywhere — the whole point of
        encoding in independent windows.

        No EXT-X-DISCONTINUITY between windows: each window is muxed with
        ``-output_ts_offset`` so its timestamps carry its true position in the
        recording. The stream is therefore continuous, and a discontinuity marker
        would wrongly tell the player to re-base its timeline at every boundary.
        """
        meta = self.read_meta(object_id)
        if meta is None or not meta.source_duration:
            return None

        duration = meta.source_duration
        total = window_count(duration)

        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{SEGMENT_SECONDS + 1}",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:VOD",
            "#EXT-X-INDEPENDENT-SEGMENTS",
        ]

        for w in range(total):
            n_segs = segments_in_window(duration, w)
            win_len = window_length(duration, w)
            for n in range(n_segs):
                remaining = win_len - n * SEGMENT_SECONDS
                seg_len = min(SEGMENT_SECONDS, remaining) if remaining > 0 else SEGMENT_SECONDS
                lines.append(f"#EXTINF:{seg_len:.6f},")
                lines.append(f"w{w:05d}/seg_{n:02d}.ts")

        lines.append("#EXT-X-ENDLIST")
        return "\n".join(lines) + "\n"

    # ------------------------------------------------------------------
    # Housekeeping
    # ------------------------------------------------------------------

    def sweep_orphans(self) -> list[int]:
        """Remove partially-written windows left by a restart.

        A window directory without its ``.done`` marker holds a truncated encode.
        Deleting it makes the window cold again so it is simply redone.
        """
        swept: list[int] = []
        if not self.root.exists():
            return swept
        for d in self.root.iterdir():
            if not d.is_dir():
                continue
            try:
                oid = int(d.name)
            except ValueError:
                continue
            removed = 0
            for wd in d.glob("w*"):
                if wd.is_dir() and not (wd / ".done").exists():
                    shutil.rmtree(wd, ignore_errors=True)
                    removed += 1
            if removed:
                swept.append(oid)
        return swept

    def entry_bytes_cached(self, object_id: int, ttl: float = 2.0) -> int:
        """`entry_bytes`, answered from a moment ago where that will do.

        Two seconds is below the poll interval and far below anything a person
        would notice on a progress bar, while being enough to collapse a
        listing's worth of directory walks into one apiece.
        """
        seen = self._bytes_seen.get(object_id)
        now = time.monotonic()
        if seen is not None and now - seen[0] < ttl:
            return seen[1]
        total = self.entry_bytes(object_id)
        self._bytes_seen[object_id] = (now, total)
        return total

    def entry_bytes(self, object_id: int) -> int:
        d = self.dir_for(object_id)
        if not d.exists():
            return 0
        return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())

    def total_bytes(self) -> int:
        if not self.root.exists():
            return 0
        return sum(f.stat().st_size for f in self.root.rglob("*") if f.is_file())

    def thumbnail_path(self, object_id: int) -> Path:
        return self.dir_for(object_id) / "thumb.jpg"

    def pinned_ids(self) -> list[int]:
        """Pinned recordings, from an index rather than a directory walk.

        This is on the path of every library listing, and previously opened and
        parsed one JSON file per cached recording to answer it.
        """
        try:
            return store.pinned_recording_ids()
        except Exception:
            return []

    def set_paused(self, object_id: int, paused: bool) -> bool:
        meta = self.read_meta(object_id)
        if meta is None:
            return False
        meta.paused = paused
        self.write_meta(meta)
        return True

    def set_error(self, object_id: int, error: str | None) -> bool:
        """Record (or clear) a download failure, surfaced as CacheState.FAILED.

        A pinned fill whose source cannot be reached would otherwise spin
        forever; setting this stops it and lets the card offer a Resume.
        """
        meta = self.read_meta(object_id)
        if meta is None:
            return False
        meta.error = error
        self.write_meta(meta)
        return True

    def set_pinned(self, object_id: int, pinned: bool, info: dict | None = None) -> bool:
        meta = self.read_meta(object_id)
        if meta is None:
            return False
        meta.pinned = pinned
        if info is not None:
            meta.info = info
        self.write_meta(meta)
        return True

    def pinned_bytes(self) -> int:
        return sum(self.entry_bytes(oid) for oid in self.pinned_ids())

    def storage(self) -> dict:
        """What the cache is using, split by what can be reclaimed.

        Pinned recordings are exempt from the budget by design - they are the
        user's offline copies - so they have to be reported separately or the
        numbers look wrong.

        Artwork and preview packs are a third kind again, and reported as one.
        They live outside the cache root so that reclaiming disk cannot touch
        them, which also means `total_bytes` cannot see them: counting only the
        cache under-reported what the app occupies, which is the sort of lie
        that gets discovered on a full disk. They are not reclaimable and not
        part of the budget, so they are named rather than folded in.
        """
        probe = self.root
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        usage = shutil.disk_usage(probe)
        total = self.total_bytes()
        pinned = self.pinned_bytes()
        artwork, previews = store.durable_asset_bytes()
        return {
            "pinned_bytes": pinned,
            "cache_bytes": max(0, total - pinned),
            "total_bytes": total,
            "budget_bytes": self.budget,
            "free_bytes": usage.free,
            "pinned_count": len(self.pinned_ids()),
            # Durable, per-recording, and never reclaimed: the picture each
            # card leads with and the frames its scrub strip reads.
            "artwork_bytes": artwork,
            "preview_bytes": previews,
            # What the app actually occupies, which is the question anyone
            # reading this screen is really asking.
            "disk_bytes": total + artwork + previews,
        }

    def _busy(self, object_id: int) -> bool:
        """True while a recording is being worked on or actively watched.

        The watch check matters: prefetch stops once the lookahead is satisfied,
        and without this an idle-but-playing recording became evictable and its
        cache could vanish mid-playback.
        """
        if self._prefetch.get(object_id) or any(k[0] == object_id for k in self._window_jobs):
            return True
        seen = self._watch.get(object_id)
        if seen is None:
            return False
        try:
            return asyncio.get_event_loop().time() - seen[1] <= WATCH_IDLE_TIMEOUT
        except RuntimeError:          # no running loop (sync call in tests)
            return False

    def evict(self, object_id: int, force: bool = False) -> bool:
        """Remove one entry.

        Refuses while windows are encoding, and refuses pinned entries unless
        ``force`` - which only the explicit user-facing delete passes.
        """
        if self._busy(object_id):
            return False
        meta = self.read_meta(object_id)
        if meta and meta.pinned and not force:
            return False
        d = self.dir_for(object_id)
        if not d.exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        store.delete_recording(object_id)
        return True

    def make_room(self, needed_bytes: int = 0) -> None:
        """Evict least-recently-accessed entries until under budget.

        The budget governs *reclaimable* bytes only. Pinned recordings are the
        user's offline copies and are exempt, so counting them here would make
        a few kept games raise CacheFull on every subsequent playback.
        """
        target = self.budget - needed_bytes
        if not self.root.exists():
            return

        def reclaimable() -> int:
            return self.total_bytes() - self.pinned_bytes()

        if reclaimable() <= target:
            return

        # Ordered by last_access in the query. Pinned recordings are the user's
        # offline copies and are excluded there: reclaiming one to make room
        # would silently destroy the thing they asked us to keep.
        candidates = [oid for oid in store.eviction_candidates() if not self._busy(oid)]

        for oid in candidates:
            if reclaimable() <= target:
                return
            self.evict(oid)

        if reclaimable() > target:
            raise CacheFull(
                "cache budget cannot be met without evicting an in-progress transcode"
            )

    def _check_disk(self, estimated_bytes: int) -> None:
        probe = self.root
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        usage = shutil.disk_usage(probe)
        required = max(MIN_FREE_BYTES, int(estimated_bytes * 1.5))
        if usage.free < required:
            raise InsufficientDisk(
                f"need {required // 1024**2} MB free, have {usage.free // 1024**2} MB"
            )

    @staticmethod
    def estimate_bytes(source_duration: int) -> int:
        return int(source_duration * VIDEO_BITRATE_BPS / 8)

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    async def register(self, object_id: int, path: str, source_duration: int,
                       codec: str | None = None,
                       size: int | None = None) -> CacheMeta:
        """Make the recording playable: write metadata and start background fill.

        Returns as soon as the playlist can be built — which is immediately, since
        the playlist is derived from the duration rather than from encoded output.
        """
        async with self._lock(object_id):
            meta = self.read_meta(object_id)
            if meta is None:
                estimated = self.estimate_bytes(source_duration)
                self._check_disk(estimated)
                self.make_room(estimated)
                meta = CacheMeta(
                    object_id=object_id, path=path, source_duration=source_duration,
                    source_codec=codec, source_bytes=size,
                )
                self.write_meta(meta)
            elif (meta.source_duration != source_duration or meta.path != path
                  or (codec is not None and meta.source_codec != codec)
                  or (size is not None and meta.source_bytes != size)):
                # Update the facts in place. Replacing the record wholesale here
                # silently cleared `pinned`, which made the recording eligible
                # for eviction - and an offline copy that had been explicitly
                # kept was then deleted to make room. Two were lost that way
                # before this was found.
                #
                # No make_room: space for this recording was reserved when it
                # was first registered, and re-reserving it made re-registering
                # a large pinned copy fail outright with CacheFull.
                meta.source_duration = source_duration
                meta.path = path
                if codec is not None:
                    meta.source_codec = codec
                if size is not None:
                    meta.source_bytes = size
                self.write_meta(meta)
            else:
                self.touch(object_id)

        self.heartbeat(object_id, 0.0)
        self.start_prefetch(object_id, path, source_duration)
        # Fetched in the background so opening a recording is not delayed by it;
        # the scrubber falls back to no preview until it lands.
        if not self.preview_available(object_id):
            asyncio.create_task(self.fetch_bif(object_id, path))
        return meta

    # ------------------------------------------------------------------
    # Window encoding
    # ------------------------------------------------------------------

    def _signal_background(self, sig: int) -> None:
        """Suspend or resume every encoder nobody is waiting on.

        Membership of ``_ondemand`` decides this, not the flag the process was
        started with. Prefetch and a viewer race for the same window: if
        prefetch claims it a moment first, the viewer's request attaches to that
        existing job, and going by the spawn-time flag would suspend the very
        window being awaited. That is exactly what happened - a cold open sat
        frozen for the full segment timeout, returned 503, and took 53s to
        start playing.
        """
        for key, (proc, is_ondemand) in list(self._procs.items()):
            if is_ondemand or key in self._ondemand:
                continue
            if getattr(proc, "returncode", 0) is not None:
                continue
            try:
                proc.send_signal(sig)
            except Exception:
                pass

    def _kill_procs(self, object_id: int) -> None:
        """End every encoder for a recording.

        Canceling the awaiting task is not enough - that abandons the process
        rather than stopping it.
        """
        for key in [k for k in self._procs if k[0] == object_id]:
            proc, _ = self._procs.pop(key, (None, False))
            if proc is None or getattr(proc, "returncode", 0) is not None:
                continue
            try:
                # Resume first: a SIGSTOPped process cannot act on SIGKILL.
                proc.send_signal(signal.SIGCONT)
                proc.kill()
            except Exception:
                pass

    def _reap_abandoned(self, object_id: int) -> None:
        """Kill on-demand encodes nobody is waiting for any more.

        Each scrub starts a window encode. On-demand work is deliberately not
        bounded by the prefetch semaphore - a viewer waiting should not queue
        behind background work - but that means rapid scrubbing piled up
        concurrent encoders, each then taking long enough to blow through the
        client's fragment timeout. A window whose waiter has gone is dead weight.
        """
        for key in [k for k in self._procs if k[0] == object_id]:
            proc, is_ondemand = self._procs.get(key, (None, False))
            if not is_ondemand or key in self._ondemand:
                continue
            if proc is None or getattr(proc, "returncode", 0) is not None:
                continue
            self._kill_window(key)
            print(f"[cache] reaped abandoned window {key[1]} of {object_id}")

    def _claim_ondemand(self, key: tuple[int, int]) -> None:
        """Register a viewer-initiated window, evicting the oldest past the cap.

        Eviction kills the encode and cancels its job, so whoever was waiting on
        it sees a finished task and gets a prompt failure rather than holding a
        connection open for the full timeout.
        """
        if key in self._ondemand:
            return
        self._ondemand[key] = None
        # It may already be suspended as background work from an earlier claim
        # on some other window. Skipping it in _signal_background only stops it
        # being suspended again; something has to actually wake it.
        entry = self._procs.get(key)
        if entry and getattr(entry[0], "returncode", 0) is None:
            with contextlib.suppress(Exception):
                entry[0].send_signal(signal.SIGCONT)
        self._evict_ondemand(
            key,
            lambda: len(self._ondemand) > MAX_ONDEMAND_WINDOWS,
            lambda k: True,
        )
        # Scrubbing away from a cold spot must abandon it at once. Otherwise the
        # encoder stays committed to a place the viewer has left, and the next
        # target queues behind work nobody wants any more - which is what made a
        # mis-aimed scrub feel like being stuck there until it finished.
        # Two per recording, so normal playback can still hold the current window
        # and the one it is about to roll into.
        self._evict_ondemand(
            key,
            lambda: sum(1 for k in self._ondemand if k[0] == key[0])
            > MAX_ONDEMAND_PER_RECORDING,
            lambda k: k[0] == key[0],
        )

    def _evict_ondemand(self, keep, over_limit, matches) -> None:
        """Drop the oldest matching claims, oldest first, while over the limit."""
        while over_limit():
            oldest = next((k for k in self._ondemand if matches(k) and k != keep), None)
            if oldest is None:
                break
            self._release_ondemand(oldest)
            self._kill_window(oldest)
            print(f"[cache] dropped stale on-demand window {oldest[1]} of {oldest[0]} "
                  f"({len(self._ondemand)} in flight)", flush=True)

    def _release_ondemand(self, key: tuple[int, int]) -> None:
        self._ondemand.pop(key, None)

    def _kill_window(self, key: tuple[int, int]) -> None:
        """Cancel a window's encode job and end its FFmpeg process."""
        job = self._window_jobs.pop(key, None)
        if job:
            job.cancel()
        entry = self._procs.pop(key, None)
        if not entry:
            return
        proc, _ = entry
        if proc is None or getattr(proc, "returncode", 0) is not None:
            return
        try:
            # Resume first: a SIGSTOPped process cannot act on SIGKILL.
            proc.send_signal(signal.SIGCONT)
            proc.kill()
        except Exception:
            pass

    def _pause_background(self) -> None:
        """SIGSTOP background encoders so the window a viewer waits on gets the device.

        This was gated to software encoders, reasoning that hardware encoding
        costs ~2 CPU-seconds per minute of video so there are no cycles to win
        back. The cycles were never the point. The Tablo serves roughly 10x
        realtime in total however the frames are encoded, and it is the only
        source of them, so concurrent windows divide one fixed budget: six
        streams get about 1.1x each. Playback consumes at 1x, so a viewer whose
        window is sharing the device rides the encode frontier indefinitely.
        Measured across one seek - the awaited window took 55.7s at 1.1x beside
        five prefetch streams; one with the device largely to itself took 17.5s.
        Suspending an encoder stops it reading from the device, which is exactly
        the budget the blocked window needs.

        The earlier worry was that this freezes prefetch permanently, since
        hls.js asks for a segment every couple of seconds and
        `_resume_background` only fires once `_ondemand` empties. That was a
        feedback loop rather than a property of pausing: prefetch could never
        get ahead, so every segment needed an on-demand encode, which kept
        prefetch suspended. Serving the blocked window at full speed breaks it -
        the window lands in ~13s, playback gets a full minute of buffer, and
        nothing claims on-demand again until it runs out. Suspension is also
        bounded in a way it was not then: every claim is released in a finally
        and each wait has a timeout, so an encoder cannot be stranded.
        """
        self._signal_background(signal.SIGSTOP)

    def _resume_background(self) -> None:
        # Always safe to send: a process that was never stopped ignores it, so
        # this still recovers anything suspended before the encoder changed.
        if not self._ondemand:
            self._signal_background(signal.SIGCONT)

    async def ensure_segment(
        self, object_id: int, w: int, n: int, path: str, duration: int
    ) -> bool:
        """Make segment ``n`` of window ``w`` available.

        Waits for that one segment rather than the whole window. FFmpeg writes
        segments in order, so the first is ready in roughly seek time plus one
        segment of encoding - about 8s - instead of the ~30s a full 60s window
        takes. The rest of the window keeps encoding behind the response.
        """
        if self.segment_ready(object_id, w, n):
            return True

        key = (object_id, w)
        self._claim_ondemand(key)
        self._reap_abandoned(object_id)
        self._pause_background()
        try:
            if key not in self._window_jobs:
                task = asyncio.create_task(
                    self._encode_window(object_id, w, path, duration, True)
                )
                self._window_jobs[key] = task
                task.add_done_callback(lambda _t, k=key: self._window_jobs.pop(k, None))
            task = self._window_jobs.get(key)

            deadline = asyncio.get_event_loop().time() + SEGMENT_WAIT_TIMEOUT
            while asyncio.get_event_loop().time() < deadline:
                if self.segment_ready(object_id, w, n):
                    return True
                if task and task.done():
                    # Job finished; either the segment exists or it never will.
                    return self.segment_ready(object_id, w, n)
                if key not in self._ondemand:
                    # Evicted in favour of a newer request; stop waiting.
                    return self.segment_ready(object_id, w, n)
                await asyncio.sleep(0.25)
            return False
        finally:
            self._release_ondemand(key)
            self._resume_background()

    def segment_ready(self, object_id: int, w: int, n: int) -> bool:
        """True once FFmpeg has finalized this segment.

        Presence of the .ts file is not enough - it is still being written. The
        segment is listed in the window's own index only once closed.
        """
        wd = self.window_dir(object_id, w)
        if (wd / ".done").exists():
            return (wd / f"seg_{n:02d}.ts").exists()
        idx = wd / "index.m3u8"
        if not idx.exists():
            return False
        try:
            return f"seg_{n:02d}.ts" in idx.read_text()
        except OSError:
            return False

    async def ensure_window(
        self, object_id: int, w: int, path: str, duration: int, on_demand: bool = False
    ) -> bool:
        """Transcode window ``w`` if absent, returning True once it is ready.

        Concurrent callers for the same window share one encode. ``on_demand``
        marks a viewer-initiated request, which pauses background prefetch so the
        seek gets the CPU.
        """
        if self.window_ready(object_id, w):
            return True

        key = (object_id, w)
        if on_demand:
            self._claim_ondemand(key)
            self._pause_background()
        task = self._window_jobs.get(key)
        if task is None:
            task = asyncio.create_task(
                self._encode_window(object_id, w, path, duration, on_demand)
            )
            self._window_jobs[key] = task
            task.add_done_callback(lambda _t, k=key: self._window_jobs.pop(k, None))

        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=WINDOW_WAIT_TIMEOUT)
        except asyncio.TimeoutError:
            return False
        except Exception:
            return False
        finally:
            self._release_ondemand(key)
            self._resume_background()
        return self.window_ready(object_id, w)

    async def _fetch_window_source(
        self, object_id: int, w: int, playlist_url: str,
        first_second: float, last_second: float, wd: Path,
    ) -> Path | None:
        """Pull this window's bytes off the device in as few reads as possible.

        Returns the local file FFmpeg should read, or None when the device's
        playlist cannot be used that way and the window should stream from it
        as it always has.

        The device serves a recording as byte ranges of a few large files, and
        a window is a contiguous run of them, so this is normally a single
        request. It replaces sixty - one per one-second segment - which is the
        difference between a read the box is good at and a queue it is not:
        measured 2026-09-22 against this device, sixteen concurrent segment
        readers dragged the whole fill down to 4.3 Mb/s and its ping up to
        85ms, while one bulk range read sustained 41 Mb/s over a far worse
        link.
        """
        try:
            master = (await asyncio.to_thread(_http_get, playlist_url)).decode()
            variant = next(
                (ln.strip() for ln in master.splitlines()
                 if ln.strip() and not ln.startswith("#")), None)
            if not variant:
                return None
            variant_url = urljoin(playlist_url, variant)
            text = (await asyncio.to_thread(_http_get, variant_url)).decode()
            index = parse_vod_playlist(text, variant_url)
        except Exception as e:
            print(f"[cache] {object_id} w{w} could not read the device index "
                  f"({e}) — streaming instead", flush=True)
            return None

        # A window is the device's own segments whose starts fall inside it -
        # not a span of time cut out of them.
        #
        # That distinction is the difference between a seam and a hole. Each of
        # these segments begins on a keyframe, and `-c:v copy` can only begin on
        # one, so asking FFmpeg for "sixty seconds starting at 420" made it skip
        # forward to the first keyframe past 420 and drop everything before it.
        # Measured on the first recording kept this way: 99 of 141 window seams
        # lost video, 59.7s of the game in total, up to 1.068s at a time.
        #
        # Defined this way, window w ends exactly where window w+1 begins,
        # because both are answering the same question about the same list. The
        # seam moves by up to a second from where the playlist nominally puts
        # it, and no frame is lost at it.
        wanted: list = []
        at = 0.0
        for seg in index.segments:
            if seg.byte_range is None:
                return None
            if first_second <= at < last_second:
                wanted.append((at, seg))
            at += seg.duration
            if at >= last_second:
                break
        if not wanted:
            return None

        # Contiguous runs of one file, which is what the device's layout
        # normally gives: one request for the whole window.
        runs: list[tuple[str, int, int]] = []
        for _at, seg in wanted:
            url, (first, last) = seg.url, seg.byte_range
            if runs and runs[-1][0] == url and runs[-1][2] + 1 == first:
                runs[-1] = (url, runs[-1][1], last)
            else:
                runs.append((url, first, last))

        dest = wd / "source.ts"
        try:
            with dest.open("wb") as out:
                for url, first, last in runs:
                    out.write(await asyncio.to_thread(
                        _http_get_range, url, first, last, 180,
                        lambda n, oid=object_id: self._note_bytes(oid, n)))
        except Exception as e:
            dest.unlink(missing_ok=True)
            print(f"[cache] {object_id} w{w} range read failed ({e}) — "
                  "streaming instead", flush=True)
            return None

        megabytes = dest.stat().st_size / 1024**2
        print(f"[cache] {object_id} w{w} pulled {megabytes:.0f} MB in "
              f"{len(runs)} request(s)", flush=True)
        # Where the file actually begins - a segment boundary at or before the
        # span asked for. The caller seeks the difference.
        return (dest, wanted[0][0]) if dest.stat().st_size else None

    async def _encode_window(
        self, object_id: int, w: int, path: str, duration: int, on_demand: bool = False
    ) -> None:
        wd = self.window_dir(object_id, w)
        # Any leftovers are from a failed attempt; a partial window must not be
        # mistaken for a complete one.
        shutil.rmtree(wd, ignore_errors=True)
        wd.mkdir(parents=True, exist_ok=True)

        # A fresh session per window doubles as the keepalive: device sessions
        # expire ~3.5 minutes out and a window encodes in well under that, so no
        # separate refresh loop is needed.
        t0 = asyncio.get_event_loop().time()
        self._fill_started.setdefault(object_id, time.monotonic())
        session = await self._start_session(path)
        playlist_url = session.get("playlist_url")
        if not playlist_url:
            raise RuntimeError(f"device returned no playlist_url for {path}")

        start = w * WINDOW_SECONDS
        length = window_length(duration, w)
        seek_to = max(0.0, start - SEEK_PREROLL)
        preroll = start - seek_to
        print(f"[cache] {object_id} w{w} start "
              f"({'on-demand' if on_demand else 'prefetch'}) "
              f"@{start:.0f}s len={length:.0f}s "
              f"session={asyncio.get_event_loop().time() - t0:.1f}s", flush=True)

        # A recording the box encoded itself is already H.264 - which is
        # exactly what this is trying to produce. Copy the picture and change
        # only the audio: AC-3 is the one part no browser but Safari decodes,
        # and the one part `build_mp4` cannot put in an MP4.
        meta = self.read_meta(object_id)
        copying = (meta.source_codec if meta else None) == "h264"

        prof = encoder_profile()
        # Deinterlace ahead of anything encoder-specific: VAAPI's chain ends in
        # hwupload, and frames have to be progressive before they leave for the
        # GPU.
        # Order is load-bearing at both ends: the deinterlace samples real
        # rows so it must see the coded picture, and VAAPI's chain ends in
        # hwupload, after which a software scale has nothing to work on.
        def build_cmd(copying: bool) -> list[str]:
            # Nothing to filter when nothing is being decoded - and a copied
            # source is progressive with square pixels already, so there is
            # nothing a filter would fix.
            filters = [] if copying else [
                *deinterlace_filter(), *square_pixels_filter(), *prof.filters]
            return [
                "ffmpeg", "-y",
                # Device-controlled URLs get no 'file'. A local window source is
                # ours - written by `_fetch_window_source` into this window's own
                # directory - and is then the only thing FFmpeg is asked to open.
                "-protocol_whitelist", "file" if local else "http,https,tcp,tls",
                *([] if copying else prof.pre_input),
                # Fast input seek to just before the window. Measured flat (~5s)
                # regardless of offset. A local source *is* the window - whole
                # segments, nothing either side - so there is nothing to seek
                # to and nothing to trim, and seeking a copied stream is how
                # frames were lost at every seam before this.
                *([] if local else ["-ss", f"{seek_to:.3f}"]),
                "-i", str(local[0]) if local else playlist_url,
                # Accurate output seek across the pre-roll, so the window begins on
                # cleanly decoded frames rather than mid-GOP artefacts.
                *([] if local else
                  ["-ss", f"{preroll:.3f}"] if preroll > 0 else []),
                *([] if local else ["-t", f"{length:.3f}"]),
                # Each window is encoded independently, so without this every window's
                # output would start at PTS ~0 and the player would snap back to the
                # beginning on each boundary. Offsetting makes timestamps absolute and
                # continuous across the whole recording.
                "-output_ts_offset", f"{local[1]:.3f}" if local else str(start),
                # Pins keyframes to exact segment boundaries so the window's segment
                # count matches what the published playlist already declared.
                # FFmpeg cannot place keyframes in a stream it is copying, so a
                # copied window is checked against that count afterwards instead.
                *([] if copying else [
                    "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_SECONDS})"]),
                *(["-vf", ",".join(filters)] if filters else []),
                *(["-c:v", "copy"] if copying else ["-c:v", prof.name, *prof.flags]),
                *([] if copying or not prof.pix_fmt else ["-pix_fmt", prof.pix_fmt]),
                "-c:a", "aac", "-b:a", "160k", "-ac", "2",
                "-f", "hls",
                "-hls_time", str(SEGMENT_SECONDS),
                "-hls_list_size", "0",
                # No -hls_playlist_type: FFmpeg defers writing a VOD index until the
                # encode completes, so readiness could not be detected until the
                # whole window was done (58s vs 9s measured). This index is only
                # used to tell when a segment is finalized - playback uses the
                # playlist we synthesise.
                "-start_number", "0",
                "-hls_segment_filename", "seg_%02d.ts",
                "-loglevel", "warning",
                "index.m3u8",
            ]

        async def run(cmd: list[str]) -> int:
            log = open(wd / "ffmpeg.log", "a")  # noqa: ASYNC230, SIM115
            log.write(
                f"window {w}  start={start}s  len={length:.3f}s\n{' '.join(cmd)}\n\n")
            log.flush()
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd, cwd=str(wd), stdout=log, stderr=asyncio.subprocess.STDOUT
                )
                self._procs[(object_id, w)] = (proc, on_demand)
                # A background window started before the seek arrived must also
                # yield - unless it is the window being waited on. Prefetch and
                # a viewer race for the same window, and if prefetch wins by a
                # fraction the request attaches to this job while `on_demand`
                # stays False. Going by that flag alone made the window suspend
                # itself the moment it started, so it produced nothing, the wait
                # timed out at 25s, and a cold open took 53s and two 503s to
                # begin playing.
                if (self._ondemand and not on_demand
                        and (object_id, w) not in self._ondemand):
                    try:
                        proc.send_signal(signal.SIGSTOP)
                    except Exception:
                        pass
                return await proc.wait()
            finally:
                self._procs.pop((object_id, w), None)
                log.close()

        # Copying reads the device once, in bulk, and then works from disk.
        # Encoding still streams the playlist: FFmpeg has to decode it anyway,
        # so holding a whole window on disk first buys nothing.
        local = None
        if copying:
            local = await self._fetch_window_source(
                object_id, w, playlist_url, start, start + length, wd)

        rc = await run(build_cmd(copying))
        expected = segments_in_window(duration, w)

        # A copied window has to come out the shape the playlist already
        # published: `build_playlist` names `expected` files before anything is
        # made, so one fewer leaves a URI pointing at nothing and one more hides
        # that content from playback. FFmpeg cannot place keyframes in a stream
        # it is copying, so where the source's own keyframes do not fall on the
        # boundaries, this window goes back through the encoder - which can put
        # them exactly where they are needed. Measured on the one H.264
        # recording here, keyframes are 1.001s apart and this never fires.
        if copying and rc == 0:
            # Copying cuts where the source's keyframes are, not where the
            # window boundaries would like them. Measured on the real
            # recording: ten segments came out 5.6-6.8s apart, covering 60.35s
            # between them, and the remainder became an eleventh of 0.969s.
            # Nothing is wrong with that content - there is simply one file
            # more than the playlist named, and the playlist was published
            # before any of it existed.
            #
            # So fold the tail into the last segment the playlist does name.
            # MPEG-TS concatenates: 188-byte packets, with PAT and PMT
            # repeated throughout, and the joined segment decodes clean
            # (checked 2026-09-22 on the spill this fixes). The alternative -
            # re-encoding the window - spends a core to rebuild frames that
            # were already correct, which is the one thing this path exists to
            # avoid.
            spilled = sorted(wd.glob("seg_*.ts"))[expected:]
            if spilled:
                last = wd / f"seg_{expected - 1:02d}.ts"
                extra = 0
                with last.open("ab") as out:
                    for seg in spilled:
                        extra += seg.stat().st_size
                        out.write(seg.read_bytes())
                        seg.unlink()
                print(f"[cache] {object_id} w{w} folded {len(spilled)} spilled "
                      f"segment(s), {extra / 1024:.0f} KB, into seg_"
                      f"{expected - 1:02d}", flush=True)

            made = len(list(wd.glob("seg_*.ts")))
            if made < expected:
                # Short, not long: the source had too few keyframes to cut the
                # window into the shape the playlist promised. Only the encoder
                # can place them where they are needed, so this window goes
                # back through it.
                print(f"[cache] {object_id} w{w} copy made {made} segments, "
                      f"playlist says {expected} — re-encoding", flush=True)
                for f in wd.glob("seg_*.ts"):
                    f.unlink()
                (wd / "index.m3u8").unlink(missing_ok=True)
                copying = False
                rc = await run(build_cmd(False))

        elapsed = asyncio.get_event_loop().time() - t0
        produced = len(list(wd.glob("seg_*.ts")))
        if rc != 0 or produced == 0:
            tail = ""
            try:
                tail = (wd / "ffmpeg.log").read_text()[-400:]
            except OSError:
                pass
            print(f"[cache] {object_id} w{w} FAILED rc={rc} after {elapsed:.1f}s\n{tail}",
                  flush=True)
            raise RuntimeError(f"window {w} failed: ffmpeg rc={rc}, {produced} segments")

        # Short-final-window and keyframe placement can yield one fewer segment
        # than declared. Pad by duplicating the last one so every URI the
        # published playlist references resolves.
        if produced < expected:
            last = max(wd.glob("seg_*.ts"))
            for n in range(produced, expected):
                shutil.copyfile(last, wd / f"seg_{n:02d}.ts")

        size_bytes = sum(f.stat().st_size for f in wd.glob("seg_*.ts"))
        size_mb = size_bytes / 1024**2
        samples = self._rate.setdefault(object_id, deque(maxlen=RATE_SAMPLES))
        samples.append((time.monotonic(), size_bytes, elapsed, length))
        # Where the whole download has got to, alongside this one window: the
        # aggregate rate and the estimate built on it are what the card shows,
        # and printing them beside a timestamp is what makes the estimate
        # checkable against the clock rather than merely plausible.
        meta_now = self.read_meta(object_id)
        total_seconds = meta_now.source_duration if meta_now else 0
        done_seconds = self.cached_seconds(object_id)
        overall = self.rate(object_id)
        if not (meta_now is not None and meta_now.source_bytes):
            # A transcode's speed is content appearing, watched at segment
            # granularity rather than inferred from these window completions.
            produced_rate = self.produced_rate(object_id)
            if produced_rate > 0:
                overall = {**overall, "realtime": round(produced_rate, 2)}
        eta = self.eta(object_id)
        wire = self.transfer_rate(object_id)
        if wire > 0:
            # What is actually coming off the wire, measured as it lands,
            # rather than inferred from windows finishing.
            overall = {**overall, "mbps": round(wire * 8 / 1e6, 2)}
        if meta_now is not None and meta_now.source_bytes:
            # A copy lands at the size the device reports, so progress is the
            # honest fraction of it on disk rather than a count of windows.
            progress = self.entry_bytes(object_id) / meta_now.source_bytes * 100
        else:
            progress = (done_seconds / total_seconds * 100) if total_seconds else 0.0
        print(f"[cache] {object_id} w{w} done rc={rc} in {elapsed:.1f}s "
              f"({produced} segs, {size_mb:.0f} MB, {length / max(elapsed, 0.001):.1f}x realtime, "
              f"{size_bytes * 8 / max(elapsed, 0.001) / 1e6:.1f} Mb/s) "
              f"| {progress:.0f}% overall {overall['realtime']:.1f}x "
              f"{overall['mbps']:.1f} Mb/s"
              + (f", eta {eta / 60:.1f} min" if eta is not None else ", eta —"),
              flush=True)
        # The window's source was scaffolding: it has been cut into segments,
        # and keeping it would double what a copied window costs on disk.
        (wd / "source.ts").unlink(missing_ok=True)
        (wd / ".done").write_text(_now())

        # The end of the run, said once: how long it actually took, against
        # every "eta" printed on the way here.
        if total_seconds and self.windows_done(object_id) >= window_count(total_seconds):
            began = self._fill_started.pop(object_id, None)
            if began is not None:
                took = time.monotonic() - began
                print(f"[cache] {object_id} complete: "
                      f"{window_count(total_seconds)} windows in {took / 60:.1f} min "
                      f"({total_seconds / max(took, 0.001):.1f}x overall)", flush=True)
        # Any export built earlier no longer matches what is cached.
        self.export_path(object_id).unlink(missing_ok=True)

    # ------------------------------------------------------------------
    # Background fill
    # ------------------------------------------------------------------

    def start_prefetch(self, object_id: int, path: str, duration: int) -> None:
        if self._prefetch.get(object_id) or self.state(object_id) is CacheState.COMPLETE:
            return
        print(f"[cache] prefetch for {object_id} starting", flush=True)
        task = asyncio.create_task(self._prefetch_loop(object_id, path, duration))
        self._prefetch[object_id] = task
        task.add_done_callback(lambda _t: self._prefetch.pop(object_id, None))

    def ensure_prefetch(self, object_id: int) -> None:
        """Start background fill if nothing is running it, from stored metadata.

        ``start_prefetch`` used to be reachable only from ``/watch``, which made
        that one call a single point of failure for the entire read-ahead. A
        backend restart mid-playback left the player polling status and fetching
        segments perfectly happily, every window transcoded on demand one at a
        time - degraded for the rest of the session, with nothing in the log.

        The heartbeat is the dependable signal that someone is watching, so let
        it re-establish the fill rather than trusting a single earlier call.
        """
        if self._prefetch.get(object_id):
            return
        meta = self.read_meta(object_id)
        # Paused means "wanted offline, just not now"; a poll must not override
        # that. An unregistered recording has no path to fill from.
        if meta is None or meta.paused:
            return
        self.start_prefetch(object_id, meta.path, meta.source_duration)

    async def _prefetch_loop(self, object_id: int, path: str, duration: int) -> None:
        """Keep a bounded lookahead encoded ahead of the playhead.

        Two limits, both learned the hard way: only a window or so beyond what
        the viewer is likely to reach next, and only while someone is actually
        watching. A pinned recording ignores both and fills completely, because
        that is what being kept offline means.
        """
        if self._prefetch_slots is None:
            self._prefetch_slots = asyncio.Semaphore(PREFETCH_CONCURRENCY)
        sem = self._prefetch_slots
        total = window_count(duration)
        loop = asyncio.get_event_loop()
        # A fresh run is a fresh attempt: clear any prior failure so the card
        # stops reading FAILED while we try again (boot resume or a Resume tap).
        self.set_error(object_id, None)

        async def fill(w: int) -> None:
            # Yield to a waiting viewer, but not forever. This used to wait on
            # `_ondemand` emptying entirely, so a single claim that lingered -
            # or a viewer clicking around - stopped the background fill
            # completely: a recording could sit paused for minutes and cache
            # nothing. Waiting a bounded moment keeps seeks responsive without
            # letting them starve the fill.
            waited = 0.0
            while self._ondemand and waited < ONDEMAND_YIELD_SECONDS:
                await asyncio.sleep(0.5)
                waited += 0.5
            async with sem:
                if self.window_ready(object_id, w):
                    return
                try:
                    await self.ensure_window(object_id, w, path, duration)
                except Exception as e:
                    print(f"[cache] window {w} of {object_id} failed: {e}")

        while True:
            meta = self.read_meta(object_id)
            pinned = bool(meta and meta.pinned)

            if meta and meta.paused:
                # Wanted offline, just not now. Hold the loop rather than exit,
                # so resuming does not need to re-establish anything.
                await asyncio.sleep(2)
                continue

            if not pinned:
                seen = self._watch.get(object_id)
                if seen is None or loop.time() - seen[1] > WATCH_IDLE_TIMEOUT:
                    print(f"[cache] prefetch for {object_id} idle - stopping")
                    return
                first = int(seen[0] // WINDOW_SECONDS)
                last = fill_limit(first, total)
            else:
                first, last = 0, total

            todo = [w for w in range(first, last) if not self.window_ready(object_id, w)]
            if not todo:
                if pinned:
                    return                       # fully cached
                await asyncio.sleep(2)           # caught up; wait for playhead
                continue

            filling = todo[:PREFETCH_CONCURRENCY]
            batch = asyncio.gather(*(fill(w) for w in filling))
            # Checking for an idle viewer only between batches was too slow: a
            # batch runs for about a minute, so encoders kept a full machine busy
            # long after the tab closed. Poll while it runs instead.
            retarget = False
            while not batch.done():
                await asyncio.sleep(2)
                seen = self._watch.get(object_id)
                idle = seen is None or loop.time() - seen[1] > WATCH_IDLE_TIMEOUT
                if idle and not pinned:
                    print(f"[cache] prefetch for {object_id} idle - killing encoders")
                    batch.cancel()
                    self._kill_procs(object_id)
                    return
                # Follow the viewer. A batch runs for the best part of a minute,
                # and the playhead was only re-read between batches - so seeking
                # away left the fill grinding through windows nobody was going
                # to watch. Observed filling 0:00-8:00 while the viewer sat at
                # 17:30 waiting on an on-demand transcode.
                if seen and not pinned:
                    here = int(seen[0] // WINDOW_SECONDS)
                    if should_retarget(here, filling,
                                       here_ready=self.window_ready(object_id, here)):
                        print(f"[cache] prefetch for {object_id} re-targeting "
                              f"w{filling[0]}-w{filling[-1]} -> w{here}", flush=True)
                        batch.cancel()
                        # Drop only what this batch owns, and never the window
                        # the viewer is now waiting on.
                        for w in filling:
                            if (object_id, w) not in self._ondemand:
                                self._kill_window((object_id, w))
                        retarget = True
                        break
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await batch
            if retarget:
                continue

            # A pinned fill that made no progress this batch could not reach its
            # source (every window in the batch failed) — otherwise `todo` would
            # have shrunk. Rather than spin forever, mark it failed and stop; the
            # card shows an error and a Resume, which starts a fresh run. Only
            # for pinned: an on-demand fill following a viewer is allowed to wait.
            if pinned and not any(self.window_ready(object_id, w) for w in filling):
                print(f"[cache] prefetch for {object_id} made no progress - failing", flush=True)
                self.set_error(object_id, "The download could not be completed.")
                return

    async def stop(self, object_id: int) -> None:
        """Halt all work for a recording, leaving encoded windows on disk.

        Canceling the asyncio tasks is not sufficient: canceling ``proc.wait()``
        abandons the FFmpeg process rather than ending it, so the processes have
        to be killed explicitly.
        """
        self._watch.pop(object_id, None)
        task = self._prefetch.pop(object_id, None)
        if task:
            task.cancel()
        for key in [k for k in self._window_jobs if k[0] == object_id]:
            self._window_jobs.pop(key).cancel()

        self._kill_procs(object_id)

    async def shutdown(self) -> None:
        for oid in list(self._prefetch):
            await self.stop(oid)


def resolve_within(base: Path, filename: str) -> Path:
    """Resolve ``filename`` inside ``base``, rejecting escapes.

    Uses ``is_relative_to`` rather than a string-prefix comparison. The live
    transcode route compares with ``startswith``, which accepts an escape into a
    sibling directory whose name merely shares a prefix.
    """
    candidate = (base / filename).resolve()
    if not candidate.is_relative_to(base.resolve()):
        raise ValueError("path escapes cache directory")
    return candidate
