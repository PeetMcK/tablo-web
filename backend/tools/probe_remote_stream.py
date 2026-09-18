#!/usr/bin/env python3
"""Is there a second, lower-bitrate way to get the picture off a Tablo?

The device's own stream is 1080i `mpeg2video` at ~10 Mbps, which is why the app
transcodes. Two places a cheaper stream could come from:

  * The cloud. If Lighthouse can hand a client a playlist, something upstream
    is re-encoding, and that is the stream to ask for.
  * The device capability flags nobody has matched to an endpoint - `cp`, `lc`,
    `rf`, `netstatus`, `reclive`, `snap_grid`, `params`. Status-code archaeology
    tells them apart: 404 absent, 401 present and mis-signed, 405 present and
    wants another verb.

Read-only. No tuner is taken: nothing here opens a `watch`.

Not yet run to completion: the device's API port stopped answering partway
through the first attempt, after the `fmt` sweep in `probe_stream_fmt.py` had
hammered it. Nothing below has results to report.

    cd backend
    TABLO_DB_PATH="$HOME/Library/Application Support/tablo-web/tablo.db" \\
        .venv/bin/python tools/probe_remote_stream.py
"""

from __future__ import annotations

import asyncio
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.state import state  # noqa: E402

DEVICE_PATHS = [
    "/server/netstatus",
    "/netstatus",
    "/server/params",
    "/params",
    "/server/cp",
    "/server/lc",
    "/server/rf",
    "/server/reclive",
    "/server/snap_grid",
    "/guide/snap_grid",
    "/server/remote",
    "/server/remote/info",
    "/settings/remote",
    "/server/streams",
    "/stream/info",
    "/stream",
]

# Cloud paths, both with and without the per-device context token.
CLOUD_SUFFIXES = [
    "guide/channels/{channel}/watch/",
    "guide/channels/{channel}/stream/",
    "guide/channels/{channel}/play/",
    "guide/channels/{channel}/live/watch/",
    "watch/",
    "stream/",
    "player/",
    "sessions/",
    "remote/",
    "relay/",
]


async def signed(method: str, path: str) -> tuple[int, str]:
    from tablo_api import TabloAuth

    auth_header, date_header = TabloAuth.make_device_auth(method, path, "")
    url = state.active_device.local_url.rstrip("/") + path
    async with httpx.AsyncClient(timeout=20) as http:
        resp = await http.request(
            method,
            url,
            headers={
                "Authorization": auth_header,
                "Date": date_header,
                "User-Agent": "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)",
            },
        )
    return resp.status_code, resp.text[:300].replace("\n", " ")


async def main() -> int:
    state.load_config()
    if state.active_device is None:
        print("no active device - log in through the app first")
        return 1

    print("== device paths ==")
    for path in DEVICE_PATHS:
        try:
            status, text = await signed("GET", path)
        except Exception as e:
            print(f"---  GET {path}  {e}")
            continue
        print(f"{status}  GET {path}\n      {text}")

    print("\n== subscription (remote streaming is a paid feature) ==")
    for path in ("/server/subscription", "/account/subscription"):
        status, text = await signed("GET", path)
        print(f"{status}  GET {path}\n      {text}")

    host, headers = state._cloud_headers()
    token = state.active_device.lighthouse_token
    channels = (
        await httpx.AsyncClient(timeout=20).get(
            f"{host}/api/v2/account/{token}/guide/channels/", headers=headers
        )
    ).json()
    results = channels.get("results") or channels
    channel = (results[0] if isinstance(results, list) else results)["identifier"]
    print(f"\n== cloud, channel {channel} ==")

    async with httpx.AsyncClient(timeout=20) as http:
        for suffix in CLOUD_SUFFIXES:
            for base in (
                f"{host}/api/v2/account/{token}/",
                f"{host}/api/v2/account/",
                f"{host}/api/v2/",
            ):
                url = base + suffix.format(channel=channel)
                try:
                    resp = await http.get(url, headers=headers)
                except Exception as e:
                    print(f"---  GET {url}  {e}")
                    continue
                body = resp.text[:200].replace("\n", " ")
                print(f"{resp.status_code}  GET {url}\n      {body}")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
