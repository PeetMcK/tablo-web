"""Recording listing, windowed cached playback, and thumbnails."""

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse

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

_SEGMENT_RE = re.compile(r"^w(\d{5})/seg_(\d{2})\.ts$")


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


def _decorate(item: dict, meta=None) -> dict:
    oid = int(item["object_id"])
    item["cache_state"] = cache.state(oid).value
    item["cache_progress"] = cache.progress(oid)
    item["pinned"] = bool(meta.pinned) if meta else False
    item["paused"] = bool(meta.paused) if meta else False
    item["cached_seconds"] = cache.cached_seconds(oid)
    # Live throughput, so a download reads as working rather than just "7%".
    item["rate"] = cache.rate(oid)
    item.setdefault("offline_only", False)
    return item


@router.get("")
async def list_recordings():
    """Recordings on the device, plus offline copies the device no longer has.

    A kept recording has to outlive its source: once the Tablo deletes it, it
    stops appearing in /recordings/airings, and listing only the device would
    make a deliberately-retained copy vanish from the UI.
    """
    _require_auth()
    try:
        items = await state.get_recordings()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Library error: {e}")

    seen = set()
    for item in items:
        oid = int(item["object_id"])
        seen.add(oid)
        _decorate(item, cache.read_meta(oid))

    orphans = []
    for oid in cache.pinned_ids():
        if oid in seen:
            continue
        meta = cache.read_meta(oid)
        if not meta or not meta.info:
            continue
        entry = dict(meta.info)
        entry["offline_only"] = True
        orphans.append(_decorate(entry, meta))

    merged = items + orphans
    merged.sort(key=lambda r: r.get("start") or "", reverse=True)

    return {
        "recordings": merged,
        "returned": len(merged),
        # Surfaced so the UI can say so when the device holds more than we
        # fetched, rather than silently truncating.
        "total": state.recordings_total + len(orphans),
        "offline_only": len(orphans),
    }


@router.post("/{object_id}/watch")
async def watch_recording(object_id: int):
    """Make a recording playable and return its stream URL.

    Returns immediately. The playlist spans the whole recording from the first
    request because its structure is derived from the source duration, not from
    what has been encoded — so the scrubber shows the full runtime and seeking
    works anywhere. Cold regions are transcoded on demand when requested.
    """
    _require_auth()

    # A finished offline copy plays without the device — which is the whole
    # point of keeping one, since the device may no longer have the recording.
    meta = cache.read_meta(object_id)
    if meta and meta.pinned and cache.state(object_id) is CacheState.COMPLETE:
        return {
            "object_id": object_id,
            "stream_url": f"/api/recordings/cache/{object_id}/playlist.m3u8",
            "state": CacheState.COMPLETE.value,
            "progress": 1.0,
            "duration": meta.source_duration,
            "cached_seconds": cache.cached_seconds(object_id),
            "cached_ranges": cache.cached_ranges(object_id),
        }

    try:
        path, duration = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    if not duration:
        raise HTTPException(status_code=409, detail="Recording has no known duration")

    try:
        meta = await cache.register(object_id, path, duration)
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
        # Included here as well as in /status so the player can report the real
        # cached extent immediately rather than after its first poll.
        "cached_seconds": cache.cached_seconds(object_id),
        "cached_ranges": cache.cached_ranges(object_id),
    }


@router.get("/{object_id}/status")
async def recording_status(object_id: int, position: float | None = None):
    """Cache state, and the viewer's heartbeat.

    The player polls this while watching, so ``position`` doubles as "someone is
    still here, and here is where they are" - which is what bounds prefetch.
    """
    _require_auth()
    cache.heartbeat(object_id, position)
    meta = cache.read_meta(object_id)
    return {
        "object_id": object_id,
        "state": cache.state(object_id).value,
        "progress": cache.progress(object_id),
        "duration": meta.source_duration if meta else 0,
        # Where the cache actually is, not just how much of it exists.
        "cached_seconds": cache.cached_seconds(object_id),
        "cached_ranges": cache.cached_ranges(object_id),
        "rate": cache.rate(object_id),
        "error": meta.error if meta else None,
    }


def _download_name(meta) -> str:
    """A filename a person would recognise in their Downloads folder."""
    info = (meta.info or {}) if meta else {}
    parts = [p for p in (info.get("title"), info.get("subtitle")) if p]
    stem = " - ".join(parts) or f"recording-{meta.object_id}"
    # The title comes from the device, so treat it as untrusted: strip anything
    # that could steer where the file lands or what it is named. Separators go
    # first, then leading dots, which would otherwise yield a hidden file.
    stem = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip().lstrip(". ")[:120].strip()
    return f"{stem or f'recording-{meta.object_id}'}.mp4"


@router.get("/{object_id}/download")
async def download_recording(object_id: int):
    """The cached recording as a single MP4.

    Remuxed, never re-encoded: the segments are already H.264/AAC, so this only
    rewraps them - about 35 seconds for a 3.5h recording, disk-bound.

    Gated on a complete cache. A partial one would export with the missing
    stretches simply absent, which looks like a corrupt file rather than an
    incomplete download.
    """
    _require_auth()
    meta = cache.read_meta(object_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Not cached")

    state_now = cache.state(object_id)
    if state_now is not CacheState.COMPLETE:
        raise HTTPException(
            status_code=409,
            detail=f"Recording is {state_now.value}; only a complete cache can be exported",
        )

    try:
        stream = cache.export_mp4(object_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    filename = _download_name(meta)
    return StreamingResponse(
        stream,
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Length is unknown until the remux finishes, so the browser shows
            # progress without a total rather than guessing wrong.
            "Cache-Control": "no-store",
        },
    )


@router.get("/storage")
async def storage():
    """Cache usage, split into reclaimable and pinned."""
    _require_auth()
    return cache.storage()


@router.post("/{object_id}/keep")
async def keep_recording(object_id: int):
    """Keep a full offline copy.

    Snapshots the library metadata and thumbnail so the recording survives the
    Tablo deleting it, exempts it from eviction, and transcodes the whole thing
    rather than just a lookahead window.
    """
    _require_auth()

    try:
        info = await state.recording_snapshot(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    if info.get("state") == "recording":
        # Still being written: there is no complete source to copy yet.
        raise HTTPException(status_code=409, detail="Recording is still in progress")

    duration = int(info.get("duration") or 0)
    if not duration:
        raise HTTPException(status_code=409, detail="Recording has no known duration")

    path = info["path"]
    try:
        await cache.register(object_id, path, duration)
    except InsufficientDisk as e:
        raise HTTPException(status_code=507, detail=f"Insufficient storage: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Transcode error: {e}")

    cache.set_pinned(object_id, True, info=info)

    # Persist the thumbnail too — proxying it needs the device, which is the
    # thing we are insuring against.
    image_id = None
    try:
        data = await state.request_device("GET", path)
        image_id = (data.get("snapshot_image") or {}).get("image_id")
        if image_id:
            body, _ = await state.fetch_device_image(image_id)
            cache.thumbnail_path(object_id).write_bytes(body)
    except Exception as e:  # noqa: BLE001 - a missing thumbnail is cosmetic
        print(f"[keep] {object_id} thumbnail not saved: {e}")

    # Pinned entries fill completely and ignore the watcher-idle timeout.
    cache.start_prefetch(object_id, path, duration)

    return {
        "object_id": object_id,
        "pinned": True,
        "state": cache.state(object_id).value,
        "progress": cache.progress(object_id),
        "duration": duration,
    }


@router.post("/{object_id}/keep/pause")
async def pause_keep(object_id: int):
    """Stop working on an offline copy without giving it up.

    Encoded windows are kept; only the work stops. Resuming picks up where it
    left off because completed windows are never redone.
    """
    _require_auth()
    if not cache.set_paused(object_id, True):
        raise HTTPException(status_code=404, detail="Not cached")
    await cache.stop(object_id)
    cache.set_paused(object_id, True)   # stop() does not touch metadata
    return {"object_id": object_id, "paused": True}


@router.post("/{object_id}/keep/resume")
async def resume_keep(object_id: int):
    _require_auth()
    meta = cache.read_meta(object_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Not cached")
    cache.set_paused(object_id, False)
    cache.start_prefetch(object_id, meta.path, meta.source_duration)
    return {"object_id": object_id, "paused": False}


@router.delete("/{object_id}/keep")
async def unkeep_recording(object_id: int):
    """Stop keeping it offline. The transcode stays until LRU reclaims it."""
    _require_auth()
    if not cache.set_pinned(object_id, False):
        raise HTTPException(status_code=404, detail="Not cached")
    return {"object_id": object_id, "pinned": False}


@router.post("/{object_id}/release")
async def release_recording(object_id: int):
    """Stop encoding for a recording without deleting anything.

    Called when the player closes. Encoded windows stay on disk; only the work
    stops.
    """
    _require_auth()
    await cache.stop(object_id)
    return {"ok": True}


@router.delete("/{object_id}/cache")
async def evict_recording(object_id: int):
    _require_auth()
    await cache.stop(object_id)
    # force: this route *is* the deliberate user action, the one thing allowed
    # to remove an offline copy.
    return {"ok": cache.evict(object_id, force=True)}


@router.get("/{object_id}/thumbnail")
async def recording_thumbnail(object_id: int):
    """Proxy the device snapshot image.

    Proxied rather than linked directly because the device is reachable from the
    backend, not necessarily from the browser.
    """
    _require_auth()

    # Saved copy first: an offline recording must render without the device.
    saved = cache.thumbnail_path(object_id)
    if saved.exists():
        return FileResponse(saved, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=86400"})

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

    # Keep it, so a later pin (or a device outage) does not need the fetch.
    try:
        cache.thumbnail_path(object_id).parent.mkdir(parents=True, exist_ok=True)
        cache.thumbnail_path(object_id).write_bytes(body)
    except OSError:
        pass

    return Response(
        content=body,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/cache/{object_id}/playlist.m3u8")
async def cached_playlist(object_id: int):
    """Full-length playlist, available before any window has been encoded."""
    _require_auth()
    body = cache.build_playlist(object_id)
    if body is None:
        raise HTTPException(status_code=404, detail="Recording not registered")
    cache.touch(object_id)
    return Response(
        content=body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache, no-store", "Content-Disposition": "inline"},
    )


@router.get("/cache/{object_id}/w{window}/seg_{segment}.ts")
async def cached_segment(object_id: int, window: str, segment: str):
    """Serve one segment, transcoding its window first if it is cold.

    This is what makes seeking anywhere work: the published playlist references
    every segment in the recording, and a request for one that does not exist yet
    triggers just its 60s window.
    """
    _require_auth()

    rel = f"w{window}/seg_{segment}.ts"
    if not _SEGMENT_RE.match(rel):
        raise HTTPException(status_code=400, detail="Invalid segment")
    w = int(window)

    meta = cache.read_meta(object_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Recording not registered")

    n = int(segment)
    if not cache.segment_ready(object_id, w, n):
        import time as _t
        t0 = _t.monotonic()
        ok = await cache.ensure_segment(
            object_id, w, n, meta.path, meta.source_duration
        )
        print(f"[serve] {object_id} w{w}/s{n} cold wait {_t.monotonic() - t0:.1f}s ok={ok}",
              flush=True)
        if not ok:
            # 503 rather than 404: the segment is expected to exist, the encode
            # just has not finished. Players retry on 503.
            raise HTTPException(status_code=503, detail=f"Window {w} still encoding")

    base = cache.dir_for(object_id)
    try:
        file_path = resolve_within(base, rel)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Segment not found")

    return FileResponse(
        file_path,
        media_type="video/mp2t",
        # Encoded segments are immutable, so they cache hard on the client too.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


__all__ = ["CacheState", "cache", "router"]
