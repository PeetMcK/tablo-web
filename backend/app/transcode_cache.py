"""Persistent transcode cache for recordings.

Recordings are immutable once ``video_details.state == "finished"``, and they are
MPEG-2 — which no browser can decode. Transcoding them on every play would repeat
hours of CPU work per viewer, so output is cached on the ``/data`` volume keyed by
``object_id`` and reused.

Caching is what makes seeking possible at all: the live transcoder uses a sliding
six-segment window with ``delete_segments``, so nothing older than ~36s exists on
disk. Here the full playlist is kept, and becomes a normal VOD playlist once the
job finishes.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("TRANSCODE_CACHE_DIR", "/data/cache/recordings"))

# Total cache budget. Evicted LRU once exceeded.
CACHE_BUDGET_BYTES = int(float(os.environ.get("TRANSCODE_CACHE_GB", "20")) * 1024**3)

# Device advertises keepalive: 165. Stay comfortably under it.
KEEPALIVE_INTERVAL = 150

SEGMENT_SECONDS = 6
VIDEO_BITRATE_BPS = 4_000_000
MIN_FREE_BYTES = 2 * 1024**3


class CacheState(str, Enum):
    ABSENT = "absent"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class CacheMeta:
    object_id: int
    path: str
    state: str = CacheState.ABSENT.value
    source_duration: int = 0
    bytes: int = 0
    created_at: str = field(default_factory=_now)
    completed_at: str | None = None
    last_access: str = field(default_factory=_now)
    error: str | None = None


class CacheFull(RuntimeError):
    """Raised when a job cannot start without evicting a running job."""


class InsufficientDisk(RuntimeError):
    """Raised when free space is too low to safely start a transcode."""


class TranscodeCache:
    """Owns the lifecycle of cached recording transcodes.

    ``session_starter`` is injected rather than imported so this module stays free
    of device-auth concerns and can be tested without a Tablo.  It takes a
    recording path and returns the device's watch response
    (``playlist_url``, ``keepalive``, ...).
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
        self._jobs: dict[int, asyncio.subprocess.Process] = {}
        self._keepalives: dict[int, asyncio.Task] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        # Directory creation is deliberately lazy. This object is constructed at
        # import time, and CI imports the app on a runner with no /data volume.

    # ------------------------------------------------------------------
    # Layout
    # ------------------------------------------------------------------

    def dir_for(self, object_id: int) -> Path:
        return self.root / str(int(object_id))

    def _meta_path(self, object_id: int) -> Path:
        return self.dir_for(object_id) / "meta.json"

    def playlist_path(self, object_id: int) -> Path:
        return self.dir_for(object_id) / "playlist.m3u8"

    def read_meta(self, object_id: int) -> CacheMeta | None:
        p = self._meta_path(object_id)
        if not p.exists():
            return None
        try:
            return CacheMeta(**json.loads(p.read_text()))
        except Exception:
            return None

    def write_meta(self, meta: CacheMeta) -> None:
        d = self.dir_for(meta.object_id)
        d.mkdir(parents=True, exist_ok=True)
        # Write-then-rename so a crash mid-write cannot leave unparseable metadata.
        tmp = d / "meta.json.tmp"
        tmp.write_text(json.dumps(asdict(meta), indent=2))
        tmp.replace(d / "meta.json")

    def _lock(self, object_id: int) -> asyncio.Lock:
        return self._locks.setdefault(object_id, asyncio.Lock())

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------

    def state(self, object_id: int) -> CacheState:
        """Current state, reconciling metadata against the live process table.

        A directory marked RUNNING whose process is gone (container killed
        mid-job) is reported FAILED rather than wedging that recording forever.
        """
        meta = self.read_meta(object_id)
        if meta is None:
            return CacheState.ABSENT
        if meta.state == CacheState.RUNNING.value:
            proc = self._jobs.get(object_id)
            if proc is None or proc.returncode is not None:
                return CacheState.FAILED
            return CacheState.RUNNING
        try:
            return CacheState(meta.state)
        except ValueError:
            return CacheState.FAILED

    def progress(self, object_id: int) -> float:
        """Fraction of the source encoded so far, 0.0-1.0."""
        meta = self.read_meta(object_id)
        if meta is None or not meta.source_duration:
            return 0.0
        if self.state(object_id) is CacheState.COMPLETE:
            return 1.0
        encoded = self._segment_count(object_id) * SEGMENT_SECONDS
        return min(1.0, encoded / meta.source_duration)

    def _segment_count(self, object_id: int) -> int:
        d = self.dir_for(object_id)
        if not d.exists():
            return 0
        return sum(1 for _ in d.glob("seg_*.ts"))

    def touch(self, object_id: int) -> None:
        meta = self.read_meta(object_id)
        if meta:
            meta.last_access = _now()
            self.write_meta(meta)

    # ------------------------------------------------------------------
    # Housekeeping
    # ------------------------------------------------------------------

    def sweep_orphans(self) -> list[int]:
        """Mark RUNNING entries as FAILED at startup.

        After a restart the process table is empty but directories may still say
        RUNNING. Without this they would never be retried.
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
            meta = self.read_meta(oid)
            if meta and meta.state == CacheState.RUNNING.value:
                meta.state = CacheState.FAILED.value
                meta.error = "interrupted by restart"
                self.write_meta(meta)
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

    def evict(self, object_id: int) -> bool:
        """Remove one entry. Refuses to evict a running job."""
        if self.state(object_id) is CacheState.RUNNING:
            return False
        d = self.dir_for(object_id)
        if not d.exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True

    def make_room(self, needed_bytes: int = 0) -> None:
        """Evict least-recently-accessed entries until under budget.

        Running jobs are never evicted; if the budget cannot be met without
        touching one, raise rather than thrash.
        """
        target = self.budget - needed_bytes
        if self.total_bytes() <= target:
            return
        if not self.root.exists():
            return

        candidates = []
        for d in self.root.iterdir():
            if not d.is_dir():
                continue
            try:
                oid = int(d.name)
            except ValueError:
                continue
            if self.state(oid) is CacheState.RUNNING:
                continue
            meta = self.read_meta(oid)
            candidates.append((meta.last_access if meta else "", oid))

        candidates.sort()  # oldest last_access first
        for _, oid in candidates:
            if self.total_bytes() <= target:
                return
            self.evict(oid)

        if self.total_bytes() > target:
            raise CacheFull(
                "cache budget cannot be met without evicting an in-progress transcode"
            )

    def _check_disk(self, estimated_bytes: int) -> None:
        # Walk up to the nearest existing ancestor: the cache root may not exist
        # yet on the first call.
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
    # Job lifecycle
    # ------------------------------------------------------------------

    async def ensure(self, object_id: int, path: str, source_duration: int) -> CacheMeta:
        """Return cache metadata, starting a transcode if needed.

        Concurrent callers for the same recording share one FFmpeg process and one
        device session — the second caller attaches to the running job.
        """
        async with self._lock(object_id):
            st = self.state(object_id)
            if st in (CacheState.COMPLETE, CacheState.RUNNING):
                self.touch(object_id)
                meta = self.read_meta(object_id)
                assert meta is not None
                return meta

            # ABSENT or FAILED: (re)start from clean state.
            estimated = self.estimate_bytes(source_duration)
            self._check_disk(estimated)
            self.make_room(estimated)

            d = self.dir_for(object_id)
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True, exist_ok=True)

            session = await self._start_session(path)
            playlist_url = session.get("playlist_url")
            if not playlist_url:
                raise RuntimeError(f"device returned no playlist_url for {path}")

            meta = CacheMeta(
                object_id=object_id,
                path=path,
                state=CacheState.RUNNING.value,
                source_duration=source_duration,
            )
            self.write_meta(meta)

            proc = await self._spawn_ffmpeg(d, playlist_url)
            self._jobs[object_id] = proc
            self._keepalives[object_id] = asyncio.create_task(
                self._keepalive_loop(object_id, path)
            )
            asyncio.create_task(self._await_completion(object_id, proc))
            return meta

    async def _spawn_ffmpeg(self, cwd: Path, input_url: str) -> asyncio.subprocess.Process:
        cmd = [
            "ffmpeg", "-y",
            # 'file' is deliberately excluded - the live transcoder whitelists it
            # without needing it, and input_url is device-controlled.
            "-protocol_whitelist", "http,https,tcp,tls",
            "-i", input_url,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-maxrate", "4000k", "-bufsize", "8000k",
            "-pix_fmt", "yuv420p", "-g", "60",
            "-c:a", "aac", "-b:a", "160k", "-ac", "2",
            "-f", "hls",
            "-hls_time", str(SEGMENT_SECONDS),
            # Keep every segment: this is what makes the result seekable.
            "-hls_list_size", "0",
            "-hls_playlist_type", "event",
            "-hls_segment_filename", "seg_%05d.ts",
            "-loglevel", "warning",
            "playlist.m3u8",
        ]
        # Intentionally not a context manager: the handle is the subprocess's
        # stdout for the life of the job and is closed when FFmpeg exits.
        log = open(cwd / "ffmpeg.log", "w")  # noqa: ASYNC230, SIM115
        log.write(f"input: {input_url}\ncmd: {' '.join(cmd)}\n\n")
        log.flush()
        return await asyncio.create_subprocess_exec(
            *cmd, cwd=str(cwd), stdout=log, stderr=asyncio.subprocess.STDOUT
        )

    async def _keepalive_loop(self, object_id: int, path: str) -> None:
        """Refresh the device session while ingesting.

        The device expires watch sessions ~3.5 minutes out. A multi-hour recording
        would otherwise lose its source partway through, truncating the cache.
        """
        try:
            while True:
                await asyncio.sleep(KEEPALIVE_INTERVAL)
                proc = self._jobs.get(object_id)
                if proc is None or proc.returncode is not None:
                    return
                try:
                    await self._start_session(path)
                except Exception as e:  # noqa: BLE001 - keepalive is best-effort
                    print(f"[cache] keepalive failed for {object_id}: {e}")
        except asyncio.CancelledError:
            pass

    async def _await_completion(self, object_id: int, proc) -> None:
        rc = await proc.wait()
        task = self._keepalives.pop(object_id, None)
        if task:
            task.cancel()
        self._jobs.pop(object_id, None)

        meta = self.read_meta(object_id)
        if meta is None:
            return

        if rc == 0 and self.playlist_path(object_id).exists():
            self._finalize_playlist(object_id)
            meta.state = CacheState.COMPLETE.value
            meta.completed_at = _now()
            meta.bytes = self.entry_bytes(object_id)
            meta.error = None
        else:
            meta.state = CacheState.FAILED.value
            meta.error = f"ffmpeg exited {rc}"
        self.write_meta(meta)

    def _finalize_playlist(self, object_id: int) -> None:
        """Turn the EVENT playlist into a VOD playlist.

        FFmpeg writes ``#EXT-X-ENDLIST`` on clean exit but leaves the type as
        EVENT; players only enable full seeking for VOD.
        """
        p = self.playlist_path(object_id)
        try:
            text = p.read_text()
        except OSError:
            return
        text = text.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD")
        if "#EXT-X-ENDLIST" not in text:
            text = text.rstrip("\n") + "\n#EXT-X-ENDLIST\n"
        p.write_text(text)

    async def stop(self, object_id: int) -> None:
        """Cancel an in-progress job and mark it failed."""
        proc = self._jobs.pop(object_id, None)
        task = self._keepalives.pop(object_id, None)
        if task:
            task.cancel()
        if proc and proc.returncode is None:
            proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass
        meta = self.read_meta(object_id)
        if meta and meta.state == CacheState.RUNNING.value:
            meta.state = CacheState.FAILED.value
            meta.error = "cancelled"
            self.write_meta(meta)

    async def shutdown(self) -> None:
        for oid in list(self._jobs):
            await self.stop(oid)


def resolve_within(base: Path, filename: str) -> Path:
    """Resolve ``filename`` inside ``base``, rejecting escapes.

    Uses ``is_relative_to`` rather than a string-prefix comparison. The live
    transcode route compares with ``startswith``, which lets a session named
    ``abc`` read files under a sibling directory named ``abcd``.
    """
    candidate = (base / filename).resolve()
    if not candidate.is_relative_to(base.resolve()):
        raise ValueError("path escapes cache directory")
    return candidate
