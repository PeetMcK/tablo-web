"""Minimal working version."""

import asyncio
import os
import re
import shutil
import signal
import subprocess
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from ..live_follower import RingFollower
from ..live_ring import SegmentRing
from ..state import state
from ..transcode_cache import (
    deinterlace_filter,
    encoder_profile,
    square_pixels_filter,
)
from ..vod_index import VodIndex, parse_vod_playlist

router = APIRouter(tags=["stream"])

TRANSCODE_DIR = Path("/tmp/tablo_transcode")
TRANSCODE_DIR.mkdir(exist_ok=True)

transcode_procs: dict[str, subprocess.Popen] = {}

# When each live session was last asked for, by session id. A player fetches
# the playlist about every segment, so silence here means nobody is watching.
session_touched: dict[str, float] = {}

MAX_TRANSCODE_SESSIONS = 4

# How long a live transcode may go unasked-for before it is killed, and how
# often to look. The only orderly way a session ends is DELETE /stream/{id},
# which a closed laptop, a killed tab or a dropped network never sends - and
# the transcode holds a tuner on the device until something stops it.
#
# Segment fetches alone are not the signal: a player paused on live fills its
# buffer and then stops asking, while still being watched in every sense that
# matters. The player pings /transcode/status while it holds a live session,
# which is what this timeout is really measuring the absence of - two minutes
# of silence from a thirty-second heartbeat.
LIVE_IDLE_SECONDS = int(os.environ.get("LIVE_IDLE_SECONDS", "120"))
REAP_INTERVAL = 30.0

# Rolling DVR window for live transcodes, in segments of HLS_TIME seconds.
# A 6-segment window (~36s) leaves nothing to rewind into; widening it is what
# makes pause and rewind work on live. delete_segments is kept so the window
# stays bounded - without it a forgotten session grows until the disk fills.
HLS_TIME = 6
LIVE_DVR_MINUTES = int(os.environ.get("LIVE_DVR_MINUTES", "60"))
LIVE_DVR_SEGMENTS = max(6, LIVE_DVR_MINUTES * 60 // HLS_TIME)
# The same window, in seconds, for the raw ring - which counts duration rather
# than segments because the device chooses its own segment length.
LIVE_DVR_SECONDS = LIVE_DVR_SEGMENTS * HLS_TIME

# Raw MPEG-2 segments copied off the device for the WASM live path. Separate
# from TRANSCODE_DIR so the startup cleanup below cannot confuse the two.
RAW_DIR = Path("/tmp/tablo_raw")
RAW_DIR.mkdir(exist_ok=True)

# How much media the ring must hold before the browser is told the session
# exists, and how long that may take.
#
# MPEG-TS has no header: it describes itself periodically, so opening a live
# stream means listening until the tables come round. A browser handed a ring
# holding one segment gets a trickle - a segment per poll - and that is the one
# condition the WASM path has never reliably started under. Filling the ring
# first makes a cold channel open under the conditions a warm one works under.
#
# The wait is not new. The transcode path already waits up to twelve seconds
# for its first playlist segment behind the same spinner.
RING_PRIME_SECONDS = float(os.environ.get("RING_PRIME_SECONDS", "8"))
RING_PRIME_TIMEOUT_SECONDS = float(os.environ.get("RING_PRIME_TIMEOUT_SECONDS", "15"))
# How long any single device request may take before it is abandoned.
DEVICE_TIMEOUT_SECONDS = float(os.environ.get("DEVICE_TIMEOUT_SECONDS", "10"))

# How often the follower asks the device for new segments.
#
# Faster than the device's own segment cadence on purpose. The ring is what the
# browser's runway is measured against, and a follower that checks every two
# seconds hands that runway out in lumps of that size - which is what a player
# starting a few seconds behind the live edge then runs out of.
RING_POLL_INTERVAL_SECONDS = float(os.environ.get("RING_POLL_INTERVAL_SECONDS", "1"))

# A session id is hex, and a raw segment is the five-digit name the ring gave
# it. Both are matched rather than sanitised: anything else is not ours.
_SESSION_RE = re.compile(r"^[0-9a-f]{8,64}$")
_SEGMENT_RE = re.compile(r"^\d{5}\.ts$")
# A VOD segment may also be asked for with its audio converted, which is a
# different name because it is different bytes for the same instant.
_VOD_SEGMENT_RE = re.compile(r"^(\d{5})(\.aac)?\.ts$")

LIVE_MODES = ("transcode", "raw", "ring")

# session_id -> (ring, follower, polling task)
ring_sessions: dict[str, tuple[SegmentRing, RingFollower | None, asyncio.Task | None]] = {}

# One ring per channel, however many windows are watching it.
#
# A tuner is the scarce thing here - this device has four - and nothing about
# the ring needs one per viewer: the follower already fetches each segment from
# the device exactly once and every viewer reads the same files off disk. But
# `start_stream` opened a fresh device watch and minted a new session id on
# every request, so five windows on one channel took five tuners to fetch
# identical bytes, and the fifth got a 503.
#
# Sharing needs two things the per-session case did not: a way to find the ring
# for a channel, and a count of who is watching it, so that one window closing
# does not stop the stream for the other four. The heartbeat needs neither -
# every viewer polls the same playlist, so the existing idle reaper already
# sees the session as busy while anyone is watching.
ring_for_channel: dict[str, str] = {}
ring_channel_of: dict[str, str] = {}
ring_viewers: dict[str, int] = {}

# Recordings, served straight from the device by byte range.
#
# Nothing here is copied to disk: a 3.5 hour recording is ~25GB, and the device
# already has it. What we hold is the index - every segment's uri, byte range
# and duration - which is a few hundred KB and is what makes seeking anywhere
# in a three-hour recording one fetch away.
#
# A recording still being written is the same thing, still growing, so the
# device's playlist is re-read as it goes. That is why `device_url` is kept.
vod_sessions: dict[str, "VodSession"] = {}


@dataclass
class VodSession:
    """An index over a recording, and where to re-read it if it is growing."""

    index: VodIndex
    #: The device's *variant* playlist, already resolved from its master.
    device_url: str
    #: True for a recording the device encoded itself, whose AC-3 audio no
    #: browser but Safari will decode. Decided once, when the session opens,
    #: from the device's own codec label - it names every segment published.
    swap_audio: bool = False
    refreshed_at: float = field(default_factory=time.monotonic)


# How stale a growing index may be before the next ask re-reads the device.
#
# The device appends about a segment a second; the player polls this about twice
# a second. Re-reading on every ask would multiply a poll into two device
# requests for content that has not changed, and on a long recording each of
# those is a playlist of thousands of lines.
VOD_REFRESH_SECONDS = 3.0

# What identifies one of our FFmpeg processes from the outside, once the dict
# that held it is gone. It has to appear in the command line for `pgrep -f` to
# find it - see the absolute playlist path in `live_ffmpeg_cmd`.
SWEEP_MARKER = TRANSCODE_DIR.name


# Kill any FFmpeg processes left over from a previous run and wipe stale dirs.
# After a container restart transcode_procs is empty but old FFmpeg processes
# may still be alive (or their directories still on disk), which exhaust CPU
# and cause new sessions to time out waiting for their first playlist segment.
def _startup_cleanup():
    try:
        # `check=False`: pgrep exits 1 when it matches nothing, which is the
        # ordinary case on a clean start, not a failure.
        result = subprocess.run(
            ["pgrep", "-f", SWEEP_MARKER], capture_output=True, text=True, check=False
        )
        for pid in result.stdout.split():
            try:
                os.kill(int(pid), signal.SIGKILL)
            except Exception:
                pass
    except Exception:
        pass
    for d in TRANSCODE_DIR.iterdir():
        try:
            shutil.rmtree(d)
        except Exception:
            pass
    sweep_stale_raw_dirs()


def sweep_stale_raw_dirs(idle_seconds: float = 60.0, now: float | None = None) -> list[str]:
    """Delete ring directories nothing is writing to any more.

    A ring session that ends without its DELETE - a crash, a kill -9 - leaves
    its segments behind, and an hour of 1080i is gigabytes.

    Only directories untouched for ``idle_seconds`` go. A live follower writes
    a segment every couple of seconds, so this cannot take the ring out from
    under a *different* backend sharing the directory. That is not a
    hypothetical: running a second backend beside the user's own is the
    documented way to test this path, and the transcode cleanup above already
    kills the other one's FFmpeg for exactly the want of this check.
    """
    import time

    cutoff = (time.time() if now is None else now) - idle_seconds
    removed: list[str] = []
    try:
        entries = list(RAW_DIR.iterdir())
    except Exception:
        return removed

    for directory in entries:
        if not directory.is_dir() or directory.name in ring_sessions:
            continue
        try:
            newest = max(
                (f.stat().st_mtime for f in directory.iterdir()),
                default=directory.stat().st_mtime,
            )
            if newest >= cutoff:
                continue
            shutil.rmtree(directory)
            removed.append(directory.name)
        except Exception:
            pass
    return removed


_startup_cleanup()


def touch_session(session_id: str) -> None:
    """Mark a live session as still wanted. Cheap enough for every request.

    Both kinds count. A ring session holds a tuner exactly as a transcode does,
    and grows an hour of raw 1080i besides - so leaving it out of the heartbeat
    meant nothing ever reaped it, and a closed laptop held both for the life of
    the backend.
    """
    if (session_id in transcode_procs or session_id in ring_sessions
            or session_id in vod_sessions):
        session_touched[session_id] = time.monotonic()


def _kill(session_id: str) -> None:
    proc = transcode_procs.pop(session_id, None)
    session_touched.pop(session_id, None)
    if proc:
        try:
            proc.kill()
            proc.wait(timeout=3)
        except Exception:
            pass


def _stop_ring(session_id: str) -> None:
    """Cancel a ring session's follower and drop what it was holding."""
    ring_viewers.pop(session_id, None)
    channel = ring_channel_of.pop(session_id, None)
    # Only if it still points at us: a channel reopened after this session was
    # reaped already points at its successor.
    if channel is not None and ring_for_channel.get(channel) == session_id:
        del ring_for_channel[channel]
    entry = ring_sessions.pop(session_id, None)
    if entry is None:
        return
    ring, _follower, task = entry
    print(
        f"[ring] {session_id} stopping, held {ring.held_seconds:.1f}s"
        f" in {len(ring.segments)} segments",
        flush=True,
    )
    if task is not None:
        task.cancel()
    shutil.rmtree(RAW_DIR / session_id, ignore_errors=True)


def await_release(session_id: str) -> None:
    """Release a device session from sync code, without blocking the caller."""
    try:
        asyncio.get_running_loop().create_task(
            state.release_stream_session(session_id)
        )
    except RuntimeError:
        # No loop (a test, or shutdown): drop our own record at least.
        state.stop_session(session_id)


def reap_idle_sessions() -> list[str]:
    """End live sessions nobody has asked about in LIVE_IDLE_SECONDS.

    Both kinds. A transcode holds a tuner and a core; a ring session holds a
    tuner and up to LIVE_DVR_SECONDS of raw 1080i - about 7-8GB at this
    device's bitrate, roughly eight times the transcode window's footprint.
    Neither is ended by a viewer who closes the lid, because the only orderly
    stop is a DELETE that never arrives.

    Ring sessions were not covered at all until this, and nothing else could
    have caught them: `sweep_stale_raw_dirs` skips any directory belonging to a
    live session precisely so it cannot delete one out from under a running
    follower, and the follower's own loop runs until it is cancelled.

    Returns the sessions it ended, for the log.
    """
    now = time.monotonic()
    stale = [
        sid for sid in list(transcode_procs) + list(ring_sessions) + list(vod_sessions)
        # A session that has never been touched is one started moments ago,
        # before its player asked for anything. Give it the same grace.
        if now - session_touched.setdefault(sid, now) > LIVE_IDLE_SECONDS
    ]
    for sid in stale:
        _kill(sid)
        _stop_ring(sid)
        vod_sessions.pop(sid, None)
        try:
            shutil.rmtree(TRANSCODE_DIR / sid)
        except Exception:
            pass
        # Tell the device, or the session it opened is only ever released by
        # its own expiry - which is how a restart of this backend used to leave
        # one behind for every stream it held.
        await_release(sid)
    return stale


# The old name, kept because it says what most callers mean.
reap_idle_transcoders = reap_idle_sessions


# How often to refresh the device's watch sessions.
#
# The device hands out sessions with `keepalive: 165` - they expire in under
# three minutes unless refreshed, and nothing here ever refreshed one. That is
# what killed a live WASM session at about three and a half minutes: the token
# expired, the device answered 404 for every segment, the ring stopped filling,
# and the player sat on an empty playlist showing nothing.
#
# Comfortably inside the window, because a missed refresh costs the stream.
KEEPALIVE_INTERVAL = float(os.environ.get("KEEPALIVE_INTERVAL", "60"))


async def keepalive_forever():
    """Refresh the sessions someone is actually watching - and only those.

    Refreshing every session we hold would make the expiry useless as a
    backstop: an abandoned session would be renewed for ever by the very loop
    meant to keep live ones alive, and a tuner would be locked out until the
    process ended. Tying the refresh to the same heartbeat the reaper uses
    inverts that. Nobody asking means nobody refreshing, and the device's own
    165-second expiry releases it without us having to be alive to notice -
    which covers the one case we can never handle ourselves, a crash that takes
    the token with it.

    So a session survives exactly as long as someone is watching it:

    * viewer connected -> playlist polled -> touched -> refreshed here
    * viewer gone      -> not touched     -> not refreshed -> expires (165s),
      and the reaper ends our side of it at LIVE_IDLE_SECONDS (120s) first
    """
    while True:
        await asyncio.sleep(KEEPALIVE_INTERVAL)
        now = time.monotonic()
        live = list(transcode_procs) + list(ring_sessions) + list(vod_sessions)
        for session_id in live:
            touched = session_touched.get(session_id)
            if touched is None or now - touched > LIVE_IDLE_SECONDS:
                continue                      # nobody is watching; let it lapse
            token = state.session_token(session_id)
            if token:
                await state.keepalive_stream_session(token)


async def release_all_sessions() -> None:
    """Hand every device session back before this process goes.

    Otherwise a restart leaks one per live stream: the token lives only in this
    process, so once it is gone nothing can ever delete that session and the
    device holds it until expiry. Nine restarts in one evening is how this was
    found.
    """
    for session_id in list(transcode_procs) + list(ring_sessions) + list(vod_sessions):
        try:
            await state.release_stream_session(session_id)
        except Exception:
            pass


async def reap_forever():
    """The sweep has to run on a timer, not on a request.

    The case it exists for is precisely the one where no request is ever coming
    again: the tab is gone and nothing will ask for this session or any other.
    """
    while True:
        await asyncio.sleep(REAP_INTERVAL)
        try:
            if killed := reap_idle_sessions():
                print(f"[stream] reaped {len(killed)} idle session(s): {killed}",
                      flush=True)
        except Exception as e:
            print(f"[stream] reap failed: {e}", flush=True)


def shutdown_transcoders():
    """Kill every live transcoder this process started.

    A live transcode holds a tuner on the device for as long as it runs, and
    these PIDs live nowhere but the dict above. Exiting without this leaves them
    reparented to init - still pulling segments, still holding the tuner, with
    nothing left that knows how to stop them. Two were found that way after a
    restart, 23 and 10 minutes old.
    """
    for session_id in list(transcode_procs):
        _kill(session_id)


# ─────────────────────────────────────────────────────────────────────────────
# TRANSCODED
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/transcoded/{session_id}/{path:path}")
async def transcoded_stream(session_id: str, path: str, request: Request):
    # Security: Ensure session_id is a valid hex string to prevent path traversal
    if not all(c in "0123456789abcdefABCDEF" for c in session_id):
        raise HTTPException(400, "Invalid session ID")

    touch_session(session_id)

    session_dir = TRANSCODE_DIR / session_id
    # Security: Normalize path and prevent traversing out of session_dir
    try:
        file_path = (session_dir / path).resolve()
        if not str(file_path).startswith(str(session_dir.resolve())):
            raise ValueError("Traversal attempt")
    except Exception:
        raise HTTPException(400, "Invalid path")

    # Wait up to 10 seconds (async) for the manifest to appear if it's the playlist
    if path == "playlist.m3u8" and not file_path.exists():
        for _ in range(20):
            if file_path.exists():
                break
            await asyncio.sleep(0.5)

    if not file_path.exists() or not file_path.is_file():
        # Check if FFmpeg is still alive to provide a better error
        proc = transcode_procs.get(session_id)
        status = "unknown"
        if proc:
            status = "alive" if proc.poll() is None else f"exited with {proc.returncode}"
        raise HTTPException(404, f"File not found: {path} (Transcoder: {status})")

    # Official HLS media type
    hls_type = "application/vnd.apple.mpegurl"

    if path.endswith(".m3u8"):
        # Return 200 (not 206) — HLS players expect 200 for playlists
        return Response(
            content=file_path.read_bytes(),
            media_type=hls_type,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache, no-store",
                "Content-Disposition": "inline",
            },
        )
    elif path.endswith(".ts"):
        return FileResponse(
            file_path,
            media_type="video/mp2t",
            headers={"Access-Control-Allow-Origin": "*"}
        )

    return FileResponse(file_path, headers={"Access-Control-Allow-Origin": "*"})


# ---------------------------------------------------------------------------
# Start stream (with smart transcoding)
# ---------------------------------------------------------------------------

@router.post("/stream/{identifier}")
async def start_stream(
    identifier: str,
    request: Request,
    transcode: bool = Query(default=False),
    mode: str | None = Query(default=None),
):
    """Open a live session.

    ``mode`` picks how the bytes reach the browser: ``transcode`` runs FFmpeg
    as it always has, ``raw`` proxies the device's own HLS untouched (fine for
    OTT, unplayable for MPEG-2), and ``ring`` copies the device's segments into
    a DVR window of our own for the WASM decoder to chew on.

    The older boolean ``transcode`` still works and means ``mode=transcode``.
    """
    if mode is not None and mode not in LIVE_MODES:
        raise HTTPException(status_code=422, detail=f"Unknown mode: {mode}")
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")

    resolved_mode = mode or ("transcode" if transcode else "raw")

    # Already watching this channel? Join that ring rather than taking another
    # tuner for the same bytes. Checked before the device is touched at all,
    # because touching it is precisely what costs the tuner.
    if resolved_mode == "ring":
        shared = ring_for_channel.get(identifier)
        if shared and shared in ring_sessions:
            ring_viewers[shared] = ring_viewers.get(shared, 1) + 1
            touch_session(shared)
            print(
                f"[ring] {shared} joined for {identifier}"
                f" ({ring_viewers[shared]} viewers, no extra tuner)",
                flush=True,
            )
            return {
                "session_id": shared,
                "stream_url": f"/api/raw/{shared}/playlist.m3u8",
                "mode": "ring",
                "transcode": False,
                "shared": True,
            }

    try:
        session_id, sess = await state.start_stream(identifier)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # A 503 from the device means one thing: it has no tuner to give. The
        # device allocates them itself - `POST /guide/channels/{id}/watch` takes
        # no tuner argument and there is no way to ask which are free - so the
        # only thing the caller can do about it is stop watching something
        # else, and they can only do that if told. Relayed bare, it read
        # "Stream error: 503 Server Error: Service Unavailable for url ..."
        # while the real cause was four live sessions on a four-tuner box.
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status == 503:
            raise HTTPException(status_code=503, detail=await _refusal_detail(identifier))
        raise HTTPException(status_code=502, detail=f"Stream error: {e}")

    resolved = resolved_mode
    started_at = datetime.now(timezone.utc)

    # NOTE: We use root-relative paths for the frontend so it works through the proxy
    if resolved == "transcode":
        await start_transcoder(session_id, sess.stream.playlist_url)
        stream_url = f"/api/transcoded/{session_id}/playlist.m3u8"
    elif resolved == "ring":
        await _start_ring_session(session_id, sess.stream.playlist_url, started_at)
        # Registered only once the ring exists, so a failed open cannot leave a
        # channel pointing at a session that never started.
        if session_id in ring_sessions:
            ring_for_channel[identifier] = session_id
            ring_channel_of[session_id] = identifier
            ring_viewers[session_id] = 1
        stream_url = f"/api/raw/{session_id}/playlist.m3u8"
    else:
        stream_url = f"/api/hls/{session_id}/playlist.m3u8"

    return {
        "session_id": session_id,
        "proxy_url": f"/api/hls/{session_id}/playlist.m3u8",
        "stream_url": stream_url,
        "mode": resolved,
        # The browser ties media time to this, together with the playlist's
        # EXT-X-PROGRAM-DATE-TIME.
        "started_at": started_at.isoformat(),
        "transcoded": resolved == "transcode",
    }


async def _start_ring_session(
    session_id: str,
    playlist_url: str,
    started_at: datetime,
    fetch=None,
    prime_seconds: float | None = None,
    prime_timeout: float | None = None,
    interval: float | None = None,
) -> SegmentRing | None:
    """Open a ring session and fill it before handing it to the browser.

    Returns the ring, or ``None`` if the session was stopped while priming.
    """
    started = time.monotonic()
    print(f"[ring] {session_id} opening from {playlist_url}", flush=True)
    ring = SegmentRing(origin=started_at)
    follower = RingFollower(
        ring=ring,
        directory=RAW_DIR / session_id,
        playlist_url=playlist_url,
        fetch=fetch or _fetch_bytes,
        max_seconds=float(LIVE_DVR_SECONDS),
        verbose=True,
        interval=RING_POLL_INTERVAL_SECONDS if interval is None else interval,
    )
    # Registered before the wait, not after: a player closed mid-open calls
    # DELETE, and there has to be something there for it to remove.
    ring_sessions[session_id] = (ring, follower, None)

    want = RING_PRIME_SECONDS if prime_seconds is None else prime_seconds
    held = await follower.prime(
        want,
        RING_PRIME_TIMEOUT_SECONDS if prime_timeout is None else prime_timeout,
    )
    print(
        f"[ring] {session_id} primed {held:.1f}s of {want:.1f}s wanted"
        f" in {len(ring.segments)} segments, {time.monotonic() - started:.1f}s elapsed"
        + ("" if held >= want else " - TIMED OUT, the client may fall back"),
        flush=True,
    )

    # Stopped while we were filling. Starting the poller now would hold the
    # tuner for the life of the process with nobody watching.
    if session_id not in ring_sessions:
        print(f"[ring] {session_id} stopped while priming, not starting the poller", flush=True)
        return None

    ring_sessions[session_id] = (ring, follower, asyncio.create_task(follower.run()))
    return ring


async def _fetch_bytes(url: str, byte_range: tuple[int, int] | None = None) -> bytes:
    """Fetch a playlist or a segment from the device.

    The device packs live video as one file addressed by byte range, so most
    segment fetches are ranged - and a ranged request that the device answers
    with the whole file would hand the ring a segment containing everything.
    """
    headers = {}
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"

    # Bounded. A tuner that is busy or wedged accepts the connection and then
    # says nothing; without a timeout that blocks the session open for as long
    # as the process lives, and no deadline above it can interrupt an await
    # that never returns.
    resp = await state.http.get(
        url, headers=headers, follow_redirects=True, timeout=DEVICE_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()

    if byte_range is not None and resp.status_code != 206:
        expected = byte_range[1] - byte_range[0] + 1
        if len(resp.content) != expected:
            raise RuntimeError(
                f"device ignored Range: asked for {expected} bytes, got {len(resp.content)}"
            )
    return resp.content


# ---------------------------------------------------------------------------
# Stop stream + cleanup
# ---------------------------------------------------------------------------

@router.delete("/stream/{session_id}")
async def stop_stream(session_id: str):
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if proc := transcode_procs.pop(session_id, None):
        proc.kill()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.terminate()

    session_dir = TRANSCODE_DIR / session_id
    if session_dir.exists():
        for f in session_dir.glob("*"):
            try:
                f.unlink()
            except Exception:
                pass
        try:
            session_dir.rmdir()
        except Exception:
            pass

    # A ring session holds a tuner through its polling task, so stopping it is
    # not optional housekeeping - a leaked follower keeps fetching for ever.
    # The same teardown the idle reaper uses, so there is one way for a ring
    # session to end rather than two that can drift apart.
    #
    # But a shared ring outlives any one viewer: five windows on one channel
    # hold one tuner between them, and the first window to close must not take
    # the picture away from the other four.
    remaining = ring_viewers.get(session_id)
    if remaining is not None and remaining > 1:
        ring_viewers[session_id] = remaining - 1
        print(
            f"[ring] {session_id} released by one viewer,"
            f" {remaining - 1} still watching",
            flush=True,
        )
        # A viewer left, not the session: the device's session stays open for
        # the others, so nothing is released here.
        return {"ok": True, "shared": True}

    _stop_ring(session_id)
    vod_sessions.pop(session_id, None)
    session_touched.pop(session_id, None)
    # And the directory regardless of whether the session was still registered.
    # An id whose session has already gone - reaped, or stopped twice - can
    # still have gigabytes on disk behind it, and `_stop_ring` returns early in
    # exactly that case. Measured: a DELETE answering 200 while leaving the
    # segments where they were.
    shutil.rmtree(RAW_DIR / session_id, ignore_errors=True)

    # And tell the device. Without this the watch session it opened is released
    # only by its own expiry, which is how every stream this backend ever held
    # - and every restart of it - left one behind.
    await state.release_stream_session(session_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Raw ring: the DVR window for the WASM live path
# ---------------------------------------------------------------------------

async def device_tuners() -> list[dict]:
    """What the device says about its own tuners, right now.

    `/server/tuners` is not in the published type set but this device answers
    it, and it is the only realtime view of what is holding what: each entry
    carries `in_use`, and where the device knows it, the `channel_identifier`
    using it.
    """
    result = await state.request_device("GET", "/server/tuners")
    return result if isinstance(result, list) else []


async def _refusal_detail(identifier: str) -> str:
    """Explain a 503 from the device using the device's own tuner list.

    A previous version of this asserted "no free tuner" for every 503 and
    counted the sessions *this backend* was holding. Both were wrong. A
    streaming channel is delivered over the internet and needs no tuner at all,
    so telling someone to close other players when a FAST channel is simply
    down sends them to fix the wrong thing - and this backend's own count says
    nothing about what else on the network is using the device.
    """
    # Streaming channels are the device's cloud FAST feeds. The identifiers the
    # cloud issues are distinctive, and the channel list knows the rest.
    streaming = identifier.startswith("S999")
    try:
        tuners = await device_tuners()
        used = [t for t in tuners if t.get("in_use")]
        named = [t.get("channel_identifier") for t in used if t.get("channel_identifier")]
        held = (
            f" The device reports {len(used)} of {len(tuners)} slots in use"
            + (f" ({', '.join(named)})." if named else ".")
        )
    except Exception:
        held = ""

    if streaming:
        return (
            "The device refused this streaming channel (503). Streaming channels"
            " come from Tablo's cloud rather than an aerial, so this usually"
            " means the channel itself is unavailable rather than anything"
            " local." + held
        )
    return (
        "The device refused this channel (503), which usually means it has no"
        " tuner free." + held
    )


@router.get("/device/tuners")
async def get_device_tuners():
    """The device's tuner state, for diagnosing "why will nothing play"."""
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        tuners = await device_tuners()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")
    used = [t for t in tuners if t.get("in_use")]
    return {
        "slots": len(tuners),
        "in_use": len(used),
        "free": len(tuners) - len(used),
        "tuners": tuners,
        # What this backend believes it is responsible for, so the two can be
        # compared: anything in_use on the device with no session here is held
        # by something else, or left over.
        "ours": {
            "ring": sorted(ring_sessions),
            "vod": sorted(vod_sessions),
            "transcode": sorted(transcode_procs),
            "ring_channels": dict(ring_for_channel),
        },
    }


@router.post("/debug/wasm-fallback")
async def report_wasm_fallback(request: Request):
    """Record why the WASM live path gave up, in the server's log.

    The reason exists only in the browser, and the person who needs it is
    usually not sitting at that browser - watching from another room, or from
    another machine entirely. Every diagnosis of this path so far has meant
    asking them to read a console back, which is slow and loses the detail that
    matters. One line here puts it beside the ring's own log, where the rest of
    the story already is.

    Deliberately unauthenticated and best-effort: it is a log line, the caller
    is our own page, and anything that makes reporting a failure able to fail
    is worse than useless.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    reason = str(body.get("reason", "unknown"))[:200]
    detail = str(body.get("detail", ""))[:500]
    diagnostics = body.get("diagnostics")
    print(
        f"[wasm] client gave up: {reason}"
        + (f" - {detail}" if detail else "")
        + (f"\n[wasm]   {diagnostics}" if diagnostics else ""),
        flush=True,
    )
    return {"ok": True}


@router.get("/vod/{session_id}/playlist.m3u8")
async def vod_playlist(session_id: str):
    """Our playlist over the device's own media.

    A finished recording's is fixed, complete, and ends in EXT-X-ENDLIST, so the
    player reads it once and can seek anywhere in it. One still being written
    has no ENDLIST and grows here instead: this is where it is re-read.
    """
    session = _vod_session(session_id)
    _refresh_if_growing(session_id, session)
    # The same heartbeat the ring uses. A paused viewer stops asking for
    # segments but the session must not be reaped out from under them.
    touch_session(session_id)
    return Response(
        content=session.index.playlist(
            suffix=".aac.ts" if session.swap_audio else ".ts"),
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"},
    )


def _refresh_if_growing(session_id: str, session: VodSession) -> None:
    """Start re-reading a still-being-written recording, if it is time to.

    Never for a finished one: it cannot change, and the 3.5 hour recording's
    playlist is 1.2MB.

    **Started, not awaited.** This request answers from the index already held.
    Awaiting it put a measured ~330ms device round-trip inside one playlist poll
    in six, and the browser feeds its decoder from that same poll - so feeding
    stalled, never got ahead of playback, and the frozen-picture watchdog fell
    the session back to the transcode about fifteen seconds in. The freshness
    this buys is worth nothing to a viewer forty minutes behind the frontier;
    the latency cost it charged was the whole feature.
    """
    if session.index.finished:
        return
    if time.monotonic() - session.refreshed_at < VOD_REFRESH_SECONDS:
        return

    # Stamped before the fetch, not after: several polls can arrive while one
    # read is in flight, and stamping afterwards would let each of them start
    # its own.
    session.refreshed_at = time.monotonic()
    task = asyncio.create_task(_refresh_now(session_id, session))
    # Held so the loop cannot garbage-collect it mid-flight, and dropped on the
    # way out rather than accumulating one entry per refresh for the session.
    _refresh_tasks.add(task)
    task.add_done_callback(_refresh_tasks.discard)


#: In-flight refreshes, held only to keep them from being collected.
_refresh_tasks: set[asyncio.Task] = set()


async def _refresh_now(session_id: str, session: VodSession) -> None:
    """Re-read the device's playlist and fold what it added into the index.

    A failed read is not fatal - the index already held is perfectly playable,
    and dropping a session because the device blinked would end playback that is
    working.
    """
    try:
        text = await _fetch_text(session.device_url)
        fresh = parse_vod_playlist(text, session.device_url)
    except Exception as e:
        print(f"[vod] {session_id[:8]} refresh failed, serving what we hold: {e}",
              flush=True)
        return

    before = len(session.index.segments)
    session.index = session.index.extended_with(fresh)
    if session.index.finished:
        print(f"[vod] {session_id[:8]} recording finished: "
              f"{len(session.index.segments)} segments", flush=True)
    elif len(session.index.segments) != before:
        print(f"[vod] {session_id[:8]} grew {before} -> "
              f"{len(session.index.segments)} segments", flush=True)


async def _fetch_text(url: str) -> str:
    resp = await state.http.get(
        url, follow_redirects=True, timeout=DEVICE_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    return resp.text


#: Swapped segments already made, oldest first. Bounded: a segment is ~250KB,
#: so 64 of them is ~16MB - enough that a scrub back, a re-read or a second
#: viewer pays nothing, and small enough to sit in memory. Deliberately not on
#: disk: this route's promise is that the media stays on the device.
SWAP_CACHE: "OrderedDict[tuple[str, int], bytes]" = OrderedDict()
SWAP_CACHE_SIZE = 64

#: How many conversions may run at once. Each is ~0.08s of ffmpeg for a ~1s
#: segment (measured 2026-09-22), and hls.js fetches in bursts, so this bounds
#: a seek storm the way the device fetch is already bounded.
_swap_gate = asyncio.Semaphore(4)


async def swap_segment_audio(payload: bytes) -> bytes:
    """One segment with its picture copied and its AC-3 converted to AAC.

    `-c:v copy` is the whole point: the H.264 is the device's own bytes, so
    there is no re-encode, nothing lost, and no deinterlace to do - what the
    box wrote is already progressive. Only the audio is touched, because AC-3
    is the one part no browser but Safari will decode: measured 2026-09-22,
    every ac-3 mime string is false in Chrome, in MSE and in a bare <video>.

    `-copyts` keeps the segment's own timestamps, which is what lets the
    published `#EXTINF` keep describing it and the player's seek arithmetic
    stay true. Measured on a real 1.089s segment: 0.07-0.08s wall, 248KB in,
    240KB out, `start_time` unchanged.
    """
    async with _swap_gate:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-copyts",
            "-i", "pipe:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "160k", "-ac", "2",
            "-f", "mpegts", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(payload)
    if proc.returncode != 0 or not out:
        raise RuntimeError(err.decode(errors="replace").strip() or "ffmpeg failed")
    return out


def _segment_response(payload: bytes) -> Response:
    return Response(
        content=payload,
        media_type="video/mp2t",
        headers={"Cache-Control": "max-age=30", "Access-Control-Allow-Origin": "*"},
    )


@router.get("/vod/{session_id}/{name}")
async def vod_segment(session_id: str, name: str):
    """One segment, fetched from the device on demand and never stored.

    `{n}.aac.ts` is that same segment with its audio converted - see
    `swap_segment_audio`. The two are different names because they are
    different bytes, and one name for both would let the cache below serve
    either.
    """
    session = _vod_session(session_id)
    match = _VOD_SEGMENT_RE.match(name)
    if not match:
        raise HTTPException(status_code=400, detail="Bad segment name")
    number = int(match.group(1))
    swapped = match.group(2) is not None
    if number < 0 or number >= len(session.index.segments):
        raise HTTPException(status_code=404, detail="Segment not found")

    touch_session(session_id)

    if swapped:
        held = SWAP_CACHE.get((session_id, number))
        if held is not None:
            SWAP_CACHE.move_to_end((session_id, number))
            return _segment_response(held)

    segment = session.index.segments[number]
    try:
        payload = await _fetch_bytes(segment.url, segment.byte_range)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    if swapped:
        try:
            payload = await swap_segment_audio(payload)
        except Exception as e:
            # Never the untouched segment as a consolation: hls.js plays those
            # happily and drops the audio track without a word, which is the
            # failure this path exists to stop.
            raise HTTPException(
                status_code=502,
                detail=f"Segment {number:05d} audio could not be converted: {e}",
            ) from None
        SWAP_CACHE[(session_id, number)] = payload
        SWAP_CACHE.move_to_end((session_id, number))
        while len(SWAP_CACHE) > SWAP_CACHE_SIZE:
            SWAP_CACHE.popitem(last=False)

    return _segment_response(payload)


def _vod_session(session_id: str) -> VodSession:
    if not _SESSION_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Bad session id")
    session = vod_sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Stream session not found")
    return session


@router.get("/raw/{session_id}/playlist.m3u8")
async def raw_playlist(session_id: str):
    ring, _follower, _task = _ring_session(session_id)
    # The player asks for this about twice a second for as long as it holds the
    # session - including while paused, when no segment is being fetched at
    # all. That makes it a far better liveness signal than the transcode path's
    # thirty-second status ping, and it is the only thing that tells the reaper
    # anyone is still watching.
    touch_session(session_id)
    return Response(
        content=ring.playlist(),
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"},
    )


@router.get("/raw/{session_id}/{name}")
async def raw_segment(session_id: str, name: str):
    ring, _follower, _task = _ring_session(session_id)
    if not _SEGMENT_RE.match(name):
        raise HTTPException(status_code=400, detail="Bad segment name")
    # Asking the ring rather than the filesystem: a file the ring has evicted
    # may still be mid-unlink, and serving it would hand back media the
    # playlist no longer offers.
    if not ring.holds(name):
        raise HTTPException(status_code=404, detail="Segment not found")

    path = RAW_DIR / session_id / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Segment not found")
    return FileResponse(
        path,
        media_type="video/mp2t",
        headers={"Cache-Control": "max-age=30", "Access-Control-Allow-Origin": "*"},
    )


def _ring_session(session_id: str):
    if not _SESSION_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Bad session id")
    entry = ring_sessions.get(session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Stream session not found")
    return entry


# ---------------------------------------------------------------------------
# Raw HLS proxy
# ---------------------------------------------------------------------------

@router.get("/hls/{session_id}/{path:path}")
async def hls_proxy(session_id: str, path: str, request: Request):
    sess = state.get_session(session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="Stream session not found")

    if path == "playlist.m3u8":
        target_url = sess.stream.playlist_url
    else:
        # Preserve tokens if passed as query params
        query = str(request.url.query)
        target_url = sess.base_url + "/" + path.lstrip("/")
        if query:
            target_url += "?" + query

    # Forward relevant headers (like Range)
    headers = {}
    if range_header := request.headers.get("range"):
        headers["Range"] = range_header

    try:
        # Use a generator to keep the httpx response context alive while streaming
        async def stream_generator():
            async with state.http.stream("GET", target_url, headers=headers, follow_redirects=True) as resp:
                content_type = resp.headers.get("content-type", "application/octet-stream")
                
                # Special handling for manifests
                if "mpegurl" in content_type.lower() or path.endswith(".m3u8"):
                    body = await resp.aread()
                    rewritten = _rewrite_manifest(body.decode("utf-8", errors="ignore"), session_id, target_url)
                    yield rewritten.encode("utf-8")
                    return

                # Stream segments
                async for chunk in resp.aiter_bytes():
                    yield chunk

        # We need a first pass to get the headers/status without closing the stream
        # This is tricky with StreamingResponse. Let's do a simple request for headers first
        # OR just use a more robust streaming pattern.
        
        # Optimized: Start the stream, grab headers, then return the StreamingResponse
        # utilizing the same context.
        resp = await state.http.send(
            state.http.build_request("GET", target_url, headers=headers),
            stream=True,
            follow_redirects=True
        )

        content_type = resp.headers.get("content-type", "application/octet-stream")
        hls_type = "application/vnd.apple.mpegurl"

        if "mpegurl" in content_type.lower() or path.endswith(".m3u8"):
            try:
                body = await resp.aread()
                rewritten = _rewrite_manifest(body.decode("utf-8", errors="ignore"), session_id, target_url)
                return Response(
                    content=rewritten, 
                    media_type=hls_type,
                    headers={
                        "Cache-Control": "no-cache", 
                        "Access-Control-Allow-Origin": "*",
                        "Content-Disposition": "inline"
                    }
                )
            finally:
                await resp.aclose()

        response_headers = {
            "Cache-Control": resp.headers.get("cache-control", "max-age=30"),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Range, If-Range",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
            "Accept-Ranges": "bytes",
        }

        # Force correct MIME type for HLS segments on iOS
        if path.endswith(".ts"):
            response_headers["Content-Type"] = "video/mp2t"
        else:
            response_headers["Content-Type"] = content_type

        if "content-range" in resp.headers:
            response_headers["Content-Range"] = resp.headers["content-range"]
        if "content-length" in resp.headers:
            response_headers["Content-Length"] = resp.headers["content-length"]

        return StreamingResponse(
            resp.aiter_bytes(),
            status_code=resp.status_code,
            headers=response_headers,
            background=BackgroundTask(resp.aclose)
        )

    except Exception as e:
        print(f"Proxy error for {target_url}: {e}")
        raise HTTPException(status_code=502, detail=f"Proxy error: {e}")


def _rewrite_manifest(manifest: str, session_id: str, playlist_url: str) -> str:
    # Use the playlist URL's directory as the base for relative paths
    playlist_base = playlist_url.rsplit("/", 1)[0] + "/"
    
    lines = []
    for line in manifest.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or stripped == "":
            lines.append(line)
            continue

        # Preserve the entire path AND query string (for tokens)
        if stripped.startswith(("http://", "https://")):
            parsed = urlparse(stripped)
            # path including query
            rel = parsed.path.lstrip("/")
            if parsed.query:
                rel += "?" + parsed.query
        else:
            # It's a relative path on the Tablo, resolve against playlist_base
            full_url = urljoin(playlist_base, stripped)
            parsed = urlparse(full_url)
            rel = parsed.path.lstrip("/")
            if parsed.query:
                rel += "?" + parsed.query

        lines.append(f"/api/hls/{session_id}/{rel}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Status check
# ---------------------------------------------------------------------------

# FFmpeg rewrites its stats line in place with \r, so `time=` is found by
# scanning the whole tail rather than by reading lines.
_TIME_RE = re.compile(r"time=(\d+):(\d\d):(\d\d(?:\.\d+)?)")


# FFmpeg's stats line ends in \r, which does not overwrite anything in a file,
# so the log grows for the life of a session — megabytes per hour. The player
# polls this endpoint every second while it waits, so only the tail is read.
LOG_TAIL_BYTES = 8192


def _log_tail(path: Path, limit: int = LOG_TAIL_BYTES) -> str:
    with path.open("rb") as f:
        size = f.seek(0, os.SEEK_END)
        f.seek(max(0, size - limit))
        return f.read().decode("utf-8", errors="ignore")


def encoded_seconds(log_text: str) -> float | None:
    """Seconds of video FFmpeg has written, from the last stats line it printed.

    None until the first frame is encoded — before that FFmpeg prints a huge
    negative placeholder time, which the regex declines to match.
    """
    matches = _TIME_RE.findall(log_text)
    if not matches:
        return None
    h, m, s = matches[-1]
    return int(h) * 3600 + int(m) * 60 + float(s)


@router.get("/transcode/status/{session_id}")
async def transcode_status(session_id: str):
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    # This is the player's heartbeat as well as its progress read: it keeps
    # asking while it holds the session, including while paused, when no
    # segment is being fetched at all.
    touch_session(session_id)
    proc = transcode_procs.get(session_id)
    session_dir = TRANSCODE_DIR / session_id

    log_content = ""
    encoded = None
    log_file = session_dir / "ffmpeg.log"
    if log_file.exists():
        try:
            text = _log_tail(log_file)
            # Get last 20 lines of log
            log_content = "\n".join(text.splitlines()[-20:])
            encoded = encoded_seconds(text)
        except Exception:
            pass

    if not proc:
        return {"status": "inactive", "log": log_content, "encoded_seconds": encoded}

    return {
        "status": "active" if proc.poll() is None else "stopped",
        "return_code": proc.returncode,
        "files": [f.name for f in session_dir.glob("*") if f.is_file()],
        # How much video exists so far. The player shows progress toward having
        # enough of a lead to start, instead of an unanchored spinner.
        "encoded_seconds": encoded,
        "log": log_content
    }


# ---------------------------------------------------------------------------
# Start FFmpeg
# ---------------------------------------------------------------------------

def live_ffmpeg_cmd(session_dir: Path, input_url: str) -> list[str]:
    """The live transcode command, run with ``cwd`` set to ``session_dir``.

    The playlist is named by its absolute path while everything else stays
    relative. That is deliberate and load-bearing: the segment URIs written into
    the playlist are the `-hls_segment_filename` string, so that one must stay
    relative, but with every argument relative the command line named the
    transcode directory nowhere at all - and `_startup_cleanup`, which is how a
    process orphaned by a crash is ever found again, greps for exactly that.

    The video encoder is chosen exactly as the recordings cache chooses it
    (``transcode_cache.encoder_profile``): ``libx264`` inside the container,
    where no hardware encoder is reachable, and ``h264_videotoolbox`` when the
    backend runs natively on macOS, where the Media Engine encodes far faster
    for a fraction of the CPU (measured ~47s -> ~5s per 60s window on the
    recordings path; the encode is effectively free, the device is the limit).
    Live used to hardcode ``libx264`` and so burned software x264 even on the
    native build while VideoToolbox sat idle.

    The deinterlace and square-pixel filters are shared with that path too, so
    live and recordings look the same. The square-pixel filter matters here for
    correctness, not just consistency: VideoToolbox discards the sample aspect
    ratio that x264 keeps, so without it SD (anamorphic 704x480) live would be
    stretched tall and thin on the native build. Both filters honour their
    ``TRANSCODE_DEINTERLACE`` / encoder env, and ``bwdif`` only touches frames
    actually flagged interlaced, so the 720p60 progressive channels pass
    through untouched.
    """
    prof = encoder_profile()
    # Deinterlace first (it samples the coded rows), then square the pixels,
    # then any encoder-specific filter (VAAPI's hwupload). Same order as the
    # recordings path, which is load-bearing for hardware pipelines.
    #
    # Frame mode (30p), not the recordings default of field (60p): live must
    # encode at or above realtime or it falls behind, the playlist stops
    # keeping ahead of the player, and playback stalls at the live edge. Field
    # doubles the frame rate and roughly halves encoder throughput — measured
    # 0.9x realtime (below 1.0, fatal for live) against ~1.8x in frame mode on
    # the same load. Its own env knob so it can be tuned without touching
    # recordings.
    filters = [
        *deinterlace_filter(env_var="TRANSCODE_LIVE_DEINTERLACE", default="frame"),
        *square_pixels_filter(),
        *prof.filters,
    ]
    return [
        "ffmpeg",
        "-y",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        *prof.pre_input,
        "-i", input_url,
        *(["-vf", ",".join(filters)] if filters else []),
        "-c:v", prof.name, *prof.flags,
        *(["-pix_fmt", prof.pix_fmt] if prof.pix_fmt else []),
        "-g", "60",
        # No B-frames here, whatever the shared profile says. They save real
        # bitrate on the recordings path, but they buy it by reordering -
        # the encoder holds frames back to code them against a future one -
        # and live is the path with no slack: it must stay at or above
        # realtime or the playlist stops keeping ahead of the player. Both
        # flags come after `prof.flags` deliberately, where FFmpeg lets the
        # last one win.
        "-bf", "0",
        # And the quality live has always had. The recordings profile was
        # raised to `-q:v 55` to match what the device's own transcode puts on
        # screen, which costs roughly three times the bitrate; a recording is
        # written once and read later, so it can afford that, while live is
        # pushing bits at a player in real time over whatever connection it
        # has. Same reasoning as `-bf` above, and only where `-q:v` is the
        # knob - x264 takes `-crf`, and setting both would be a fight.
        *(["-q:v", "40"] if prof.name == "h264_videotoolbox" else []),
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-f", "hls",
        "-hls_time", str(HLS_TIME),
        # Rolling DVR window rather than a minimal live window, so the player can
        # pause and rewind within it.
        "-hls_list_size", str(LIVE_DVR_SEGMENTS),
        "-hls_segment_filename", "%05d.ts",
        "-hls_flags", "delete_segments+independent_segments",
        "-loglevel", "info",
        str(session_dir / "playlist.m3u8"),
    ]


def _evict_transcoder(session_id: str, proc: subprocess.Popen) -> None:
    """Kill an evicted session and delete what it left behind.

    Blocking, and deliberately so — `wait` gives FFmpeg up to two seconds to
    die, and `rmtree` walks a directory of segments. Called from a thread.
    """
    try:
        proc.kill()
        proc.wait(timeout=2)
    except Exception:
        pass
    try:
        shutil.rmtree(TRANSCODE_DIR / session_id)
    except Exception:
        pass


def _spawn_transcoder(
    session_dir: Path, cmd: list[str], session_id: str, input_url: str
) -> subprocess.Popen:
    """Open the session's log and start FFmpeg against it.

    Both halves block — `open` touches the filesystem and `Popen` forks and
    execs — which is why this is a plain function called from a thread rather
    than part of the coroutine. The handle is closed as soon as the child has
    it; the child keeps its own copy of the descriptor.
    """
    log_file = session_dir / "ffmpeg.log"
    with open(log_file, "w") as f:
        f.write(f"Starting FFmpeg for session {session_id}\n")
        f.write(f"Input: {input_url}\n")
        f.write(f"Command: {' '.join(cmd)}\n\n")
        f.flush()
        return subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, cwd=session_dir)


async def start_transcoder(session_id: str, input_url: str):
    # Evict oldest session if at the cap to prevent CPU exhaustion from zombies.
    # Dropped from the registry before the kill, so a second request arriving
    # mid-eviction picks a different victim rather than this one again.
    if len(transcode_procs) >= MAX_TRANSCODE_SESSIONS:
        oldest_id, oldest_proc = next(iter(transcode_procs.items()))
        transcode_procs.pop(oldest_id, None)
        await asyncio.to_thread(_evict_transcoder, oldest_id, oldest_proc)

    session_dir = TRANSCODE_DIR / session_id
    session_dir.mkdir(exist_ok=True, parents=True)

    cmd = live_ffmpeg_cmd(session_dir, input_url)

    # Off the loop: this same process is serving segments to a player holding a
    # few seconds of buffer, so a fork/exec stall here is a stall there.
    proc = await asyncio.to_thread(_spawn_transcoder, session_dir, cmd, session_id, input_url)

    transcode_procs[session_id] = proc
