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
import logging
import re
import time
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from ..state import state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/recordings", tags=["series"])

# A recordings path we will forward to the device must be exactly a recordings
# show or an /episodes suffix of one — never an arbitrary path. The device signs
# whatever we hand it, so an unvalidated path is an SSRF-shaped hole.
_REC_PATH = re.compile(r"^/recordings/(series|sports|movies)/\d+$")
_GUIDE_PATH = re.compile(r"^/guide/(series|sports|movies)/\d+$")


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


async def _try(method: str, path: str, body: str = ""):
    """A tolerant read: a failing sub-fetch becomes None, not a 500."""
    try:
        return await state.request_device(method, path, body)
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


@router.get("/schedule")
async def schedule():
    """Every upcoming airing of every series I record, titled and state-marked.

    Rows carry `state` (`scheduled`/`skipped`/`conflicted`/`recording`) and
    `skip_reason`, so what will *not* record is as visible as what will.
    """
    _require_auth()
    return await _compose_schedule()


def _kind_of(recordings_path: str) -> str | None:
    parts = recordings_path.split("/")
    return parts[2] if len(parts) > 2 else None


def _show_of(meta: dict) -> dict:
    """The title-bearing sub-object, whatever the recording kind calls it.

    Series meta nests it under `series`, sports under `sport`, movies under
    `movie` — same shape (title/genres/description/cover_image) each time.
    """
    return (meta.get("series") or meta.get("sport")
            or meta.get("movie") or {})


_DEFAULT_OFFSETS = {"start": 0, "end": 0, "source": "none"}
_DEFAULT_KEEP = {"rule": "none", "count": None}


# identifier -> resolved catalog object, cached per device sid. The
# `/guide/shows` catalog is ~884 shows and slow-changing; resolving it on every
# Recordings load is wasteful, so we memoise it briefly.
_RULED_CATALOG_CACHE: dict[str, tuple[float, dict[str, dict]]] = {}
_RULED_CATALOG_TTL = 300.0  # seconds
_BATCH_CHUNK = 48


def _kind_of_guide(path: str | None) -> str | None:
    if not path:
        return None
    parts = path.split("/")
    return parts[2] if len(parts) > 2 else None


async def _ruled_catalog_index(want_ids: set[str]) -> dict[str, dict]:
    """Map each wanted rule `identifier` to its resolved catalog object.

    The `requested&lh` rule set carries no title/cover/guide_path, and `/batch`
    rejects SHOW identifiers, so the only join is `identifier` across the
    `/guide/shows` catalog. Cached per device sid (TTL) because the catalog is
    large and slow-changing; the scan early-exits once every wanted id is found.
    """
    if not want_ids:
        return {}
    sid = getattr(state, "active_sid", None) or "_"
    hit = _RULED_CATALOG_CACHE.get(sid)
    if (hit and (time.monotonic() - hit[0]) < _RULED_CATALOG_TTL
            and want_ids <= hit[1].keys()):
        return {k: hit[1][k] for k in want_ids if k in hit[1]}
    paths = await _try("GET", "/guide/shows") or []
    index: dict[str, dict] = {}
    for i in range(0, len(paths), _BATCH_CHUNK):
        chunk = [p for p in paths[i:i + _BATCH_CHUNK] if isinstance(p, str)]
        if not chunk:
            continue
        resolved = await _try("POST", "/batch", json.dumps(chunk)) or {}
        for key, obj in resolved.items():
            if isinstance(obj, dict) and obj.get("identifier"):
                obj.setdefault("path", key)
                index[obj["identifier"]] = obj
        if want_ids <= index.keys():
            break
    _RULED_CATALOG_CACHE[sid] = (time.monotonic(), index)
    return {k: index[k] for k in want_ids if k in index}


async def resolve_ruled() -> list[dict]:
    """Every series that has a recording rule, recorded or not.

    The `requested&lh` rule set gives rule/keep/offsets/identifier and, for the
    recorded ones, a recordings_path. A **recorded** ruled series is fleshed out
    from its own recordings meta (title/cover/guide_path/counts) — no catalog
    needed, so a catalog hiccup never costs a recorded series its rule. Only the
    **unrecorded** ruled series (no recordings_path, invisible to the old
    recorded-paths-only index) fall back to the `/guide/shows` catalog. Each
    output dict carries title, cover, guide_path (for `/episodes`) and counts.
    """
    ruled = await _try("GET", "/guide/shows?state=requested&lh") or []
    sem = asyncio.Semaphore(8)

    async def _meta(path: str) -> dict | None:
        async with sem:
            return await _try("GET", path)

    recorded = [r for r in ruled if r.get("recordings_path")]
    metas = await asyncio.gather(*[_meta(r["recordings_path"]) for r in recorded])
    meta_by_path = {r["recordings_path"]: (m or {})
                    for r, m in zip(recorded, metas)}
    want = {r["identifier"] for r in ruled
            if r.get("identifier") and not r.get("recordings_path")}
    index = await _ruled_catalog_index(want)

    out: list[dict] = []
    for r in ruled:
        ident = r.get("identifier")
        sched = r.get("schedule") or {}
        recpath = r.get("recordings_path")
        if recpath:
            meta = meta_by_path.get(recpath) or {}
            show = _show_of(meta)
            guide_path = meta.get("guide_path")
            counts = meta.get("show_counts") or {}
            kind = _kind_of(recpath)
            keep = r.get("keep") or meta.get("keep") or dict(_DEFAULT_KEEP)
        else:
            cat = index.get(ident) if ident else None
            if not cat:
                if ident:
                    logger.warning("ruled series %s not found in catalog", ident)
                continue
            show = _show_of(cat)
            guide_path = cat.get("path")
            counts = cat.get("show_counts") or {}
            kind = _kind_of_guide(guide_path)
            keep = r.get("keep") or cat.get("keep") or dict(_DEFAULT_KEEP)
        out.append({
            "identifier": ident,
            "guide_path": guide_path,
            "recordings_path": recpath,
            "kind": kind,
            "title": show.get("title") or "Untitled",
            "cover_image_id": _img(show.get("cover_image")),
            "rule": sched.get("rule") or "none",
            "keep": keep,
            "offsets": sched.get("offsets") or dict(_DEFAULT_OFFSETS),
            "show_counts": counts,
        })
    return out


def _card(*, recordings_path, identifier, guide_path, kind, title,
          cover_image_id, rule, keep, offsets, counts) -> dict:
    """The one card shape the Recordings grid consumes."""
    return {
        "recordings_path": recordings_path,
        "identifier": identifier,
        "guide_path": guide_path,
        "kind": kind,
        "title": title,
        "cover_image_id": cover_image_id,
        "rule": rule,
        "keep": keep,
        "offsets": offsets,
        "episode_count": counts.get("airing_count", 0),
        "unwatched_count": counts.get("unwatched_count", 0),
        "protected_count": counts.get("protected_count", 0),
        "failed_count": counts.get("failed_count", 0),
        "scheduled_count": counts.get("scheduled_count", 0),
        "conflict": (counts.get("conflicted_count", 0) or 0) > 0,
    }


async def _compose_series_index() -> list[dict]:
    """Every series worth a card: the union of those with a rule (recorded or
    not) and those with recordings but no rule.

    `resolve_ruled()` supplies the ruled set with title/cover/guide_path even
    when nothing is on disk yet — the case the old recorded-paths-only loop
    dropped, so a scheduled-but-never-recorded series was invisible. Recorded
    ruled series are enriched with real disk counts; recorded-but-unruled
    series are then added from `/recordings/shows` with rule "none". Per-series
    fetches are bounded and tolerant — one flaky series drops itself.
    """
    ruled = await resolve_ruled()
    ruled_recpaths = {r["recordings_path"] for r in ruled if r.get("recordings_path")}
    rec_paths = await _try("GET", "/recordings/shows") or []
    sem = asyncio.Semaphore(8)

    async def _meta(path: str) -> dict | None:
        async with sem:
            return await _try("GET", path)

    cards: list[dict] = [
        _card(
            recordings_path=r.get("recordings_path"),
            identifier=r["identifier"],
            guide_path=r.get("guide_path"),
            kind=r.get("kind"),
            title=r["title"],
            cover_image_id=r["cover_image_id"],
            rule=r["rule"], keep=r["keep"], offsets=r["offsets"],
            counts=r.get("show_counts") or {},
        )
        for r in ruled
    ]

    async def _unruled_card(path: str) -> dict | None:
        if path in ruled_recpaths:
            return None
        meta = await _meta(path)
        if not meta:
            return None
        show = _show_of(meta)
        return _card(
            recordings_path=path, identifier=None, guide_path=None,
            kind=_kind_of(path), title=show.get("title") or "Untitled",
            cover_image_id=_img(show.get("cover_image")),
            rule="none", keep=meta.get("keep") or dict(_DEFAULT_KEEP),
            offsets=dict(_DEFAULT_OFFSETS), counts=meta.get("show_counts") or {},
        )

    extra = await asyncio.gather(*[_unruled_card(p) for p in rec_paths])
    cards.extend(c for c in extra if c)
    return cards


async def _compose_schedule() -> list[dict]:
    """Every upcoming airing of every ruled series, titled and state-marked.

    Scoped to the series I record (not the whole lineup). Each row keeps its
    real `schedule.state`, so a rerun a "new" rule skips shows as such instead
    of vanishing. A series whose `/episodes` read fails drops itself.
    """
    ruled = await resolve_ruled()
    sem = asyncio.Semaphore(6)

    async def _rows(r: dict) -> list[dict]:
        gp = r.get("guide_path")
        if not gp:
            return []
        async with sem:
            paths = await _try("GET", f"{gp}/episodes") or []
            resolved = (await _try("POST", "/batch", json.dumps(paths[:300]))
                        if paths else {}) or {}
        rows = []
        for a in resolved.values():
            if not isinstance(a, dict):
                continue
            row = _airing_row(a)
            row["series_title"] = r["title"]
            row["series_cover_image_id"] = r["cover_image_id"]
            rows.append(row)
        return rows

    nested = await asyncio.gather(*[_rows(r) for r in ruled])
    rows = [row for group in nested for row in group]
    rows.sort(key=lambda x: x.get("datetime") or "")
    return rows


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


def _airing_row(a: dict) -> dict:
    """One scheduled/conflicted airing row for a series (titled, unlike the
    global lineup-handle list)."""
    episode = a.get("episode") or {}
    ad = a.get("airing_details") or {}
    ch = (ad.get("channel") or {}).get("channel") or {}
    sched = a.get("schedule") or {}
    channel = ch.get("call_sign")
    if not channel and ch.get("major") is not None:
        channel = f"{ch.get('major')}.{ch.get('minor')}"
    return {
        "object_id": a.get("object_id"),
        "title": episode.get("title") or ad.get("show_title"),
        "season_number": episode.get("season_number"),
        "episode_number": episode.get("number"),
        "datetime": ad.get("datetime"),
        "duration": ad.get("duration"),
        "channel": channel,
        "state": sched.get("state"),
        "skip_reason": sched.get("skip_reason"),
    }


@router.get("/series/airings")
async def series_airings(
    guide_path: str = Query(...),
    airing_state: Literal["requested", "conflicted", "all"] = Query(
        "requested", alias="state"),
):
    """This series' scheduled ("requested") or conflicted airings, titled.

    `{guide_path}/episodes` returns plain, batch-able episode paths (the
    `?state=…&lh` filtered variant returns lineup handles that `/batch` rejects
    as "Malformed endpoint"). So resolve them all in one `POST /batch`, then keep
    the ones whose `schedule.state` matches — giving titled rows with channels,
    unlike the global lineup-handle list. `guide_path` is allow-listed.
    """
    _require_auth()
    if not _GUIDE_PATH.match(guide_path):
        raise HTTPException(status_code=400, detail="Not a guide series path")
    want = "conflicted" if airing_state == "conflicted" else "scheduled"
    try:
        paths = await state.request_device(
            "GET", f"{guide_path}/episodes") or []
        resolved = {}
        if paths:
            resolved = await state.request_device(
                "POST", "/batch", json.dumps(paths[:300])) or {}
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    rows = [
        _airing_row(a) for a in resolved.values()
        if isinstance(a, dict)
        and (airing_state == "all"
             or (a.get("schedule") or {}).get("state") == want)
    ]
    rows.sort(key=lambda r: r.get("datetime") or "")
    return rows


async def _series_detail_by_guide(guide_path: str) -> dict:
    """Detail for a ruled series with nothing recorded yet — keyed on its guide
    series path. Meta/settings come from the ruled+catalog join; there are no
    on-disk episodes to list."""
    if not _GUIDE_PATH.match(guide_path):
        raise HTTPException(status_code=400, detail="Not a guide series path")
    r = next((x for x in await resolve_ruled()
              if x.get("guide_path") == guide_path), None)
    if not r:
        raise HTTPException(status_code=404,
                            detail=f"Series {guide_path} not found")
    return {
        "meta": {
            "title": r["title"],
            "genres": [],
            "description": None,
            "cover_image_id": r["cover_image_id"],
            "kind": r.get("kind"),
            "guide_path": guide_path,
        },
        "settings": {
            "identifier": r["identifier"],
            "rule": r["rule"],
            "keep": r["keep"],
            "offsets": r["offsets"],
        },
        "counts": r.get("show_counts") or {},
        "episodes": [],
    }


@router.get("/series/detail")
async def series_detail(
    recordings_path: str | None = Query(None),
    guide_path: str | None = Query(None),
):
    """A series' meta, its live settings, and its episode list.

    Addressed by `recordings_path` (a series on disk) or, for a ruled series
    with nothing recorded yet, by `guide_path`. Settings (rule/offsets/
    identifier) come from the guide-shows projection; keep falls back to the
    series meta. Episodes are resolved in one `POST /batch` over the episode
    paths — empty for a guide-only series, which has none on disk.
    """
    _require_auth()
    if not recordings_path and not guide_path:
        raise HTTPException(status_code=400,
                            detail="Give recordings_path or guide_path")
    if guide_path and not recordings_path:
        return await _series_detail_by_guide(guide_path)
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
    except httpx.HTTPStatusError as e:
        # The device answered, with an error. A 404 means this series is gone
        # (deleted, or a stale path a client still holds) — that is a 404 to our
        # caller, not "the Tablo could not be reached". Any other status is the
        # box refusing or failing, which stays a 502.
        if e.response.status_code == 404:
            raise HTTPException(
                status_code=404,
                detail=f"Series {recordings_path} not found") from None
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None

    series = _show_of(meta)
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

    # `POST /batch` answers with the key present and the value `null` for a path
    # it cannot resolve — an episode deleted between the listing and the batch,
    # which bulk-delete makes routine. Filtering on the key let that `null`
    # through and `_episode_row` crashed the whole detail request on it, so the
    # page died for one stale path among dozens of good ones. Filter on the
    # value instead: the episode is simply gone, which is what the caller means.
    episodes = [
        _episode_row(ep)
        for ep in (resolved.get(p) for p in ep_paths)
        if isinstance(ep, dict)
    ]

    return {
        "meta": {
            "title": series.get("title") or "Untitled",
            "genres": series.get("genres") or [],
            "description": series.get("description"),
            "cover_image_id": (series.get("cover_image") or {}).get("image_id"),
            "kind": _kind_of(recordings_path),
            "guide_path": meta.get("guide_path"),
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
    # The device settings live on the guide *series* object, addressed by its
    # path (`/guide/series/377`). `/guide/{identifier}` is not a resource (the
    # device 404s it), so the client sends the guide path it already holds.
    guide_path: str
    rule: Literal["all", "new", "none"] | None = None
    keep: KeepIn | None = None
    offsets: OffsetsIn | None = None


async def _patch_guide(path: str, body: dict) -> dict:
    """PATCH a guide series path, with one retry on the transient 999.

    One keep write was observed to return 999 then succeed on retry; a single
    retry covers it without masking a real refusal.
    """
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
    if not _GUIDE_PATH.match(body.guide_path):
        raise HTTPException(status_code=400, detail="Not a guide series path")
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
        echo["schedule"] = await _patch_guide(body.guide_path,
                                              {"schedule": schedule})

    if body.keep is not None:
        keep: dict = {"rule": body.keep.rule}
        if body.keep.rule == "count":
            keep["count"] = body.keep.count
        echo["keep"] = await _patch_guide(body.guide_path, {"keep": keep})

    if not echo:
        raise HTTPException(status_code=400, detail="No settings to change")
    return {"identifier": body.identifier, "echo": echo}


class BulkDeleteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recordings_path: str
    filter: Literal["watched", "unprotected"]


@router.post("/series/bulk-delete")
async def series_bulk_delete(body: BulkDeleteIn):
    """Delete a series' episodes by the device's own filter.

    `watched` removes watched episodes; `unprotected` is the device's "delete
    all" — it skips protected ones. The device answers 200/204 (no body), so it
    goes through the raw helper. recordings_path is allow-listed.
    """
    _require_auth()
    if not _REC_PATH.match(body.recordings_path):
        raise HTTPException(status_code=400,
                            detail="Not a recordings series path")
    try:
        resp = await state._request_device_raw(
            "POST", body.recordings_path + "/delete",
            json.dumps({"filter": body.filter}))
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    return {"ok": True, "filter": body.filter, "status": resp.status_code}
