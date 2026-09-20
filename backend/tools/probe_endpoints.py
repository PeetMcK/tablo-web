#!/usr/bin/env python3
"""Map the device's unmapped surface: chase the capability flags with no
known endpoint, and enumerate the obvious neighbours of paths that do exist.

Status-code archaeology (docs/tablo-api.md): on port 8887 a 404 means the path
is absent, 401 means it exists and the signature was wrong, 405 means it exists
and wants another verb. Every candidate is a signed GET, so anything but 404 is
a lead.

Read-only, no `watch`, no tuner. Paced with a delay between requests: an
earlier unpaced sweep wedged the API. Keep the delay.

    cd backend
    TABLO_DB_PATH="$HOME/Library/Application Support/tablo-web/tablo.db" \
        .venv/bin/python tools/probe_endpoints.py
"""

from __future__ import annotations

import asyncio
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.state import state

DELAY = 0.4  # seconds between requests; do not lower

# Capability flags with no endpoint found, and every spelling worth trying.
CANDIDATES = [
    # snap_grid - a device-side guide grid would be the biggest find
    "/guide/grid", "/guide/snap_grid", "/guide/snapgrid", "/snap_grid",
    "/guide/snap", "/guide/grid/today", "/server/guide/grid",
    # conflicts
    "/guide/conflicts", "/recordings/conflicts", "/conflicts",
    "/server/conflicts", "/scheduled/conflicts",
    # airings_by_day
    "/guide/airings_by_day", "/guide/days", "/guide/airings/days",
    "/guide/schedule", "/guide/upcoming",
    # search (device side)
    "/guide/search", "/search", "/recordings/search",
    # params / netstatus / reclive / cp / lc / rf
    "/server/params", "/params", "/server/netstatus", "/netstatus",
    "/server/reclive", "/reclive", "/server/cp", "/server/lc", "/server/rf",
    # scheduling surface
    "/scheduled", "/scheduled/airings", "/guide/scheduled", "/recordings/scheduled",
    "/guide/series/scheduled", "/manual", "/manual_programs", "/guide/manual",
    # recordings neighbours
    "/recordings", "/recordings/info", "/recordings/summary",
    "/recordings/programs", "/recordings/shows", "/recordings/failed",
    "/recordings/protected", "/recordings/watched", "/recordings/keep",
    # server neighbours
    "/server", "/server/status", "/server/settings", "/server/features",
    "/server/apps", "/server/name", "/server/time", "/server/logs",
    "/server/diag", "/server/diagnostics", "/server/health", "/server/stats",
    "/server/storage", "/server/recordings", "/server/guide",
    "/server/version", "/server/model", "/server/network",
    # settings neighbours
    "/settings", "/settings/audio", "/settings/recording", "/settings/network",
    "/settings/led", "/settings/system",
    # batch / bulk (present on old gen)
    "/batch", "/bulk", "/guide/batch",
    # channels / scan
    "/channels", "/channels/scan", "/channels/lineup", "/guide/lineup",
    # image / thumb neighbours
    "/images", "/thumbnails", "/snapshots",
    # account / capabilities neighbours
    "/capabilities", "/info", "/status", "/health", "/version", "/ping",
]


async def signed(method: str, path: str) -> tuple[int, str]:
    from tablo_api import TabloAuth

    a, d = TabloAuth.make_device_auth(method, path, "")
    url = state.active_device.local_url.rstrip("/") + path
    async with httpx.AsyncClient(timeout=12) as http:
        r = await http.request(
            method, url,
            headers={"Authorization": a, "Date": d,
                     "User-Agent": "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)"},
        )
    return r.status_code, r.text[:200].replace("\n", " ")


async def main() -> int:
    state.load_config()
    if state.active_device is None:
        print("no active device - log in through the app first")
        return 1

    hits = []
    for path in CANDIDATES:
        try:
            status, body = await signed("GET", path)
        except Exception as e:
            print(f"ERR  {path}  {type(e).__name__}")
            await asyncio.sleep(DELAY)
            continue
        # 404 is the boring answer; anything else is a lead.
        mark = "" if status == 404 else "  <-- LEAD"
        print(f"{status}  GET {path}{mark}")
        if status != 404:
            hits.append((status, path, body))
        await asyncio.sleep(DELAY)

    print("\n== leads ==")
    for status, path, body in hits:
        print(f"{status}  {path}\n      {body}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
