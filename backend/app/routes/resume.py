"""Playback resume positions.

Moved server-side from the browser's localStorage so a position follows the
user between browsers rather than being tied to one profile's site data.

The URL is unaffected and still carries identity only - what is playing, not
where the playhead is. That was the point of the original decision to keep
positions out of the address bar, and it still holds.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import store
from ..state import _run_sync, state

router = APIRouter(prefix="/api/resume", tags=["resume"])

_KINDS = ("live", "recording")


class ResumeIn(BaseModel):
    kind: str
    ref: str
    position: float
    duration: float = 0.0


class ImportIn(BaseModel):
    """The client's old localStorage map, keyed ``"<kind>:<ref>"``."""
    entries: dict[str, float] = Field(default_factory=dict)


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


def _check_kind(kind: str) -> None:
    if kind not in _KINDS:
        raise HTTPException(status_code=422, detail=f"Unknown kind: {kind}")


@router.get("")
async def list_resume():
    """Every stored position, so the client can hold them without per-item calls."""
    _require_auth()
    return await _run_sync(store.all_resume)


@router.get("/{kind}/{ref}")
async def get_resume(kind: str, ref: str):
    _require_auth()
    _check_kind(kind)
    return {"kind": kind, "ref": ref, "position": await _run_sync(store.load_resume, kind, ref)}


@router.put("")
async def put_resume(body: ResumeIn):
    """Record a position. Near either end it is cleared instead of stored."""
    _require_auth()
    _check_kind(body.kind)
    await _run_sync(store.save_resume, body.kind, body.ref, body.position, body.duration)
    return {"ok": True}


@router.post("/import")
async def import_resume(body: ImportIn):
    """One-shot adoption of the positions a client already had locally.

    Entries already stored win, so replaying the same payload changes nothing.
    """
    _require_auth()
    imported = await _run_sync(store.import_resume, body.entries)
    return {"imported": imported}
