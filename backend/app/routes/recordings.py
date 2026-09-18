"""Recording listing, windowed cached playback, and thumbnails."""

import asyncio
import re
import uuid
from datetime import datetime, timezone
from functools import partial
from types import SimpleNamespace
from urllib.parse import urljoin

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse, Response

from .. import store
from ..state import _run_sync, state
from . import stream as stream_routes
from ..vod_index import parse_vod_playlist
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
    # Scrub-preview thumbnails, fetched from the device and kept locally.
    item["has_preview"] = cache.preview_available(oid)
    item.setdefault("offline_only", False)
    return item


def _with_art(item: dict) -> dict:
    """Say what the card leads with, and whether the viewer chose it.

    `image_url` is the show's own artwork, resolved from the airing when the
    library was last listed. Null is ordinary — sport whose airing has aged out
    of the guide, or anything recorded before a guide sync — and the card falls
    back to the snapshot frame it has always used.
    """
    art = store.recording_art(int(item["object_id"])) or {}
    frame_ms = art.get("cover_frame_ms")
    item["image_url"] = art.get("cover_url")
    item["cover_frame"] = None if frame_ms is None else frame_ms / 1000
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

    # Feed the search index from the listing: the device owns the library, so
    # this is the only moment we reliably see all of it.
    #
    # Pruning needs to know the listing is the whole library, which only this
    # caller can tell: `state.recordings_total` is the device's own count, so
    # holding as many as it claims means anything still indexed has since been
    # deleted there. A truncated listing looks identical to a shrunken library
    # from inside the index, and pruning on one would delete most of it - hence
    # the count guard rather than trusting the list. Without this, a deleted
    # recording stayed searchable, and clicking the result failed.
    expected = state.recordings_total + len(orphans)
    complete = state.recordings_total > 0 and len(merged) >= expected
    try:
        await _run_sync(partial(store.index_recordings, prune=complete), merged)
    except Exception as e:
        print(f"[search] indexing recordings failed: {e}", flush=True)

    # Work out each card's picture once and keep it, because the airing it
    # comes from is pruned at 31 days and the recording is not. Failing here
    # costs a card its artwork, never the listing.
    try:
        await _run_sync(store.resolve_recording_art, merged)
    except Exception as e:
        print(f"[art] resolving recording artwork failed: {e}", flush=True)
    for item in merged:
        _with_art(item)

    return {
        "recordings": merged,
        "returned": len(merged),
        # Surfaced so the UI can say so when the device holds more than we
        # fetched, rather than silently truncating.
        "total": state.recordings_total + len(orphans),
        "offline_only": len(orphans),
    }


@router.get("/in-progress")
async def recordings_in_progress():
    """What is being recorded right now, for the views that are not the Library.

    Live and Guide need to mark a programme that is recording and draw how much
    of it has been captured. Both key on `(channel_identifier, start)`, which is
    what a recording carries and what the guide is addressed by.

    Deliberately its own endpoint rather than fields on the guide. The guide is
    a large payload synced into SQLite and cached hard, while this changes every
    few seconds; threading one into the other would mean invalidating a synced
    guide on a timer. This list is almost always empty and never longer than the
    tuner count.

    Every field here is already computed for the full listing - this is a
    projection of it, not a second source of truth.
    """
    _require_auth()
    try:
        items = await state.get_recordings()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Library error: {e}")

    live = [item for item in items if item.get("state") == "recording"]

    # The guide's series, not the recording's. A recording carries
    # `/recordings/series/{id}` and the sheet holds `/guide/series/{id}`; the
    # mirror is where the two meet. Bounded by the tuner count, and indexed on
    # the primary key, so this is a handful of lookups at most.
    series_paths: list[str | None] = []
    for item in live:
        identifier = (item.get("channel") or {}).get("identifier")
        start = item.get("start")
        series_paths.append(
            await _run_sync(store.airing_series_path, identifier, start)
            if identifier and start else None
        )

    return {
        "recordings": [
            {
                "object_id": item["object_id"],
                "channel_identifier": (item.get("channel") or {}).get("identifier"),
                # The scheduled start, which is the guide's key - not when the
                # tuner actually began, which `recording_started` carries.
                "start": item.get("start"),
                "duration": item.get("duration"),
                "recording_started": item.get("recording_started"),
                "recorded_seconds": item.get("recorded_seconds"),
                "expected_seconds": item.get("expected_seconds"),
                "title": item.get("title"),
                # What the series rule would be turned off for. Null when the
                # mirror has never seen the airing, which is not an error.
                "series_path": series_path,
            }
            for item, series_path in zip(live, series_paths, strict=True)
        ],
    }


class PositionIn(BaseModel):
    """Where playback has got to, in seconds from the recording's first frame."""

    position: int = Field(ge=0)


@router.post("/{object_id}/position")
async def set_position(object_id: int, body: PositionIn):
    """Record how far into a recording playback has got, on the device.

    The device keeps this in `user_info.position` and its own app writes it, so
    writing there rather than only to our own store is what lets a phone and a
    browser agree about where you were.

    **The write shape is not the read shape.** `{"position": N}` flat is what
    takes; `{"user_info": {"position": N}}` - exactly what the GET hands back -
    answers 200 and changes nothing. Verified against the device by writing 618,
    reading it back, and restoring zero. The nested form is how this ships
    broken without anyone noticing.
    """
    _require_auth()

    try:
        path, _duration = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    try:
        status, _data = await state.patch_device(path, {"position": body.position})
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    if status != 200:
        raise HTTPException(status_code=502, detail="The Tablo refused the position")

    return {"object_id": object_id, "position": body.position}


class WatchedIn(BaseModel):
    """Whether this recording counts as seen."""

    watched: bool


@router.post("/{object_id}/watched")
async def set_watched(object_id: int, body: WatchedIn):
    """Mark a recording watched, or put it back.

    The device never works this out for itself. Measured: a recording played to
    43% still read `watched: false`, and one played to its end read the same -
    its own app writes this flag, so anything that does not write it leaves a
    library where nothing is ever marked.

    **The write shape is not the read shape**, exactly as `position` has it:
    `{"watched": true}` flat is what takes, while `{"user_info": {"watched":
    true}}` - which is the shape the GET hands back - answers 200 and changes
    nothing. That is how this ships broken without anyone noticing.
    """
    _require_auth()

    try:
        path, _duration = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    try:
        status, _data = await state.patch_device(path, {"watched": body.watched})
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    if status != 200:
        raise HTTPException(status_code=502, detail="The Tablo refused the flag")

    return {"object_id": object_id, "watched": body.watched}


class CoverIn(BaseModel):
    """Where in the recording the chosen frame is, in seconds."""

    t: float = Field(ge=0)


@router.post("/{object_id}/cover")
async def set_cover(object_id: int, body: CoverIn):
    """Make the frame at ``t`` the picture this recording's card leads with.

    Stored as a position, not a picture. The frame is already on disk in the
    BIF pack the scrub preview reads, so this copies nothing — and the same
    rounding the preview does applies, so the card shows exactly the frame the
    viewer was looking at when they picked it.
    """
    _require_auth()
    await _run_sync(partial(store.set_recording_frame, object_id, int(body.t * 1000)))
    return {"object_id": object_id, "cover_frame": body.t}


@router.delete("/{object_id}/cover")
async def clear_cover(object_id: int):
    """Put the card's picture back to the show's own artwork."""
    _require_auth()
    await _run_sync(partial(store.set_recording_frame, object_id, None))
    return {"object_id": object_id, "cover_frame": None}


@router.get("/{object_id}/series")
async def recording_series(object_id: int):
    """The show this recording belongs to, for the card shown at its end.

    Only the artwork needs a device fetch. Everything the end card orders by -
    season, episode, air date, the grouping path itself - is already on each
    recording, but a recording record carries no `series` object at all:
    measured on /recordings/series/episodes/86128, `series` is null and only
    `series_path` links the two. The cover lives on the series record.

    Addressed through the recording rather than as `/series/{id}` on purpose.
    That form is two segments, the same shape as `/{object_id}/position`, and
    FastAPI matches on declaration order - so "series" would be offered to the
    `int` converter and answered 422 rather than falling through.

    `cover_image` is an id for `/api/channels/image/{id}`, which caches device
    images for a week. Null is ordinary: sport has no series record to ask.
    """
    _require_auth()

    try:
        path, _duration = await state.resolve_recording(object_id)
        record = await state.request_device("GET", path)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    series_path = record.get("series_path")
    if not series_path:
        return {"series_path": None, "title": None, "cover_image": None}

    try:
        data = await state.request_device("GET", series_path)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    series = data.get("series") or {}
    return {
        "series_path": series_path,
        "title": series.get("title"),
        # `cover_image` is the poster the card leads with. `thumbnail_image` and
        # `background_image` sit beside it on the same record if anything ever
        # wants the other shapes.
        "cover_image": (series.get("cover_image") or {}).get("image_id"),
    }


@router.post("/{object_id}/watch-vod")
async def watch_recording_vod(object_id: int):
    """Serve a recording as MPEG-2, straight from the device.

    A recording is MPEG-2 video with AC-3 audio - the same thing the live path
    decodes - so playing it needs no transcode at all. The device publishes it
    as a playlist where every segment is addressable by byte range. Measured on
    a 3.5 hour recording, 8542 segments across 29 byte-ranged files.

    The index is held; the media is not. Downloading it would be ~25GB for one
    viewing of something the device already has, so segments are fetched on
    demand - which is the whole difference between this and the ring.

    A recording still being written comes here too, and this was the surprise:
    the device publishes it from byte 0 and simply appends. It was routed to the
    ring instead, which joins at the live edge and so began forty minutes into
    the show. Measured 2026-09-17 - at 29:56 elapsed the head was still
    `BYTERANGE:218644@0`, MEDIA-SEQUENCE still 1, and 75 seconds apart the head
    was unchanged while the tail grew by 70 segments. No ENDLIST is the only
    difference, and `stream._refresh_if_growing` re-reads it as it grows.
    """
    _require_auth()

    try:
        path, _duration = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    try:
        sess = await state.start_recording_session(path)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    master = sess.get("playlist_url")
    if not master:
        raise HTTPException(status_code=502, detail="Device gave no playlist")

    try:
        index, variant_url = await _fetch_vod_index(master)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    session_id = uuid.uuid4().hex
    state.streams[session_id] = SimpleNamespace(
        stream=SimpleNamespace(token=sess.get("token")),
    )
    # The variant url is kept because a growing index is re-read from it.
    stream_routes.vod_sessions[session_id] = stream_routes.VodSession(
        index=index, device_url=variant_url,
    )
    stream_routes.touch_session(session_id)

    # Scrub-preview thumbnails, which this path would otherwise never get.
    #
    # The pack is normally pulled by `register()`, on the transcode path - and
    # this returns long before that, exactly as the pinned-offline path above
    # did until it was fixed. Measured: of eleven recordings, the only four with
    # thumbnails were the four that had been transcoded.
    #
    # Only once finished. Watched across a two-hour recording on 2026-09-17, the
    # device offered no pack at all while `state` was `recording` - the session
    # carries `bif_url_hd`/`bif_url_sd` as null - and published a complete one
    # within five minutes of the recording ending, covering its whole runtime.
    # So there is nothing to ask for until then, and a session open across the
    # end simply gets them the next time it is opened.
    #
    # Backgrounded, and it fails harmlessly: nothing is written unless a valid
    # BIF comes back, so a fetch that is merely too early is retried on the next
    # open rather than caching an empty pack for ever.
    if index.finished and not cache.preview_available(object_id):
        asyncio.create_task(cache.fetch_bif(object_id, path))

    return {
        "object_id": object_id,
        "session_id": session_id,
        "stream_url": f"/api/vod/{session_id}/playlist.m3u8",
        "duration": index.duration,
        "segments": len(index.segments),
        # What is held so far, not what the recording will be. The player polls
        # for the rest, and must not pin its scrubber to this.
        "growing": not index.finished,
        "mode": "vod",
    }


async def _fetch_vod_index(master_url: str):
    """Follow the master to its variant and parse that into an index.

    Returns the variant url alongside, because a recording still being written
    is re-read from it for as long as the session lasts.
    """
    resp = await state.http.get(master_url, timeout=30)
    resp.raise_for_status()
    variant = next(
        (line.strip() for line in resp.text.splitlines()
         if line.strip() and not line.startswith("#")),
        None,
    )
    url = urljoin(master_url, variant) if variant else master_url
    playlist = await state.http.get(url, timeout=60)
    playlist.raise_for_status()
    return parse_vod_playlist(playlist.text, url), url


@router.post("/{object_id}/watch-raw")
async def watch_recording_raw(object_id: int):
    """Follow a recording's own MPEG-2 segments, for the WASM decoder.

    The ordinary `/watch` hands the recording to FFmpeg and serves H.264. This
    serves what the device already has: the recording is MPEG-2 video with AC-3
    audio - `video_details.container_format` says so - which is exactly what the
    browser-side decoder eats. No transcode, no tuner beyond the one the device
    is already using, and the picture keeps its own sample aspect rather than
    depending on an encoder to carry it.

    A recording still being written is the natural case: the device publishes it
    as a live-shaped playlist with no ENDLIST, which is the shape `RingFollower`
    was built for.
    """
    _require_auth()

    try:
        path, _duration = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    try:
        sess = await state.start_recording_session(path)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    playlist_url = sess.get("playlist_url")
    if not playlist_url:
        raise HTTPException(status_code=502, detail="Device gave no playlist")

    session_id = uuid.uuid4().hex
    started_at = datetime.now(timezone.utc)
    # Registered so the keepalive and the idle reaper cover it exactly as they
    # cover a live ring: the device expires a session in 165 seconds otherwise.
    state.streams[session_id] = SimpleNamespace(
        stream=SimpleNamespace(token=sess.get("token")),
    )
    await stream_routes._start_ring_session(session_id, playlist_url, started_at)
    stream_routes.touch_session(session_id)

    return {
        "object_id": object_id,
        "session_id": session_id,
        "stream_url": f"/api/raw/{session_id}/playlist.m3u8",
        "origin_ms": int(started_at.timestamp() * 1000),
        "mode": "ring",
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
        # This path returns before register(), which is where the thumbnail pack
        # is normally fetched - so a finished offline copy, the one most worth
        # scrubbing, was the only kind that never got previews. Backgrounded, and
        # it simply fails if the device no longer has the recording.
        if not cache.preview_available(object_id):
            asyncio.create_task(cache.fetch_bif(object_id, meta.path))
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
    # A poll is proof someone is watching, so it is also the place to notice the
    # background fill is not running and start it. Without this, prefetch only
    # ever began at /watch, and anything that ended it - a restart above all -
    # left playback served entirely by on-demand transcodes.
    cache.ensure_prefetch(object_id)
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
        # Real progress for the window playback is blocked on, so the player can
        # show a bar rather than a spinner that only means "something is
        # happening".
        "encoding": cache.encoding_progress(object_id),
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
        path = await cache.build_mp4(object_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except InsufficientDisk as e:
        raise HTTPException(status_code=507, detail=f"Insufficient storage: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {e}")

    # FileResponse, not a stream: it sets Content-Length and honours Range, so
    # the browser can show a real total and a resumable download rather than a
    # byte count that only grows.
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=_download_name(meta),
    )


@router.get("/{object_id}/preview")
async def recording_preview(object_id: int, t: float = 0.0):
    """One scrub-preview thumbnail, at or just before ``t`` seconds.

    Served from the device's own BIF pack, stored alongside the recording. The
    frames sit ~10s apart, so the client rounds its request to that grid and the
    browser cache does the rest of the work during a drag.
    """
    _require_auth()
    frame = cache.preview_frame(object_id, t)
    if frame is None:
        raise HTTPException(status_code=404, detail="No preview available")
    return Response(
        content=frame,
        media_type="image/jpeg",
        # Immutable: a given frame of a finished recording never changes.
        headers={"Cache-Control": "public, max-age=604800, immutable"},
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
    except Exception as e:
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

    # A frame the viewer picked wins over everything, including a saved copy:
    # it is the one picture here that someone chose on purpose.
    art = await _run_sync(partial(store.recording_art, object_id)) or {}
    frame_ms = art.get("cover_frame_ms")
    if frame_ms is not None:
        frame = cache.preview_frame(object_id, frame_ms / 1000)
        if frame is not None:
            return Response(
                content=frame,
                media_type="image/jpeg",
                # Short, unlike the frames themselves: which frame this is can
                # change whenever the viewer picks another one.
                headers={"Cache-Control": "no-cache"},
            )

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
