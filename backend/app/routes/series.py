"""Recordings-series management: the DVR home behind the Recordings tab.

Where `recordings.py` is about individual captured episodes, this is about the
*series* I record — the rule (all/new/none), how many to keep, padding, and
bulk cleanup — plus read-only views of what is scheduled and what conflicts.

Everything here composes signed device reads/writes from `state`; the endpoint
shapes are documented in docs/tablo-api.md. This router shares the
`/api/recordings` prefix with `recordings.py` and is registered *before* it, so
its literal `/series`, `/upcoming`, `/conflicts` paths win over that router's
`/{object_id}` routes.
"""
import asyncio
import json
import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from ..state import state

router = APIRouter(prefix="/api/recordings", tags=["series"])

# A recordings path we will forward to the device must be exactly a recordings
# show or an /episodes suffix of one — never an arbitrary path. The device signs
# whatever we hand it, so an unvalidated path is an SSRF-shaped hole.
_REC_PATH = re.compile(r"^/recordings/(series|sports|movies)/\d+$")


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


def _device_error(status: int, data: dict) -> HTTPException:
    """The device's own words for a refusal, or a fixed message otherwise."""
    if status == 400:
        description = ((data or {}).get("error") or {}).get("description")
        return HTTPException(status_code=400,
                             detail=description or "The Tablo refused the change.")
    return HTTPException(status_code=502, detail="The Tablo could not be reached.")


async def _try(method: str, path: str):
    """A tolerant read: a failing sub-fetch becomes None, not a 500."""
    try:
        return await state.request_device(method, path)
    except Exception:
        return None


@router.get("/upcoming")
async def upcoming():
    """Scheduled airings, lightest projection (lineup handles + schedule).

    The device returns `{identifier, schedule{state, qualifier, skip_reason,
    skip_detail, offsets}}` per airing; the identifier is a lineup handle that
    encodes datetime and channel but no title (see docs/tablo-api.md). `&lh` is
    required — the endpoint 400s without it.
    """
    _require_auth()
    return await state.request_device("GET", "/guide/airings?state=requested&lh")


@router.get("/conflicts")
async def conflicts():
    """Airings the device flags as double-booked. Read-only in v1."""
    _require_auth()
    return await state.request_device("GET", "/guide/airings?state=conflicted&lh")


@router.get("/series")
async def series_index():
    _require_auth()
    return {"series": await _compose_series_index()}


def _kind_of(recordings_path: str) -> str | None:
    parts = recordings_path.split("/")
    return parts[2] if len(parts) > 2 else None


_DEFAULT_OFFSETS = {"start": 0, "end": 0, "source": "none"}
_DEFAULT_KEEP = {"rule": "none", "count": None}


async def _compose_series_index() -> list[dict]:
    """Merge the two device views of a series.

    `/guide/shows?state=requested&lh` is the live rule set — the only place the
    rule, offsets and the settings `identifier` live; it returns full objects
    keyed (for our purposes) by `recordings_path`. `/recordings/shows` is what
    actually has recordings on disk. A recorded series with no active rule is
    absent from the first list, so it lists with rule "none" and a null
    identifier (settings disabled, cleanup still available). Per-series fetches
    are bounded and tolerant — one flaky series drops itself, not the page.
    """
    guide = await _try("GET", "/guide/shows?state=requested&lh") or []
    by_recpath = {g["recordings_path"]: g
                  for g in guide if g.get("recordings_path")}
    rec_paths = await _try("GET", "/recordings/shows") or []

    sem = asyncio.Semaphore(8)

    async def one(path: str) -> dict | None:
        async with sem:
            meta = await _try("GET", path)
        if not meta:
            return None
        series = meta.get("series") or {}
        counts = meta.get("show_counts") or {}
        g = by_recpath.get(path)
        if g:
            sched = g.get("schedule") or {}
            rule = sched.get("rule") or "none"
            offsets = sched.get("offsets") or dict(_DEFAULT_OFFSETS)
            keep = g.get("keep") or meta.get("keep") or dict(_DEFAULT_KEEP)
            identifier = g.get("identifier")
        else:
            rule = "none"
            offsets = dict(_DEFAULT_OFFSETS)
            keep = meta.get("keep") or dict(_DEFAULT_KEEP)
            identifier = None
        return {
            "recordings_path": path,
            "identifier": identifier,
            "kind": _kind_of(path),
            "title": series.get("title") or "Untitled",
            "cover_image_id": (series.get("cover_image") or {}).get("image_id"),
            "rule": rule,
            "keep": keep,
            "offsets": offsets,
            "episode_count": counts.get("airing_count", 0),
            "unwatched_count": counts.get("unwatched_count", 0),
            "protected_count": counts.get("protected_count", 0),
            "conflict": False,
        }

    results = await asyncio.gather(*[one(p) for p in rec_paths])
    return [r for r in results if r]


def _img(x) -> int | None:
    """Snapshot/cover image, however the device wraps it (id, or {image_id})."""
    if isinstance(x, dict):
        return x.get("image_id")
    return x if isinstance(x, int) else None


def _episode_row(ep: dict) -> dict:
    """One episode-list row from a resolved episode object.

    Duration is `video_details.duration` — the real recorded length including
    padding — never `airing_details.duration`, which is only the scheduled slot.
    """
    episode = ep.get("episode") or {}
    airing = ep.get("airing_details") or {}
    video = ep.get("video_details") or {}
    user = ep.get("user_info") or {}
    return {
        "object_id": ep.get("object_id"),
        "title": episode.get("title"),
        "season_number": episode.get("season_number"),
        "episode_number": episode.get("number"),
        "orig_air_date": episode.get("orig_air_date"),
        "datetime": airing.get("datetime"),
        "duration": video.get("duration") or 0,
        "size": video.get("size"),
        "state": video.get("state"),
        "snapshot_image": _img(ep.get("snapshot_image")),
        "position": user.get("position", 0),
        "watched": user.get("watched", False),
        "protected": user.get("protected", False),
        "is_recording": video.get("state") == "recording",
    }


@router.get("/series/detail")
async def series_detail(recordings_path: str = Query(...)):
    """A series' meta, its live settings, and its episode list.

    Settings (rule/offsets/identifier) come only from the guide-shows
    projection; keep falls back to the series meta. Episodes are resolved in one
    `POST /batch` over the episode paths.
    """
    _require_auth()
    if not _REC_PATH.match(recordings_path):
        raise HTTPException(status_code=400,
                            detail="Not a recordings series path")
    try:
        meta = await state.request_device("GET", recordings_path)
        ep_paths = await state.request_device(
            "GET", recordings_path + "/episodes") or []
        resolved = {}
        if ep_paths:
            resolved = await state.request_device(
                "POST", "/batch", json.dumps(ep_paths)) or {}
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None

    series = meta.get("series") or {}
    guide = await _try("GET", "/guide/shows?state=requested&lh") or []
    g = next((x for x in guide
              if x.get("recordings_path") == recordings_path), None)
    if g:
        sched = g.get("schedule") or {}
        settings = {
            "identifier": g.get("identifier"),
            "rule": sched.get("rule") or "none",
            "keep": g.get("keep") or meta.get("keep") or dict(_DEFAULT_KEEP),
            "offsets": sched.get("offsets") or dict(_DEFAULT_OFFSETS),
        }
    else:
        settings = {
            "identifier": None,
            "rule": "none",
            "keep": meta.get("keep") or dict(_DEFAULT_KEEP),
            "offsets": dict(_DEFAULT_OFFSETS),
        }

    episodes = [_episode_row(resolved[p]) for p in ep_paths if p in resolved]

    return {
        "meta": {
            "title": series.get("title") or "Untitled",
            "genres": series.get("genres") or [],
            "description": series.get("description"),
            "cover_image_id": (series.get("cover_image") or {}).get("image_id"),
            "kind": _kind_of(recordings_path),
        },
        "settings": settings,
        "counts": meta.get("show_counts") or {},
        "episodes": episodes,
    }


class KeepIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rule: Literal["all", "none", "count"]
    count: int | None = None


class OffsetsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: int
    end: int


class SeriesSettingsIn(BaseModel):
    """Allow-listed series settings write. Unknown keys are rejected (422)."""
    model_config = ConfigDict(extra="forbid")
    identifier: str
    rule: Literal["all", "new", "none"] | None = None
    keep: KeepIn | None = None
    offsets: OffsetsIn | None = None


async def _patch_guide(identifier: str, body: dict) -> dict:
    """PATCH /guide/{identifier}, with one retry on the transient 999.

    One keep write was observed to return 999 then succeed on retry; a single
    retry covers it without masking a real refusal.
    """
    path = f"/guide/{identifier}"
    status, data = await state.patch_device(path, body)
    if status == 999:
        status, data = await state.patch_device(path, body)
    if status != 200:
        raise _device_error(status, data)
    return data


@router.patch("/series/settings")
async def series_settings(body: SeriesSettingsIn):
    """Map an allow-listed settings body to the nested device writes.

    Rule and offsets both live under `schedule`, so they go in one PATCH; keep
    is its own PATCH. Offsets `source` flips to "show" when either side is
    non-zero, "none" at defaults. Seconds throughout.
    """
    _require_auth()
    echo: dict = {}

    schedule: dict = {}
    if body.rule is not None:
        schedule["rule"] = body.rule
    if body.offsets is not None:
        start, end = body.offsets.start, body.offsets.end
        schedule["offsets"] = {
            "source": "show" if (start or end) else "none",
            "start": start,
            "end": end,
        }
    if schedule:
        echo["schedule"] = await _patch_guide(body.identifier,
                                              {"schedule": schedule})

    if body.keep is not None:
        keep: dict = {"rule": body.keep.rule}
        if body.keep.rule == "count":
            keep["count"] = body.keep.count
        echo["keep"] = await _patch_guide(body.identifier, {"keep": keep})

    if not echo:
        raise HTTPException(status_code=400, detail="No settings to change")
    return {"identifier": body.identifier, "echo": echo}
