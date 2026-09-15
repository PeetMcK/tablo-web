"""Recording listing, cached-transcode playback, and thumbnails."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from ..state import state
from ..transcode_cache import (
    CacheFull,
    CacheState,
    InsufficientDisk,
    TranscodeCache,
    resolve_within,
)

router = APIRouter(prefix="/api/recordings", tags=["recordings"])

cache = TranscodeCache(session_starter=state.start_recording_session)


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


@router.get("")
async def list_recordings():
    _require_auth()
    try:
        items = await state.get_recordings()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Library error: {e}")

    for item in items:
        item["cache_state"] = cache.state(int(item["object_id"])).value

    return {
        "recordings": items,
        "returned": len(items),
        # Surfaced so the UI can say so when the device holds more than we fetched,
        # rather than silently truncating the way the old `paths[:50]` did.
        "total": state.recordings_total,
    }


@router.post("/{object_id}/watch")
async def watch_recording(object_id: int):
    """Start or attach to a cached transcode, and return a playable URL.

    Completed entries return instantly. In-progress entries return the same URL —
    the player reads the EVENT playlist and follows along as encoding proceeds.
    """
    _require_auth()

    try:
        path, duration = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    try:
        meta = await cache.ensure(object_id, path, duration)
    except InsufficientDisk as e:
        raise HTTPException(status_code=507, detail=f"Insufficient storage: {e}")
    except CacheFull as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Transcode error: {e}")

    return {
        "object_id": object_id,
        "stream_url": f"/api/recordings/cache/{object_id}/playlist.m3u8",
        "state": cache.state(object_id).value,
        "progress": cache.progress(object_id),
        "duration": meta.source_duration,
    }


@router.get("/{object_id}/status")
async def recording_status(object_id: int):
    _require_auth()
    meta = cache.read_meta(object_id)
    return {
        "object_id": object_id,
        "state": cache.state(object_id).value,
        "progress": cache.progress(object_id),
        "duration": meta.source_duration if meta else 0,
        "error": meta.error if meta else None,
    }


@router.delete("/{object_id}/cache")
async def evict_recording(object_id: int):
    _require_auth()
    await cache.stop(object_id)
    return {"ok": cache.evict(object_id)}


@router.get("/{object_id}/thumbnail")
async def recording_thumbnail(object_id: int):
    """Proxy the device snapshot image.

    Proxied rather than linked directly because the device is not necessarily
    reachable from the browser — only from the backend.
    """
    _require_auth()
    try:
        path, _ = await state.resolve_recording(object_id)
        data = await state.request_device("GET", path)
    except KeyError:
        raise HTTPException(status_code=404, detail="Recording not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    image_id = (data.get("snapshot_image") or {}).get("image_id")
    if not image_id:
        raise HTTPException(status_code=404, detail="No snapshot for this recording")

    try:
        body, content_type = await state.fetch_device_image(image_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Image error: {e}")

    return Response(
        content=body,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/cache/{object_id}/{filename}")
async def cached_media(object_id: int, filename: str):
    """Serve a cached playlist or segment.

    ``object_id`` is coerced to int by FastAPI, so the directory component cannot
    be manipulated. ``filename`` is confined with ``is_relative_to`` rather than a
    string-prefix check.
    """
    _require_auth()

    base = cache.dir_for(object_id)
    try:
        file_path = resolve_within(base, filename)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not file_path.exists() or not file_path.is_file():
        st = cache.state(object_id)
        raise HTTPException(status_code=404, detail=f"Not found (cache: {st.value})")

    if filename.endswith(".m3u8"):
        cache.touch(object_id)
        return Response(
            content=file_path.read_bytes(),
            media_type="application/vnd.apple.mpegurl",
            headers={
                "Cache-Control": "no-cache, no-store",
                "Content-Disposition": "inline",
            },
        )

    if filename.endswith(".ts"):
        return FileResponse(
            file_path,
            media_type="video/mp2t",
            # Completed segments are immutable, so they cache hard. This is what
            # makes re-watching and seeking cheap on the client too.
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    raise HTTPException(status_code=404, detail="Not found")


__all__ = ["CacheState", "cache", "router"]
