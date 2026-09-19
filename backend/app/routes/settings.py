"""Device settings: reads and writes over the Tablo settings surface.

Thin passthrough. Every device call is signed in `state`; nothing here talks to
the box directly. The endpoint map, the flat one-key-per-PATCH write shape, and
the channel scan/commit lifecycle are all documented in docs/tablo-api.md.

Where the device exposes no write verb (a guide refresh, setting the location by
postal code), the route is present but a no-op: it returns a `noop` marker so the
UI can show the control as "not yet available" rather than hide it, and a later
capture can wire it without a new route.
"""
import asyncio
import json as _json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..state import state

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


def _device_error(status: int, data: dict) -> HTTPException:
    """The device's own words for a refusal, or a fixed message for the rest.

    Mirrors schedule.py: a 400 carries `error.description`, the only thing that
    can say why a write was refused; anything else is a transport problem.
    """
    if status == 400:
        description = ((data or {}).get("error") or {}).get("description")
        return HTTPException(status_code=400,
                             detail=description or "The Tablo refused the change.")
    return HTTPException(status_code=502, detail="The Tablo could not be reached.")


async def _try(method: str, path: str):
    """A tolerant read: a failing sub-fetch becomes None, not a 500.

    The overview fans out seven reads for one screen; one flaky endpoint should
    grey out its own card, not blank the whole modal.
    """
    try:
        return await state.request_device(method, path)
    except Exception:
        return None


def _channel_view(path: str, rec: dict | None) -> dict:
    """One discovered-channel record, flattened for the lineup UI."""
    rec = rec or {}
    ch = rec.get("channel") or {}
    return {
        "path": path,
        "channel_identifier": ch.get("channel_identifier"),
        "call_sign": ch.get("call_sign"),
        "resolution": ch.get("resolution"),
        "selected": rec.get("selected", True),
        "signal_state": rec.get("signal_state"),
    }


async def _discovered_views(paths: list[str]) -> list[dict]:
    async def one(p: str) -> dict:
        cid = p.rstrip("/").split("/")[-1]
        rec = await _try("GET", f"/channels/scans/discovered/{cid}")
        return _channel_view(p, rec)

    return list(await asyncio.gather(*[one(p) for p in paths]))


def _paths_of(disc) -> list[str]:
    if isinstance(disc, list):
        return disc
    return (disc or {}).get("discovered", [])


# --- Reads -----------------------------------------------------------------

@router.get("/overview")
async def overview():
    _require_auth()
    server, network, harddrives, guide, location, settings_info, update = (
        await asyncio.gather(
            _try("GET", "/server/info"),
            _try("GET", "/server/network"),
            _try("GET", "/server/harddrives"),
            _try("GET", "/server/guide/status"),
            _try("GET", "/server/location"),
            _try("GET", "/settings/info?allowAudioTranscode=true"),
            _try("GET", "/server/update/info"),
        )
    )
    return {
        "server": server,
        "network": network,
        "harddrives": harddrives,
        "guide": guide,
        "location": location,
        "settings": settings_info,
        "update": update,
    }


@router.get("/info")
async def info():
    _require_auth()
    return await state.request_device("GET", "/settings/info?allowAudioTranscode=true")


@router.get("/harddrives")
async def harddrives():
    _require_auth()
    return await state.request_device("GET", "/server/harddrives")


@router.get("/location")
async def location():
    _require_auth()
    return await state.request_device("GET", "/server/location")


@router.get("/guide-status")
async def guide_status():
    _require_auth()
    return await state.request_device("GET", "/server/guide/status")


# --- Writes (real: the device has the verb) --------------------------------

_BOOL_KEYS = {"enable_amplifier", "exclude_duplicates",
              "extend_live_recordings", "auto_delete_recordings"}
_ENUM_KEYS = {"led": {"on", "dim", "off"}, "audio": {"ac3", "aac"}}


@router.patch("/info")
async def patch_info(body: dict):
    """Write exactly one flat setting to /settings/info.

    The device's PATCH is flat and per-key; the allow-list keeps a typo (or a
    hostile client) off the wire and returns the same 400 the device would.
    """
    _require_auth()
    if len(body) != 1:
        raise HTTPException(400, "Send exactly one setting per request.")
    key, value = next(iter(body.items()))
    if key in _BOOL_KEYS:
        if not isinstance(value, bool):
            raise HTTPException(400, f"{key} must be a boolean.")
    elif key in _ENUM_KEYS:
        if value not in _ENUM_KEYS[key]:
            allowed = sorted(_ENUM_KEYS[key])
            raise HTTPException(400, f"{key} must be one of {allowed}.")
    else:
        raise HTTPException(400, f"{key} is not a writable setting.")
    status, data = await state.patch_device("/settings/info", {key: value})
    if status >= 400:
        raise _device_error(status, data)
    return data


class NameIn(BaseModel):
    name: str


@router.patch("/name")
async def patch_name(body: NameIn):
    _require_auth()
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty.")
    status, data = await state.patch_device("/server/info", {"name": name})
    if status >= 400:
        raise _device_error(status, data)
    return data


# --- Channels: lineup, scan lifecycle, commit ------------------------------

@router.get("/channels")
async def channels_lineup():
    _require_auth()
    info_obj = await state.request_device("GET", "/channels/info")
    committed = (info_obj or {}).get("committed_scan")
    if not committed:
        return {"scan_id": None, "channels": []}
    scan_id = committed.rstrip("/").split("/")[-1]
    disc = await state.request_device("GET", f"/channels/scans/{scan_id}/discovered")
    return {"scan_id": scan_id, "channels": await _discovered_views(_paths_of(disc))}


@router.post("/channels/scan")
async def channels_scan_start():
    _require_auth()
    scan = await state.request_device("POST", "/channels/scans")
    return {
        "scan_id": scan.get("object_id"),
        "progress": scan.get("progress", 0.0),
        "completed": scan.get("completed", False),
    }


@router.get("/channels/scan/{scan_id}")
async def channels_scan_status(scan_id: str):
    _require_auth()
    scan = await state.request_device("GET", f"/channels/scans/{scan_id}")
    return {
        "progress": scan.get("progress", 0.0),
        "completed": scan.get("completed", False),
    }


@router.get("/channels/scan/{scan_id}/discovered")
async def channels_scan_discovered(scan_id: str):
    _require_auth()
    disc = await state.request_device("GET", f"/channels/scans/{scan_id}/discovered")
    return {"channels": await _discovered_views(_paths_of(disc))}


class CommitIn(BaseModel):
    scan_id: str
    paths: list[str]


@router.post("/channels/commit")
async def channels_commit(body: CommitIn):
    """Commit the kept lineup. The array IS the lineup: a channel omitted from
    it is hidden from the guide and no longer tunable. See docs/tablo-api.md.
    """
    _require_auth()
    await state.request_device(
        "POST",
        f"/channels/scans/{body.scan_id}/commit",
        _json.dumps(body.paths, separators=(",", ":")),
    )
    return {"ok": True, "count": len(body.paths)}


# --- No-op writes (device verb not captured yet) ---------------------------

@router.post("/guide/update")
async def guide_update():
    _require_auth()
    return {"ok": False, "noop": True, "reason": "no guide-refresh verb captured"}


class LocationIn(BaseModel):
    postal_code: str


@router.patch("/location")
async def set_location(body: LocationIn):
    _require_auth()
    return {"ok": False, "noop": True, "reason": "no location-set verb captured"}
