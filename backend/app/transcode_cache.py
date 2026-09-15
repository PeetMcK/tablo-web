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
import contextlib
import math
import os
import shutil
import signal
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from . import store

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


def deinterlace_filter() -> list[str]:
    """Deinterlacing, applied before any encoder-specific filtering.

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
    mode = os.environ.get("TRANSCODE_DEINTERLACE", "field").lower()
    if mode in ("off", "none", "0", ""):
        return []
    if mode == "frame":
        return ["bwdif=mode=send_frame:parity=auto:deint=interlaced"]
    return ["bwdif=mode=send_field:parity=auto:deint=interlaced"]


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
MAX_ONDEMAND_WINDOWS = int(os.environ.get("TRANSCODE_MAX_ONDEMAND", "4"))

# Seconds decoded before the window's real start and then discarded.
#
# `-ss` before `-i` is a fast seek: it jumps to the nearest point at or before
# the target and starts decoding there, which on MPEG-2 is usually mid-GOP. The
# resulting frames reference an I-frame that was never decoded, so the window
# opens with visible corruption and the player can stall on it. Seeking a little
# early and discarding the difference gives the decoder a clean run-up.
SEEK_PREROLL = 3.0

# Windows to keep encoded ahead of the playhead while watching. Filling the
# whole recording eagerly pinned every core long after playback stopped.
LOOKAHEAD_WINDOWS = int(os.environ.get("TRANSCODE_LOOKAHEAD_WINDOWS", "30"))

# Prefetch stops if the viewer has not checked in for this long, so closing the
# tab cannot leave encoders running.
WATCH_IDLE_TIMEOUT = 45

# Completed windows kept for the throughput readout. Each covers WINDOW_SECONDS
# of output, so six is roughly the last minute of encoding - long enough to ride
# out a slow device seek, short enough to still read as "live".
RATE_SAMPLES = 6

# No window has landed in this long, and nothing is encoding, so report idle
# rather than a stale average.
#
# Generous on purpose: a sample is only recorded when a window *finishes*, and
# a window takes 35-40s on CPU (longer on a slow device seek). A threshold near
# that makes the readout blink out between completions even though the download
# is running steadily. An active encoder overrides this entirely.
RATE_IDLE_AFTER = 180.0


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
        # Shared across every prefetch loop. Created lazily: there is no running
        # event loop at import time.
        self._prefetch_slots: asyncio.Semaphore | None = None
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
        except Exception:  # noqa: BLE001 - storage must not break playback
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
        if done > 0 or self._prefetch.get(object_id) or any(
            k[0] == object_id for k in self._window_jobs
        ):
            return CacheState.PARTIAL
        return CacheState.FAILED if meta.error else CacheState.PARTIAL

    def progress(self, object_id: int) -> float:
        meta = self.read_meta(object_id)
        if meta is None or not meta.source_duration:
            return 0.0
        return min(1.0, self.windows_done(object_id) / window_count(meta.source_duration))

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

        seconds = sum(s[2] for s in samples)
        if seconds <= 0:
            return idle
        written = sum(s[1] for s in samples)
        produced = sum(s[3] for s in samples)
        return {
            "mbps": round(written * 8 / seconds / 1e6, 2),
            "realtime": round(produced / seconds, 2),
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

    async def export_mp4(self, object_id: int) -> AsyncIterator[bytes]:
        """Stream the cached segments as a single MP4, remuxed not re-encoded.

        The segments are already H.264/AAC, so this only rewraps them: measured
        at 0.47s for 180s of video, which makes a full 3.5h recording about 35
        seconds and disk-bound rather than CPU-bound.

        MPEG-TS is fed in by byte concatenation rather than through the concat
        demuxer. Each window was muxed with ``-output_ts_offset``, so its
        timestamps are already absolute; the demuxer would shift them again and
        the result fails to mux with non-monotonic DTS.

        Fragmented MP4, because a normal ``+faststart`` file has to seek back
        and rewrite its header - which would mean staging the whole thing on
        disk and making the user wait before the download even starts.
        """
        segments = self.segment_files(object_id)
        if not segments:
            raise FileNotFoundError(f"nothing cached for {object_id}")

        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            # The TS carries absolute timestamps from the window offsets; let
            # FFmpeg rebuild presentation stamps rather than trusting the seam.
            "-fflags", "+genpts",
            "-i", "pipe:0",
            "-c", "copy",
            # The segments carry AAC in ADTS framing, which is how MPEG-TS
            # holds it; MP4 needs the raw form with the config in the sample
            # entry. Without this the muxer rejects the first audio packet with
            # "Malformed AAC bitstream detected" and the export dies a fraction
            # of a second in, having written only a header.
            "-bsf:a", "aac_adtstoasc",
            "-movflags", "+frag_keyframe+empty_moov",
            "-f", "mp4", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        async def feed() -> None:
            try:
                for seg in segments:
                    proc.stdin.write(seg.read_bytes())
                    await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass  # client hung up; the reader below stops too
            finally:
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    proc.stdin.close()

        pump = asyncio.create_task(feed())
        try:
            while True:
                chunk = await proc.stdout.read(256 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            # A cancelled download must not leave ffmpeg holding the pipe.
            pump.cancel()
            with contextlib.suppress(ProcessLookupError):
                if proc.returncode is None:
                    proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()

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
        except Exception:  # noqa: BLE001
            return []

    def set_paused(self, object_id: int, paused: bool) -> bool:
        meta = self.read_meta(object_id)
        if meta is None:
            return False
        meta.paused = paused
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
        """
        probe = self.root
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        usage = shutil.disk_usage(probe)
        total = self.total_bytes()
        pinned = self.pinned_bytes()
        return {
            "pinned_bytes": pinned,
            "cache_bytes": max(0, total - pinned),
            "total_bytes": total,
            "budget_bytes": self.budget,
            "free_bytes": usage.free,
            "pinned_count": len(self.pinned_ids()),
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

    async def register(self, object_id: int, path: str, source_duration: int) -> CacheMeta:
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
                    object_id=object_id, path=path, source_duration=source_duration
                )
                self.write_meta(meta)
            elif meta.source_duration != source_duration or meta.path != path:
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
                self.write_meta(meta)
            else:
                self.touch(object_id)

        self.heartbeat(object_id, 0.0)
        self.start_prefetch(object_id, path, source_duration)
        return meta

    # ------------------------------------------------------------------
    # Window encoding
    # ------------------------------------------------------------------

    def _signal_background(self, sig: int) -> None:
        for (proc, is_ondemand) in list(self._procs.values()):
            if is_ondemand or getattr(proc, "returncode", 0) is not None:
                continue
            try:
                proc.send_signal(sig)
            except Exception:  # noqa: BLE001 - process may have just exited
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
            except Exception:  # noqa: BLE001 - may have just exited
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
        while len(self._ondemand) > MAX_ONDEMAND_WINDOWS:
            oldest = next(iter(self._ondemand))
            if oldest == key:  # never evict the request being served
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
        except Exception:  # noqa: BLE001 - may have just exited
            pass

    def _pause_background(self) -> None:
        """SIGSTOP background encoders so an on-demand seek gets the CPU."""
        self._signal_background(signal.SIGSTOP)

    def _resume_background(self) -> None:
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

        prof = encoder_profile()
        # Deinterlace ahead of anything encoder-specific: VAAPI's chain ends in
        # hwupload, and frames have to be progressive before they leave for the
        # GPU.
        filters = [*deinterlace_filter(), *prof.filters]
        cmd = [
            "ffmpeg", "-y",
            # 'file' is deliberately excluded: input_url is device-controlled.
            "-protocol_whitelist", "http,https,tcp,tls",
            *prof.pre_input,
            # Fast input seek to just before the window. Measured flat (~5s)
            # regardless of offset.
            "-ss", f"{seek_to:.3f}",
            "-i", playlist_url,
            # Accurate output seek across the pre-roll, so the window begins on
            # cleanly decoded frames rather than mid-GOP artefacts.
            *(["-ss", f"{preroll:.3f}"] if preroll > 0 else []),
            "-t", f"{length:.3f}",
            # Each window is encoded independently, so without this every window's
            # output would start at PTS ~0 and the player would snap back to the
            # beginning on each boundary. Offsetting makes timestamps absolute and
            # continuous across the whole recording.
            "-output_ts_offset", str(start),
            # Pins keyframes to exact segment boundaries so the window's segment
            # count matches what the published playlist already declared.
            "-force_key_frames", f"expr:gte(t,n_forced*{SEGMENT_SECONDS})",
            *(["-vf", ",".join(filters)] if filters else []),
            "-c:v", prof.name, *prof.flags,
            *(["-pix_fmt", prof.pix_fmt] if prof.pix_fmt else []),
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

        log = open(wd / "ffmpeg.log", "w")  # noqa: ASYNC230, SIM115
        log.write(f"window {w}  start={start}s  len={length:.3f}s\n{' '.join(cmd)}\n\n")
        log.flush()
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=str(wd), stdout=log, stderr=asyncio.subprocess.STDOUT
            )
            self._procs[(object_id, w)] = (proc, on_demand)
            # A background window started before the seek arrived must also yield.
            if self._ondemand and not on_demand:
                try:
                    proc.send_signal(signal.SIGSTOP)
                except Exception:  # noqa: BLE001
                    pass
            rc = await proc.wait()
        finally:
            self._procs.pop((object_id, w), None)
            log.close()

        elapsed = asyncio.get_event_loop().time() - t0
        expected = segments_in_window(duration, w)
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
            last = sorted(wd.glob("seg_*.ts"))[-1]
            for n in range(produced, expected):
                shutil.copyfile(last, wd / f"seg_{n:02d}.ts")

        size_bytes = sum(f.stat().st_size for f in wd.glob("seg_*.ts"))
        size_mb = size_bytes / 1024**2
        samples = self._rate.setdefault(object_id, deque(maxlen=RATE_SAMPLES))
        samples.append((time.monotonic(), size_bytes, elapsed, length))
        print(f"[cache] {object_id} w{w} done rc={rc} in {elapsed:.1f}s "
              f"({produced} segs, {size_mb:.0f} MB, {length / max(elapsed, 0.001):.1f}x realtime, "
              f"{size_bytes * 8 / max(elapsed, 0.001) / 1e6:.1f} Mb/s)",
              flush=True)
        (wd / ".done").write_text(_now())

    # ------------------------------------------------------------------
    # Background fill
    # ------------------------------------------------------------------

    def start_prefetch(self, object_id: int, path: str, duration: int) -> None:
        if self._prefetch.get(object_id) or self.state(object_id) is CacheState.COMPLETE:
            return
        task = asyncio.create_task(self._prefetch_loop(object_id, path, duration))
        self._prefetch[object_id] = task
        task.add_done_callback(lambda _t: self._prefetch.pop(object_id, None))

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

        async def fill(w: int) -> None:
            while self._ondemand:
                await asyncio.sleep(0.5)
            async with sem:
                if self.window_ready(object_id, w):
                    return
                try:
                    await self.ensure_window(object_id, w, path, duration)
                except Exception as e:  # noqa: BLE001 - background best-effort
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
                last = min(total, first + LOOKAHEAD_WINDOWS)
            else:
                first, last = 0, total

            todo = [w for w in range(first, last) if not self.window_ready(object_id, w)]
            if not todo:
                if pinned:
                    return                       # fully cached
                await asyncio.sleep(2)           # caught up; wait for playhead
                continue

            batch = asyncio.gather(*(fill(w) for w in todo[:PREFETCH_CONCURRENCY]))
            # Checking for an idle viewer only between batches was too slow: a
            # batch runs for about a minute, so encoders kept a full machine busy
            # long after the tab closed. Poll while it runs instead.
            while not batch.done():
                await asyncio.sleep(2)
                seen = self._watch.get(object_id)
                idle = seen is None or loop.time() - seen[1] > WATCH_IDLE_TIMEOUT
                if idle and not pinned:
                    print(f"[cache] prefetch for {object_id} idle - killing encoders")
                    batch.cancel()
                    self._kill_procs(object_id)
                    return
            try:
                await batch
            except asyncio.CancelledError:
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
