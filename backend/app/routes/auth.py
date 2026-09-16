import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..state import state

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


class DeviceOut(BaseModel):
    sid: str
    name: str
    local_url: str


class LoginResponse(BaseModel):
    devices: list[DeviceOut]
    active_sid: str | None


@router.get("/status")
async def status():
    return {
        "authenticated": state.is_authenticated,
        "email": state.email,
        "devices": [{"sid": d.sid, "name": d.name} for d in state.devices],
        "active_sid": state.active_device.sid if state.active_device else None,
        # Where the browser can reach this backend without going through the
        # proxy. In native mode nginx runs inside the Docker VM while the
        # backend runs on the host, so a proxied download crosses the virtual
        # network twice and tops out around 100 MB/s against 583 MB/s direct.
        # Empty when there is no such route, and callers fall back to /api.
        "direct_origin": os.environ.get("PUBLIC_BACKEND_ORIGIN", "") or None,
    }


@router.post("/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    try:
        devices = await state.login(req.email, req.password)
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))
    return LoginResponse(
        devices=[DeviceOut(sid=d.sid, name=d.name, local_url=d.local_url) for d in devices],
        active_sid=state.active_device.sid if state.active_device else None,
    )


@router.post("/device/{sid}")
async def select_device(sid: str):
    try:
        dev = await state.select_device(sid)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"sid": dev.sid, "name": dev.name}


@router.delete("/logout")
async def logout():
    state.clear_config()
    return {"ok": True}
