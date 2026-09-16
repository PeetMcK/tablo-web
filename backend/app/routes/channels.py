import platform
import sys
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import store
from ..log_buffer import recent_logs
from ..state import _run_sync, state

router = APIRouter(prefix="/api/channels", tags=["channels"])


class ChannelOut(BaseModel):
    identifier: str
    call_sign: str
    major: int
    minor: int
    network: str
    kind: str
    display_name: str


@router.get("/debug-report")
async def debug_report():
    """Collect server-side diagnostics for bug reports (no PII)."""
    dev = state.active_device
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "server": {
            "python": sys.version,
            "platform": platform.platform(),
            "arch": platform.machine(),
        },
        "auth": {
            "authenticated": state.is_authenticated,
            "device_count": len(state.devices),
            "active_device_name": dev.name if dev else None,
            "active_device_sid": dev.sid if dev else None,
        },
        "active_streams": len(state.streams),
        "recent_logs": list(recent_logs),
    }


@router.get("/local-guide")
async def local_guide():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await state.request_device("GET", "/guide/channels")


@router.get("/server-info")
async def server_info():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await state.request_device("GET", "/server/info")


@router.get("/detail")
async def channel_detail(path: str = Query(...)):
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not path.startswith("/") or "://" in path:
        raise HTTPException(status_code=400, detail="Invalid path")
    return await state.request_device("GET", path)


@router.get("/airings")
async def list_airings():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await state.request_device("GET", "/guide/airings")


@router.get("/guide/stream")
async def stream_guide():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return StreamingResponse(
        state.stream_guide_data(),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.get("/guide")
async def get_guide():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return await state.get_guide_data()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Guide error: {e}")


@router.get("/guide-grid/stream")
async def stream_guide_grid():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return StreamingResponse(
        state.stream_grid_guide_data(),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.get("/guide-grid")
async def get_guide_grid():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return await state.get_grid_guide()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Guide grid error: {e}")


@router.post("/refresh")
async def refresh_channels():
    """Re-read the account's channel list and rebuild the guide from it.

    POST rather than GET: it drops caches and writes a new guide sync, so it is
    not safe to repeat blindly or to prefetch.
    """
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return await state.refresh_channel_list()
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Channel refresh error: {e}")


@router.get("/library")
async def get_library():
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        return await state.get_recordings()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Library error: {e}")


@router.get("/{identifier}/airings")
async def channel_airings(identifier: str):
    """What is on this channel now and next.

    Read from the guide mirror, never from the device: the live player calls
    this while opening a stream, and a device round trip would put a tuner
    handshake behind a guide fetch. A channel the mirror has never seen comes
    back empty, and the player keeps the airing it was opened with.
    """
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"airings": await _run_sync(store.channel_airings, identifier)}


@router.get("", response_model=list[ChannelOut])
async def list_channels(refresh: bool = Query(False), include_ott: bool = Query(True)):
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        channels = await state.channels(refresh=refresh, include_ott=include_ott)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Tablo error: {e}")

    return [
        ChannelOut(
            identifier=c.identifier,
            call_sign=c.call_sign,
            major=c.major,
            minor=c.minor,
            network=c.network,
            kind=c.kind,
            display_name=c.display_name,
        )
        for c in channels
    ]
