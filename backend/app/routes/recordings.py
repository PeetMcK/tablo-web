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

#: Cover fetches in flight at once. Small pictures, and the device is the
#: slower of the two sources, so this keeps a first listing brisk without
#: taking lanes from playback.
ART_FETCH_CONCURRENCY = 4
#: A picture nobody is waiting on. Give up quickly and try next listing.
ART_FETCH_TIMEOUT = 20
#: A resolved cover that lives on the device, as `/api/channels/image/{id}`.
_DEVICE_IMAGE_RE = re.compile(r"^/api/channels/image/(\d+)$")

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


async def _show_covers(items: list[dict]) -> dict[int, str]:
    """Each recording's show cover, from the device rather than the guide.

    What the artwork falls back to when the guide has no airing left to describe
    a recording — which for anything past is most of the time, since the device
    lists airings forward from roughly now and the mirror holds no old ones at
    all. `series_path` and `sport_path` are on the recording itself and the
    device keeps them for as long as it keeps the recording, so this still
    answers for something recorded years ago.

    One read per distinct show, not per recording: six NFL games share one sport
    record, and they are exactly the case this exists for. Called only with the
    recordings that have no picture stored, so a settled library makes no device
    calls here at all.

    Never raises. A cover that will not load leaves the card on its snapshot
    frame, which is where it already was.
    """
    paths: dict[str, list[int]] = {}
    for rec in items:
        path = rec.get("series_path") or rec.get("sport_path")
        if path and rec.get("object_id") is not None:
            paths.setdefault(path, []).append(int(rec["object_id"]))

    out: dict[int, str] = {}
    for path, ids in paths.items():
        try:
            data = await state.request_device("GET", path)
        except Exception:
            continue
        # Whichever noun this record uses. Identical shape inside - see
        # `recording_series` for what the device means by the two.
        show = data.get("series") or data.get("sport") or {}
        cover = (show.get("cover_image") or {}).get("image_id")
        if not cover:
            continue
        for object_id in ids:
            out[object_id] = f"/api/channels/image/{cover}"
    return out


async def _store_covers(needy: list[dict]) -> int:
    """Pull each resolved picture down and keep it, permanently.

    The step that makes artwork survive. Everything up to here only worked out
    a *URL*, and a URL is the wrong kind of answer for a recording: for a game
    it points at `lighthousetv-cdn.ewscloud.com`, for a series at
    `/api/channels/image/{id}` - someone else's CDN, and a proxy to the Tablo.
    A recording is kept because the viewer does not trust either to still be
    there, and a protected one can outlive both by years.

    So the bytes are fetched once, while the URL still resolves, and written
    beside the database where nothing reclaims them. After that the card is
    served from disk and the URL is never used again.

    Two shapes, because that is what resolution produces. A device image id goes
    through the signed device request; an absolute CDN URL is a plain GET.

    Bounded concurrency, and never raises. A picture that will not download is
    left for the next listing to try - the row keeps its `cover_url`, so nothing
    is forgotten - and the card meanwhile shows the URL it came from.
    """
    if not needy:
        return 0

    gate = asyncio.Semaphore(ART_FETCH_CONCURRENCY)

    async def one(entry: dict) -> bool:
        object_id, url = entry["object_id"], entry["cover_url"]
        async with gate:
            try:
                body = await _fetch_cover_bytes(url)
            except Exception as e:
                print(f"[art] {object_id} cover not stored: {e}", flush=True)
                return False
        if not body:
            return False
        await _run_sync(partial(store.store_cover, object_id, body, url))
        return True

    done = await asyncio.gather(*[one(e) for e in needy], return_exceptions=True)
    stored = sum(1 for d in done if d is True)
    if stored:
        print(f"[art] stored {stored} cover(s) permanently", flush=True)
    return stored


async def _fetch_cover_bytes(url: str) -> bytes | None:
    """The bytes behind a resolved cover URL, whichever kind it is."""
    local = _DEVICE_IMAGE_RE.match(url)
    if local:
        # Straight to the device rather than back through our own proxy: this
        # runs inside that proxy's process, and a request to ourselves would
        # deadlock the single worker under load.
        body, _content_type = await state.fetch_device_image(int(local.group(1)))
        return body

    if not url.startswith(("http://", "https://")):
        return None
    resp = await state.http.get(url, follow_redirects=True, timeout=ART_FETCH_TIMEOUT)
    resp.raise_for_status()
    return resp.content


def _with_art(items: list[dict]) -> None:
    """Say what each card leads with, and whether the viewer chose it.

    Once the bytes are in hand the card is pointed at `/api/recordings/{id}/art`
    and never at the place they came from again. That is the whole point: the
    URL artwork resolves *from* is either a `lighthousetv-cdn` asset or a proxy
    to the Tablo, and a recording is kept precisely because neither can be
    relied on to still be there. A protected one can outlive both by years.

    The original URL is what a card shows in the gap between resolving a picture
    and holding it — one listing, usually — and nothing after that.

    Null is ordinary: anything whose airing and show record both carry no
    artwork. The card falls back to the snapshot frame it has always used.

    One query for the listing rather than one per recording, and run through
    `_run_sync` like every other store call in this handler: reading it inline
    put a SQLite connection on the event loop thread and a round trip per card.
    """
    art = store.recording_art_for([int(i["object_id"]) for i in items])
    for item in items:
        object_id = int(item["object_id"])
        held = art.get(object_id) or {}
        frame_ms = held.get("cover_frame_ms")
        item["image_url"] = (
            f"/api/recordings/{object_id}/art"
            if held.get("cover_stored_at") and store.has_stored_cover(object_id)
            else held.get("cover_url")
        )
        item["cover_frame"] = None if frame_ms is None else frame_ms / 1000


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

    # And the assets, under the same guard and for the same reason. The artwork
    # and preview stores sit outside the transcode cache precisely so that
    # nothing reclaims them, which leaves this as the only thing that ever
    # removes one - and `forget_recording` alone does not reach a recording
    # deleted in the Tablo's own app rather than in ours.
    #
    # `complete` is what makes this safe: a truncated listing looks identical to
    # a shrunken library from inside the store, and sweeping on one would delete
    # nearly everything. Same reasoning as the search index above, and the same
    # count check behind it.
    if complete:
        try:
            gone = await _run_sync(store.prune_recording_assets, merged)
            if gone:
                print(f"[art] forgot assets for {len(gone)} deleted "
                      f"recording(s): {gone}", flush=True)
        except Exception as e:
            print(f"[art] pruning recording assets failed: {e}", flush=True)

    # Work out each card's picture once and keep it, because the airing it came
    # from is gone from the guide within days and the recording is not. Failing
    # here costs a card its artwork, never the listing.
    try:
        needy = await _run_sync(store.recordings_without_art, merged)
        await _run_sync(
            partial(store.resolve_recording_art, fallback=await _show_covers(needy)),
            merged,
        )
        # And then actually hold the picture, rather than a URL pointing at
        # someone else's server. Resolution above only works out *where* the
        # artwork is; this is what makes it the recording's own, for as long as
        # the recording exists. Costs nothing on a settled library - everything
        # already stored is skipped.
        await _store_covers(await _run_sync(store.recordings_without_stored_cover, merged))
    except Exception as e:
        print(f"[art] resolving recording artwork failed: {e}", flush=True)

    # Which airing each recording came from, so the info sheet can find the
    # recording it is describing. Same reasoning as the two above: a listing is
    # the only moment the whole library is in hand.
    try:
        await _run_sync(store.index_recording_airings, merged)
    except Exception as e:
        print(f"[recordings] indexing airings failed: {e}", flush=True)
    await _run_sync(_with_art, merged)

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


class ProtectedIn(BaseModel):
    """Whether the device should keep this recording from deletion."""

    protected: bool


@router.patch("/{object_id}/protect")
async def set_protected(object_id: int, body: ProtectedIn):
    """Protect a recording, or release it.

    Captured from the official app: `PATCH {episode_path} {"protected": bool}`
    -> 200, echoing the episode. The flat body is the write shape (same as
    `watched`/`position`); the episode path is what `resolve_recording` returns
    (`/recordings/{series|sports}/episodes|events/{id}`). A protected recording
    is skipped by the series "delete all" and by auto-delete. See docs/tablo-api.md.
    """
    _require_auth()

    try:
        path, _duration = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    try:
        status, _data = await state.patch_device(path, {"protected": body.protected})
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    if status != 200:
        raise HTTPException(status_code=502, detail="The Tablo refused the flag")

    return {"object_id": object_id, "protected": body.protected}


class CoverIn(BaseModel):
    """Where in the recording the chosen frame is, in seconds.

    Bounded at both ends. `1e30` is a valid float and `int(t * 1000)` of it
    overflows SQLite's 64-bit integer, which leaves the handler as a 500; the
    ceiling is a day, comfortably past the longest thing anything records.
    """

    t: float = Field(ge=0, le=86_400)


@router.get("/{object_id}/art")
async def recording_art_image(object_id: int):
    """The recording's own picture, from our disk.

    Not a proxy and not a redirect: the bytes were pulled down when the artwork
    was first resolved and they belong to the recording now. That is the whole
    point of the artwork store - a card served from `lighthousetv-cdn` or from
    `/api/channels/image/{id}` is a card that goes blank the day the CDN drops
    the asset or the Tablo forgets the image, and a protected recording can
    outlive both by years.

    Immutable: this recording's artwork is fetched once and never rewritten in
    place. The viewer's own frame choice is a different thing entirely, lives in
    `cover_frame_ms`, and is served by the thumbnail route.
    """
    _require_auth()
    body = await _run_sync(partial(store.cover_bytes, object_id))
    if body is None:
        raise HTTPException(status_code=404, detail="No stored artwork")
    return Response(
        content=body,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=604800, immutable"},
    )


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

    # A game has `sport_path` where an episode has `series_path`, and the device
    # means the same thing by both: `/recordings/sports/{id}` carries a title, a
    # description, the same three images and its own `airing_count`. The Tablo
    # app's own sheet for one is headed "Series Recording Scheduled" over the
    # league's picture - the sport *is* the series, under a different noun.
    #
    # Asking only for `series_path` is why every NFL recording came back with
    # nothing to lead with.
    series_path = record.get("series_path") or record.get("sport_path")
    if not series_path:
        return {"series_path": None, "title": None, "cover_image": None}

    try:
        data = await state.request_device("GET", series_path)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    # Whichever noun this record uses. Identical shape inside.
    show = data.get("series") or data.get("sport") or {}
    return {
        "series_path": series_path,
        "title": show.get("title"),
        # `cover_image` is the poster the card leads with. `thumbnail_image` and
        # `background_image` sit beside it on the same record if anything ever
        # wants the other shapes.
        "cover_image": (show.get("cover_image") or {}).get("image_id"),
    }


def _offline_detail(object_id: int) -> dict:
    """The sheet for a copy kept after the Tablo deleted the original.

    The device cannot be asked - that is the whole point of pinning one - so
    this answers from the snapshot taken when it was pinned and the artwork
    already resolved for its card. It is the longest-lived recording there is,
    and the case that decides the rule: a recording describes itself, or
    eventually nothing describes it.

    Less than the live answer, and honestly less: `_recording_fields` keeps no
    genres or rating, because the show record they live on is a second device
    read that pinning never made. Title, episode, description, when and how long
    are all here, which is what the sheet is mostly for.
    """
    meta = cache.read_meta(object_id)
    info = (meta.info if meta else None) or {}
    if not info:
        raise HTTPException(status_code=404, detail=f"Recording {object_id} not found")

    art = store.recording_art(object_id) or {}
    # `_channel_fields` writes the number as one "8.1" string for the card. The
    # sheet's eyebrow wants the parts, so it is split back apart here rather
    # than widening the projection for one caller.
    ch = info.get("channel") or {}
    major, _, minor = str(ch.get("number") or "").partition(".")

    return {
        "title": info.get("title"),
        "episode_title": info.get("subtitle"),
        "season_number": info.get("season_number"),
        "episode_number": info.get("episode_number"),
        "description": info.get("description"),
        "start": info.get("start"),
        "duration": info.get("duration") or 0,
        "orig_air_date": info.get("orig_air_date"),
        "genres": [],
        "rating": None,
        "image_url": art.get("cover_url"),
        # Nothing about a copy of something already deleted is live.
        "airing_now": False,
        "schedulable": False,
        "scheduled": False,
        "past": True,
        "schedule_state": None,
        "skip_reason": None,
        "recording_id": object_id,
        "series": None,
        "channel": {
            "identifier": ch.get("identifier"),
            "call_sign": ch.get("call_sign"),
            "major": int(major) if major.isdigit() else None,
            "minor": int(minor) if minor.isdigit() else None,
            "network": ch.get("network"),
            "logo_url": None,
            "kind": None,
        },
    }


@router.get("/{object_id}/detail")
async def recording_detail(object_id: int):
    """What the info sheet shows, built from the recording rather than the guide.

    The sheet was keyed on `(channel, start)` in `guide_airing`, which is right
    for something upcoming and wrong for something already recorded. The device
    lists airings forward from roughly now, so the mirror holds no past ones at
    all: measured 2026-09-18, its earliest row was from the 15th while
    recordings from the 13th were still in the library, their sheets reading
    "Information unavailable" over programmes the device describes perfectly
    well. A recording outlives its own listing within days - and a protected one
    can outlive it by years - so the guide cannot be what describes a recording.

    Everything below comes from two device reads and nothing else - or, for a
    copy kept offline after the Tablo deleted the original, from the snapshot
    taken when it was pinned. Answers in the same shape `store.airing_detail`
    does, so the sheet renders it without knowing where it came from.

    The scheduling fields are all off, and honestly so: the writes behind those
    controls address an airing by `(channel, start)` through the guide mirror,
    and when there is no listing there is nothing for them to address. The sheet
    lays a live airing's answers over these when one exists - see ShowInfo.
    """
    _require_auth()

    record: dict | None = None
    try:
        path, _duration = await state.resolve_recording(object_id)
        record = await state.request_device("GET", path)
    except KeyError:
        # Not on the device. Ordinary for a kept offline copy, which is the
        # longest-lived thing here and the one with the strongest claim to
        # describing itself - see below.
        pass
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Device error: {e}")

    if record is None:
        return _offline_detail(object_id)

    fields = state._recording_fields(record)

    # The show record, under whichever noun this recording uses. It is where
    # everything about the programme as a whole lives - the picture, the genres,
    # the rating - none of which is on the recording itself. Verified against
    # every recording on a real device 2026-09-18: an episode record carries
    # only `episode` (description, number, orig_air_date, season_number, title,
    # tms_id) and a game record only `event` (description, teams, venue, season,
    # tms_id). Neither has artwork, genres or a rating. The earlier draft of
    # this route read `genres` off those two and would have returned [] forever.
    show: dict = {}
    show_path = record.get("series_path") or record.get("sport_path")
    if show_path:
        try:
            data = await state.request_device("GET", show_path)
            show = data.get("series") or data.get("sport") or {}
        except Exception:
            # One read failing should not cost the sheet the other one's title
            # and description, which is the part someone opened it for.
            pass

    # `cover_image` for the same reason the schedule sheet and the Library card
    # use it - see store.airing_artwork. For a game this is the league's
    # picture: the event record has teams, a venue and a blurb but no image, so
    # every NFL game leads with the NFL cover, which is what the Tablo app shows
    # too.
    cover = (show.get("cover_image") or {}).get("image_id")

    # The raw nested channel, not `_recording_fields`' projection of it: that
    # one narrows to four keys for the Library card and drops the number parts
    # and the logos this sheet's eyebrow wants.
    ch = ((record.get("airing_details") or {}).get("channel") or {}).get("channel") or {}
    logos = {logo.get("kind"): logo.get("url") for logo in ch.get("logos") or []}

    return {
        "title": fields.get("title"),
        "episode_title": fields.get("subtitle"),
        "season_number": fields.get("season_number"),
        "episode_number": fields.get("episode_number"),
        # `_recording_fields` already prefers the event's blurb, then the
        # episode's. The show's is the last resort and describes the run rather
        # than this instalment, which is still better than an empty sheet.
        "description": fields.get("description") or show.get("description"),
        "start": fields.get("start"),
        # What was captured, not the slot that was booked - the same number the
        # Library card shows for this recording, so the two cannot disagree.
        "duration": fields.get("duration") or 0,
        "orig_air_date": fields.get("orig_air_date") or show.get("orig_air_date"),
        "genres": show.get("genres") or [],
        # Only a series carries one; `sport` has no equivalent key.
        "rating": show.get("series_rating"),
        "image_url": f"/api/channels/image/{cover}" if cover else None,
        # Still on a tuner. The guide means something else by this - "on air
        # now" - and the sheet takes the guide's answer whenever it has one.
        "airing_now": fields.get("state") == "recording",
        # Nothing here can be scheduled: this is the recording, not the airing
        # that made it, and the path a write would need belongs to the listing.
        "schedulable": False,
        "scheduled": False,
        "past": fields.get("state") != "recording",
        "schedule_state": None,
        "skip_reason": None,
        "recording_id": object_id,
        # Deliberately null even though `show_path` is in hand. The series
        # controls write through `(channel, start)` against the guide mirror,
        # and this path is `/recordings/series/{id}` - a different namespace. An
        # Edit Series Recording box that cannot write is worse than none.
        "series": None,
        "channel": {
            "identifier": ch.get("channel_identifier"),
            "call_sign": ch.get("call_sign"),
            "major": ch.get("major"),
            "minor": ch.get("minor"),
            "network": ch.get("network"),
            "logo_url": logos.get("originalLarge") or logos.get("darkLarge"),
            # The device says `source` here where the guide mirror says `kind`;
            # both hold "ota" for anything that can have been recorded.
            "kind": ch.get("source"),
        },
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


# One BIF fetch at a time per recording.
#
# A pointer crossing the coverage strip asks for a frame every few pixels, and
# on a recording whose pack is missing every one of those would otherwise start
# its own multi-megabyte download of the same thing.
_bif_locks: dict[int, asyncio.Lock] = {}


def _preview_fetch_lock(object_id: int) -> asyncio.Lock:
    return _bif_locks.setdefault(int(object_id), asyncio.Lock())


@router.get("/{object_id}/preview")
async def recording_preview(object_id: int, t: float = 0.0):
    """One scrub-preview thumbnail, at or just before ``t`` seconds.

    Served from the device's own BIF pack, stored alongside the recording. The
    frames sit ~10s apart, so the client rounds its request to that grid and the
    browser cache does the rest of the work during a drag.
    """
    _require_auth()
    frame = cache.preview_frame(object_id, t)

    # Nothing here yet, so fetch the pack and answer from it.
    #
    # It used to be fetched only when a recording was played, so scrubbing the
    # Library card of something never opened showed nothing at all - the
    # previews arrived only after a watch, which is the one time they are least
    # needed. Fetched here instead, on the first frame anybody actually asks
    # for, so the cost falls on recordings that get scrubbed rather than on
    # every recording in the library: the packs run 3-14 MB each, and pulling
    # the lot on a listing would be well over a hundred megabytes off the device
    # for pictures mostly nobody looks at.
    #
    # One fetch at a time per recording, so a pointer sweeping the strip cannot
    # start a dozen of them.
    if frame is None and not cache.preview_available(object_id):
        async with _preview_fetch_lock(object_id):
            if not cache.preview_available(object_id):
                try:
                    path, _duration = await state.resolve_recording(object_id)
                    await cache.fetch_bif(object_id, path)
                except Exception as e:
                    print(f"[preview] {object_id}: {e}", flush=True)
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


@router.delete("/{object_id}")
async def delete_recording(object_id: int):
    """Delete a recording on the Tablo, and every local trace of it.

    Distinct from `/{object_id}/cache`, which only drops the transcoded copy
    and leaves the recording on the device - a difference the Library's own
    button blurred until this existed.

    Ordered device-first on purpose: if the device refuses, the recording still
    exists and the local record has to keep saying so. The local clean-up is
    what stops a deleted recording from lingering as a search result that fails
    when clicked, or as an info sheet still offering to delete it.
    """
    _require_auth()
    try:
        path, _ = await state.resolve_recording(object_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Recording not found") from None

    try:
        await state.delete_recording(path)
    except Exception:
        raise HTTPException(
            status_code=502, detail="The Tablo would not delete this recording."
        ) from None

    await cache.stop(object_id)
    cache.evict(object_id, force=True)
    await _run_sync(store.forget_recording, object_id)
    return {"object_id": object_id, "deleted": True}


@router.get("/{object_id}/thumbnail")
async def recording_thumbnail(object_id: int, frame: int | None = None):
    """Proxy the device snapshot image, or a frame the viewer chose instead.

    Proxied rather than linked directly because the device is reachable from the
    backend, not necessarily from the browser.

    ``frame`` is the chosen position in milliseconds, and it is in the URL
    rather than merely in the database because **a different picture has to be
    a different address**. It was not, and the consequence was the whole feature
    appearing to work once: this route served the snapshot as
    `public, max-age=86400`, so any browser that fetched it before a frame was
    picked - which is every card with no artwork behind it - held that snapshot
    as fresh for a day and never asked again. Picking a frame then changed
    nothing on screen, and no amount of restarting the stack helped, because the
    staleness was in the browser.

    Unvalidated on purpose. The parameter only selects among frames of this
    recording, `preview_frame` clamps to the pack it has, and a stale or absent
    one simply falls through to the snapshot below - so a wrong value costs an
    old picture, never an error.
    """
    _require_auth()

    # A frame the viewer picked wins over everything, including a saved copy:
    # it is the one picture here that someone chose on purpose.
    art = await _run_sync(partial(store.recording_art, object_id)) or {}
    frame_ms = art.get("cover_frame_ms")
    if frame_ms is not None:
        picture = cache.preview_frame(object_id, frame_ms / 1000)
        if picture is not None:
            return Response(
                content=picture,
                media_type="image/jpeg",
                # Cacheable hard, now that the address says which frame this is:
                # a different choice arrives at a different URL. Only a request
                # that named the current frame may be kept, though - one sent
                # before the choice was made, or after it changed, is answering
                # a question nobody is asking any more.
                headers={
                    "Cache-Control": (
                        "public, max-age=604800, immutable"
                        if frame == int(frame_ms) else "no-cache"
                    ),
                },
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
