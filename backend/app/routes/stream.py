"""Minimal working version."""

import asyncio
import os
import re
import shutil
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from ..live_follower import RingFollower
from ..live_ring import SegmentRing
from ..state import state

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

LIVE_MODES = ("transcode", "raw", "ring")

# session_id -> (ring, follower, polling task)
ring_sessions: dict[str, tuple[SegmentRing, RingFollower | None, asyncio.Task | None]] = {}

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
    """Mark a live session as still wanted. Cheap enough for every request."""
    if session_id in transcode_procs:
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


def reap_idle_transcoders() -> list[str]:
    """Kill live transcodes nobody has asked about in LIVE_IDLE_SECONDS.

    Returns the sessions it killed, for the log.
    """
    now = time.monotonic()
    stale = [
        sid for sid in list(transcode_procs)
        # A session that has never been touched is one started moments ago,
        # before its player asked for anything. Give it the same grace.
        if now - session_touched.setdefault(sid, now) > LIVE_IDLE_SECONDS
    ]
    for sid in stale:
        _kill(sid)
        import shutil
        try:
            shutil.rmtree(TRANSCODE_DIR / sid)
        except Exception:
            pass
        state.stop_session(sid)
    return stale


async def reap_forever():
    """The sweep has to run on a timer, not on a request.

    The case it exists for is precisely the one where no request is ever coming
    again: the tab is gone and nothing will ask for this session or any other.
    """
    while True:
        await asyncio.sleep(REAP_INTERVAL)
        try:
            if killed := reap_idle_transcoders():
                print(f"[stream] reaped {len(killed)} idle transcode(s): {killed}",
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

    try:
        session_id, sess = await state.start_stream(identifier)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stream error: {e}")

    resolved = mode or ("transcode" if transcode else "raw")
    started_at = datetime.now(timezone.utc)

    # NOTE: We use root-relative paths for the frontend so it works through the proxy
    if resolved == "transcode":
        await start_transcoder(session_id, sess.stream.playlist_url)
        stream_url = f"/api/transcoded/{session_id}/playlist.m3u8"
    elif resolved == "ring":
        await _start_ring_session(session_id, sess.stream.playlist_url, started_at)
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
    if entry := ring_sessions.pop(session_id, None):
        ring, _follower, task = entry
        print(
            f"[ring] {session_id} stopping, held {ring.held_seconds:.1f}s"
            f" in {len(ring.segments)} segments",
            flush=True,
        )
        if task is not None:
            task.cancel()
    shutil.rmtree(RAW_DIR / session_id, ignore_errors=True)

    state.stop_session(session_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Raw ring: the DVR window for the WASM live path
# ---------------------------------------------------------------------------

@router.get("/raw/{session_id}/playlist.m3u8")
async def raw_playlist(session_id: str):
    ring, _follower, _task = _ring_session(session_id)
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
    """
    return [
        "ffmpeg",
        "-y",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        "-i", input_url,
        # yadif: deinterlace 1080i OTA broadcast so browsers can render video
        "-vf", "yadif",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-maxrate", "2000k", "-bufsize", "4000k",
        "-pix_fmt", "yuv420p", "-g", "60",
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
