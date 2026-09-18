#!/usr/bin/env python3
"""What does the `fmt=` parameter on the Tablo's media playlist select?

`POST /guide/channels/{id}/watch` hands back a master playlist on port 80 whose
single variant points at `/stream/pls.m3u8?<token>&fmt=v4`. Nothing else names
that parameter, and a format selector on the device's own stream server is the
only place an on-device transcoder could be hiding: the app's whole CPU cost is
re-encoding the `mpeg2` the tuner delivers.

For every candidate value: fetch the media playlist, then fetch its first
segment and ask ffprobe what the codec actually is. A different codec in a
segment is the only proof that matters - an accepted parameter that changes
nothing is the expected outcome, not evidence.

Costs one tuner. Run when nobody is watching.

    cd backend
    TABLO_DB_PATH="$HOME/Library/Application Support/tablo-web/tablo.db" \\
        .venv/bin/python tools/probe_stream_fmt.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import urllib.parse

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.state import state  # noqa: E402

CANDIDATES = [
    "v4",  # what the device itself asks for - the control
    "v1",
    "v2",
    "v3",
    "v5",
    "v6",
    "v0",
    "1",
    "2",
    "4",
    "h264",
    "avc",
    "mpeg2",
    "hls",
    "ts",
    "mp4",
    "fmp4",
    "low",
    "sd",
    "hd",
    "ZZZ",
    "",  # omitted entirely
]

_STREAM_INF = re.compile(r"#EXT-X-STREAM-INF:(.*)")


def _first_segment(playlist: str, base: str) -> str | None:
    for line in playlist.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return urllib.parse.urljoin(base, line)
    return None


def _probe_codecs(data: bytes) -> str:
    """ffprobe on a segment's bytes. The codec is the answer; the rest is noise."""
    proc = subprocess.run(
        [
            "ffprobe", "-hide_banner", "-v", "error",
            "-show_entries", "stream=codec_name,codec_type,width,height,field_order",
            "-of", "json", "-",
        ],
        input=data,
        capture_output=True,
    )
    try:
        streams = json.loads(proc.stdout)["streams"]
    except Exception:
        return f"ffprobe failed: {proc.stderr.decode()[:120]}"
    return " | ".join(
        f"{s.get('codec_type')}={s.get('codec_name')}"
        + (f" {s.get('width')}x{s.get('height')}" if s.get("width") else "")
        + (f" {s.get('field_order')}" if s.get("field_order") else "")
        for s in streams
    )


async def main() -> int:
    state.load_config()
    if state.active_device is None:
        print("no active device - log in through the app first")
        return 1

    channels = await state.request_device("GET", "/guide/channels")
    channel_id = channels[0].rstrip("/").rsplit("/", 1)[-1]
    watch = await state.request_device("POST", f"/guide/channels/{channel_id}/watch")
    master_url = watch["playlist_url"]
    token = watch["token"]
    print(f"channel {channel_id}  video_details={json.dumps(watch.get('video_details'))}")
    print(f"master {master_url}")

    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as http:
        master = (await http.get(master_url)).text
        print(master)

        variant = _first_segment(master, master_url)
        if variant is None:
            print("no variant line in the master playlist")
            return 1
        parsed = urllib.parse.urlparse(variant)
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        stream_token = [(k, v) for k, v in query if k != "fmt"]
        print(f"variant {variant}\n")

        for fmt in CANDIDATES:
            params = list(stream_token)
            if fmt:
                params.append(("fmt", fmt))
            url = urllib.parse.urlunparse(
                parsed._replace(query=urllib.parse.urlencode(params, safe="-_"))
            )
            label = f"fmt={fmt!r}" if fmt else "fmt omitted"
            try:
                resp = await http.get(url)
            except Exception as e:
                print(f"{label:16}  request failed: {e}")
                continue
            body = resp.text
            if resp.status_code != 200:
                print(f"{label:16}  {resp.status_code}  {body[:120]!r}")
                continue

            seg_url = _first_segment(body, url)
            segments = len([1 for line in body.splitlines()
                            if line.strip() and not line.startswith("#")])
            codecs = "no segment"
            if seg_url:
                try:
                    seg = await http.get(seg_url)
                    codecs = (
                        _probe_codecs(seg.content)
                        if seg.status_code == 200
                        else f"segment {seg.status_code}"
                    )
                except Exception as e:
                    codecs = f"segment failed: {e}"
            print(f"{label:16}  200  segments={segments:3d}  {codecs}")

    status = await state.request_device("DELETE", f"/player/sessions/{token}")
    print(f"\nreleased {token} -> {status!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
