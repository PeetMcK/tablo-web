"""Recording management writes.

Addressed by `(channel, start)` - `guide_airing`'s primary key, which the show
sheet already holds. The device paths are resolved here and never leave the
backend: a device path in a browser is a PATCH target in a browser.

The device's write surface is `PATCH` only and its validator is strict, which is
what makes it safe to build against - a wrong value returns 400 rather than
doing something unintended. See docs/tablo-api.md.
"""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from .. import store
from ..state import SERIES_SYNC_CONCURRENCY, AppState, _run_sync, state

router = APIRouter(prefix="/api/schedule", tags=["schedule"])

# The device's validator rejects anything else with a 400, but refusing here
# keeps a typo off the wire. Confirmed by tools/probe_schedule_rules.py.
RULES = ("all", "new", "none")


class AiringIn(BaseModel):
    channel: str
    start: str
    scheduled: bool


class SeriesIn(BaseModel):
    channel: str
    start: str
    rule: str


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


@router.get("/live")
async def live_state(channel: str = Query(...), start: str = Query(...)):
    """What the device says about this airing right now.

    The mirror is a sync behind, and a sync is six hours apart at best and can
    fail outright - measured 2026-09-21, after a failed sync the mirror said a
    series recorded "new" where the device said "all", and called an episode
    scheduled that had been turned off in the Tablo app an hour earlier. The
    sheet asks this on open rather than rendering the older answer.

    Two device reads at most: the airing for its schedule block, and the series
    for its rule. Both are written back, so every other view converges without
    waiting for the next sync.
    """
    _require_auth()
    handles = await _handles(channel, start)
    if not handles["airing_path"]:
        raise HTTPException(
            status_code=409,
            detail="This channel's schedule comes from the cloud, "
                   "which carries no recording state.",
        )

    try:
        airing = await state.request_device("GET", handles["airing_path"])
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None

    row = AppState._airing_row(airing)
    await _run_sync(store.update_airing_schedule, channel, start, row)

    # The rule, which lives on the series rather than the airing. A failure
    # here is not fatal: the airing's own state is the more urgent of the two,
    # and the mirror's rule is at worst a sync old.
    rule = None
    if handles["series_path"]:
        try:
            series = await state.request_device("GET", handles["series_path"])
            rule = (series or {}).get("schedule_rule")
            await _run_sync(store.save_series, [AppState._series_row(series)])
        except Exception:
            rule = None

    return {
        "schedule_state": row.get("schedule_state"),
        "skip_reason": row.get("skip_reason"),
        "scheduled": store._is_scheduled(row.get("schedule_state")),
        "series_rule": rule,
    }


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


@router.put("/series")
async def schedule_series(body: SeriesIn):
    """Set the series rule: record all episodes, new ones only, or none.

    Nested, not flat: `{"schedule": {"rule": ...}}`. The GET also exposes a
    top-level `schedule_rule`, but writing that key fails with "Must specify at
    least one valid parameter".
    """
    _require_auth()
    if body.rule not in RULES:
        raise HTTPException(status_code=422, detail=f"Unknown rule: {body.rule}")

    handles = await _handles(body.channel, body.start)
    if not handles["series_path"]:
        raise HTTPException(status_code=409,
                            detail="This airing has no series to set a rule on.")

    try:
        status, data = await state.patch_device(
            handles["series_path"], {"schedule": {"rule": body.rule}}
        )
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    if status != 200:
        raise _device_error(status, data)

    await _run_sync(store.save_series, [AppState._series_row(data)])
    # After the response, not before it: one rule change flips the state of
    # every future episode, and re-reading them is tens of device requests.
    asyncio.get_running_loop().create_task(
        refresh_series_airings(handles["series_path"])
    )
    return await _run_sync(store.airing_detail, body.channel, body.start)


async def refresh_series_airings(series_path: str) -> int:
    """Re-read this series' future airings so sibling cells stop lying.

    Bounded by the mirror's own list and run at the background sync's
    concurrency - the Tablo is shared with playback and saturates around 10x
    realtime, so a rule change must not turn into a burst.

    Never raises and its result is never surfaced. The write already succeeded
    on the device; a stumbling refresh is a staleness problem, which the next
    sync fixes, not a failed write.
    """
    try:
        rows = await _run_sync(store.series_future_airings, series_path)
    except Exception as e:
        print(f"[schedule] could not list {series_path}: {e}", flush=True)
        return 0

    sem = asyncio.Semaphore(SERIES_SYNC_CONCURRENCY)

    async def one(row) -> int:
        async with sem:
            try:
                data = await state.request_device("GET", row["airing_path"])
                await _run_sync(store.update_airing_schedule, row["channel"],
                                row["start"], AppState._airing_row(data))
                return 1
            except Exception:
                return 0

    return sum(await asyncio.gather(*[one(r) for r in rows]))
