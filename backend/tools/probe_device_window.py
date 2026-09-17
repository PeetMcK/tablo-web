"""How deep is the Tablo's own live playlist? Sizes the raw segment ring.

Run only when nobody is watching: this competes with the device for bandwidth
and holds a tuner while the session is open.

    python tools/probe_device_window.py <playlist-url>

The playlist URL is the `proxy_url` from `POST /api/stream/{identifier}`.
"""

from __future__ import annotations

import asyncio
import re
import sys

import httpx

_MEDIA_SEQUENCE = re.compile(r"#EXT-X-MEDIA-SEQUENCE:(\d+)")
_EXTINF = re.compile(r"#EXTINF:([0-9.]+)")


async def probe(playlist_url: str, samples: int = 3, gap: float = 10.0) -> None:
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as http:
        for attempt in range(samples):
            body = (await http.get(playlist_url)).text
            durations = [float(d) for d in _EXTINF.findall(body)]
            sequence = _MEDIA_SEQUENCE.search(body)
            print(
                f"segments={len(durations):3d} "
                f"depth={sum(durations):7.1f}s "
                f"target={max(durations, default=0):5.1f}s "
                f"media_sequence={sequence.group(1) if sequence else 'absent'} "
                f"endlist={'#EXT-X-ENDLIST' in body}"
            )
            if attempt + 1 < samples:
                # Two readings a gap apart say whether the window slides or grows.
                await asyncio.sleep(gap)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    asyncio.run(probe(sys.argv[1]))
