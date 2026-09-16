"""Recording management writes.

Addressed by `(channel, start)` - `guide_airing`'s primary key, which the show
sheet already holds. The device paths are resolved here and never leave the
backend: a device path in a browser is a PATCH target in a browser.

The device's write surface is `PATCH` only and its validator is strict, which is
what makes it safe to build against - a wrong value returns 400 rather than
doing something unintended. See docs/tablo-api.md.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import store
from ..state import AppState, _run_sync, state

router = APIRouter(prefix="/api/schedule", tags=["schedule"])


class AiringIn(BaseModel):
    channel: str
    start: str
    scheduled: bool


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


async def _handles(channel: str, start: str) -> dict:
    handles = await _run_sync(store.airing_handles, channel, start)
    if handles is None:
        raise HTTPException(status_code=404, detail="Airing not found")
    return handles


def _device_error(status: int, data: dict) -> HTTPException:
    """The device's own words for a refusal, or a fixed message for the rest.

    A 400 carries `error.description` and `error.details`, which is the only
    thing that can tell someone why the write was refused. Anything else is a
    transport problem and is not the person's business.
    """
    if status == 400:
        description = ((data or {}).get("error") or {}).get("description")
        return HTTPException(status_code=400,
                             detail=description or "The Tablo refused the change.")
    return HTTPException(status_code=502, detail="The Tablo could not be reached.")


@router.put("/airing")
async def schedule_airing(body: AiringIn):
    """Record, or stop recording, one episode.

    The write parameter is `scheduled`, a boolean at the top level - not the
    `schedule.state` the GET exposes, which is rejected. Read shape and write
    shape are not the same here.
    """
    _require_auth()
    handles = await _handles(body.channel, body.start)
    if not handles["airing_path"]:
        raise HTTPException(
            status_code=409,
            detail="This channel's schedule comes from the cloud, "
                   "which carries nothing to record.",
        )

    try:
        status, data = await state.patch_device(
            handles["airing_path"], {"scheduled": body.scheduled}
        )
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    if status != 200:
        raise _device_error(status, data)

    # The response is the full updated record, so the write doubles as a read.
    await _run_sync(store.update_airing_schedule, body.channel, body.start,
                    AppState._airing_row(data))
    return await _run_sync(store.airing_detail, body.channel, body.start)
