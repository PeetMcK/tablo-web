"""Minimal working version."""

import asyncio
import os
import re
import shutil
import signal
import subprocess
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

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
    transcode: bool = Query(default=False)
):
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        session_id, sess = await state.start_stream(identifier)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stream error: {e}")

    # NOTE: We use root-relative paths for the frontend so it works through the proxy
    if transcode:
        await start_transcoder(session_id, sess.stream.playlist_url)
        stream_url = f"/api/transcoded/{session_id}/playlist.m3u8"
    else:
        stream_url = f"/api/hls/{session_id}/playlist.m3u8"

    return {
        "session_id": session_id,
        "proxy_url": f"/api/hls/{session_id}/playlist.m3u8",
        "stream_url": stream_url,
        "transcoded": transcode
    }


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

    state.stop_session(session_id)
    return {"ok": True}


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

    cmd = live_ffmpeg_cmd(session_dir, input_url)

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
