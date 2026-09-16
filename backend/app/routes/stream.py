"""Minimal working version."""

import asyncio
import os
import re
import shutil
import subprocess
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

MAX_TRANSCODE_SESSIONS = 4

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

# A session id is hex, and a raw segment is the five-digit name the ring gave
# it. Both are matched rather than sanitised: anything else is not ours.
_SESSION_RE = re.compile(r"^[0-9a-f]{8,64}$")
_SEGMENT_RE = re.compile(r"^\d{5}\.ts$")

LIVE_MODES = ("transcode", "raw", "ring")

# session_id -> (ring, follower, polling task)
ring_sessions: dict[str, tuple[SegmentRing, RingFollower | None, asyncio.Task | None]] = {}

# Kill any FFmpeg processes left over from a previous run and wipe stale dirs.
# After a container restart transcode_procs is empty but old FFmpeg processes
# may still be alive (or their directories still on disk), which exhaust CPU
# and cause new sessions to time out waiting for their first playlist segment.
def _startup_cleanup():
    try:
        import signal
        result = subprocess.run(["pgrep", "-f", "tablo_transcode"], capture_output=True, text=True)
        for pid in result.stdout.split():
            try:
                import os; os.kill(int(pid), signal.SIGKILL)
            except Exception:
                pass
    except Exception:
        pass
    import shutil
    for d in TRANSCODE_DIR.iterdir():
        try:
            shutil.rmtree(d)
        except Exception:
            pass

_startup_cleanup()


# ─────────────────────────────────────────────────────────────────────────────
# TRANSCODED
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/transcoded/{session_id}/{path:path}")
async def transcoded_stream(session_id: str, path: str, request: Request):
    # Security: Ensure session_id is a valid hex string to prevent path traversal
    if not all(c in "0123456789abcdefABCDEF" for c in session_id):
        raise HTTPException(400, "Invalid session ID")

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
        ring = SegmentRing(origin=started_at)
        follower = RingFollower(
            ring=ring,
            directory=RAW_DIR / session_id,
            playlist_url=sess.stream.playlist_url,
            fetch=_fetch_bytes,
            max_seconds=float(LIVE_DVR_SECONDS),
        )
        ring_sessions[session_id] = (ring, follower, asyncio.create_task(follower.run()))
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


async def _fetch_bytes(url: str, byte_range: tuple[int, int] | None = None) -> bytes:
    """Fetch a playlist or a segment from the device.

    The device packs live video as one file addressed by byte range, so most
    segment fetches are ranged - and a ranged request that the device answers
    with the whole file would hand the ring a segment containing everything.
    """
    headers = {}
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"

    resp = await state.http.get(url, headers=headers, follow_redirects=True)
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
        _ring, _follower, task = entry
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

async def start_transcoder(session_id: str, input_url: str):
    # Evict oldest session if at the cap to prevent CPU exhaustion from zombies
    if len(transcode_procs) >= MAX_TRANSCODE_SESSIONS:
        oldest_id, oldest_proc = next(iter(transcode_procs.items()))
        try:
            oldest_proc.kill()
            oldest_proc.wait(timeout=2)
        except Exception:
            pass
        transcode_procs.pop(oldest_id, None)
        import shutil
        try:
            shutil.rmtree(TRANSCODE_DIR / oldest_id)
        except Exception:
            pass

    session_dir = TRANSCODE_DIR / session_id
    session_dir.mkdir(exist_ok=True, parents=True)

    log_file = session_dir / "ffmpeg.log"

    cmd = [
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
        "playlist.m3u8"
    ]

    with open(log_file, "w") as f:
        f.write(f"Starting FFmpeg for session {session_id}\n")
        f.write(f"Input: {input_url}\n")
        f.write(f"Command: {' '.join(cmd)}\n\n")
        f.flush()
        
        proc = subprocess.Popen(
            cmd,
            stdout=f,
            stderr=subprocess.STDOUT,
            cwd=session_dir
        )

    transcode_procs[session_id] = proc
