#!/usr/bin/env python3
"""Does the 4th-gen Tablo transcode anything itself?

The app spends most of its CPU re-encoding MPEG-2 to H.264 because we assume
the device hands us whatever the tuner received, untouched. Earlier Tablo
generations carried a hardware encoder and exposed quality profiles, so the
question is whether this generation kept any of that behind an endpoint or a
`watch` parameter we never send.

Three techniques, all from docs/tablo-api.md's "How to extend this safely":

  * Status-code archaeology on reads: 404 means the path is absent, 401 means
    it exists and the signature was wrong, 405 means it exists and wants
    another verb.
  * A deliberately invalid parameter value. A rejected request cannot change
    anything, and the 400 names the field it objected to.
  * A control key nobody could support (`zzz_probe`). If that is accepted, the
    endpoint ignores unknown keys and no parameter can be discovered this way.

Costs one tuner for the duration of the live section, and releases it. Run when
nobody is watching.

    cd backend
    TABLO_DB_PATH="$HOME/Library/Application Support/tablo-web/tablo.db" \\
        .venv/bin/python tools/probe_transcode.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.state import state  # noqa: E402

# Paths a transcoder would plausibly live behind, by analogy with the endpoints
# the device does expose (`/server/*` for hardware, `/settings/*` for user
# choices) and with what the older generation called things.
READ_CANDIDATES = [
    "/server/capabilities",
    "/settings/info",
    "/server/transcode",
    "/server/transcoder",
    "/server/transcode/info",
    "/server/encoder",
    "/server/encoders",
    "/server/video",
    "/server/streaming",
    "/server/streaming/info",
    "/server/profiles",
    "/server/quality",
    "/server/players",
    "/server/sessions",
    "/transcode",
    "/transcode/info",
    "/transcoder",
    "/streaming/info",
    "/settings/transcode",
    "/settings/streaming",
    "/settings/quality",
    "/settings/playback",
    "/settings/video",
    "/player/info",
    "/player/sessions",
    "/player/profiles",
]

# Body keys to try on `watch`. `zzz_probe` is the control: if it is accepted the
# endpoint ignores unknown keys and the rest prove nothing.
WATCH_KEYS = [
    "zzz_probe",
    "quality",
    "profile",
    "transcode",
    "bitrate",
    "resolution",
    "codec",
    "video_codec",
    "format",
    "max_bitrate",
    "audio_track",
]

_STREAM_INF = re.compile(r"#EXT-X-STREAM-INF:(.*)")


async def signed(
    method: str, path: str, body: str = "", query: str = ""
) -> tuple[int, str]:
    """A signed device request that returns the status instead of raising.

    The signature covers the bare path with the query string excluded, so
    `query` is appended to the URL only. See docs/tablo-api.md.
    """
    from tablo_api import TabloAuth

    auth_header, date_header = TabloAuth.make_device_auth(method, path, body)
    url = state.active_device.local_url.rstrip("/") + path + query
    async with httpx.AsyncClient(timeout=20) as http:
        resp = await http.request(
            method,
            url,
            content=body.encode() if body else None,
            headers={
                "Authorization": auth_header,
                "Date": date_header,
                "Content-Type": "application/json",
                "User-Agent": "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)",
            },
        )
    return resp.status_code, resp.text


def summarize(text: str, limit: int = 400) -> str:
    return text[:limit].replace("\n", " ")


async def read_sweep() -> None:
    print("\n== reads ==")
    for path in READ_CANDIDATES:
        status, text = await signed("GET", path)
        note = summarize(text, 300) if status < 400 else summarize(text, 120)
        print(f"{status}  GET {path}\n      {note}")


async def watch_params(channel_id: str) -> str | None:
    """POST watch with one probe key at a time. Returns a session token."""
    path = f"/guide/channels/{channel_id}/watch"
    print(f"\n== watch parameters on {path} ==")

    status, text = await signed("POST", path)
    print(f"{status}  empty body\n      {summarize(text, 600)}")
    token = None
    if status < 400:
        try:
            token = json.loads(text).get("token")
        except ValueError:
            pass

    for key in WATCH_KEYS:
        body = json.dumps({key: "ZZZ"}, separators=(",", ":"))
        status, text = await signed("POST", path, body)
        print(f"{status}  {body}\n      {summarize(text, 200)}")

    # Query-string form too: the signature excludes it, so the device may take
    # parameters there instead of in a body.
    for key in ("quality", "profile", "transcode", "bitrate"):
        status, text = await signed("POST", path, query=f"?{key}=ZZZ")
        print(f"{status}  ?{key}=ZZZ\n      {summarize(text, 200)}")

    return token


async def inspect_playlist(playlist_url: str) -> None:
    print(f"\n== playlist {playlist_url} ==")
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as http:
        resp = await http.get(playlist_url)
        body = resp.text
    print(f"{resp.status_code}  {len(body)} bytes")
    print(body[:1200])
    variants = _STREAM_INF.findall(body)
    print(f"variants: {len(variants)}")
    for v in variants:
        print(f"  {v}")


async def session_state(token: str) -> None:
    print(f"\n== session {token} ==")
    for path in (
        f"/player/sessions/{token}",
        f"/player/sessions/{token}/info",
        f"/player/sessions/{token}/profiles",
    ):
        status, text = await signed("GET", path)
        print(f"{status}  GET {path}\n      {summarize(text, 600)}")


async def main() -> int:
    state.load_config()
    if state.active_device is None:
        print("no active device - log in through the app first")
        return 1

    print(f"device {state.active_device.local_url}")
    await read_sweep()

    channels = await state.request_device("GET", "/guide/channels")
    channel_id = channels[0].rstrip("/").rsplit("/", 1)[-1]

    token = await watch_params(channel_id)
    if token:
        status, text = await signed("POST", f"/guide/channels/{channel_id}/watch")
        try:
            playlist_url = json.loads(text).get("playlist_url")
        except ValueError:
            playlist_url = None
        if playlist_url:
            await inspect_playlist(playlist_url)
        await session_state(token)
        status, text = await signed("DELETE", f"/player/sessions/{token}")
        print(f"\nreleased session -> {status} {summarize(text, 120)}")
    else:
        print("\nno session token - live section skipped")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
