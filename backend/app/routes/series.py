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
import re

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


async def _compose_series_index() -> list[dict]:
    return []
