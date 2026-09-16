"""Follows a device playlist and keeps a ring of its segments on disk.

One follower per session. The device is fetched once per segment no matter how
many viewers or requests there are, which is an improvement on the pass-through
proxy: that one re-fetches the device for every segment request the browser
makes.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urljoin

from .live_ring import SegmentRing

Fetch = Callable[[str], Awaitable[bytes]]
Clock = Callable[[], datetime]

_MEDIA_SEQUENCE = re.compile(r"#EXT-X-MEDIA-SEQUENCE:(\d+)")
_EXTINF = re.compile(r"#EXTINF:([0-9.]+)")


def parse_device_playlist(text: str) -> tuple[int, list[tuple[str, float]]]:
    """Return ``(media_sequence, [(uri, duration)])`` from a media playlist."""
    match = _MEDIA_SEQUENCE.search(text)
    sequence = int(match.group(1)) if match else 0

    segments: list[tuple[str, float]] = []
    duration: float | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if extinf := _EXTINF.match(line):
            duration = float(extinf.group(1))
        elif line.startswith("#"):
            # Tags may sit between the EXTINF and its URI - a discontinuity,
            # for instance. They must not clear the pending duration.
            continue
        elif duration is not None:
            segments.append((line, duration))
            duration = None
    return sequence, segments


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RingFollower:
    def __init__(
        self,
        ring: SegmentRing,
        directory: Path,
        playlist_url: str,
        fetch: Fetch,
        max_seconds: float,
        now: Clock = _utcnow,
        interval: float = 2.0,
    ) -> None:
        self.ring = ring
        self.directory = Path(directory)
        self.playlist_url = playlist_url
        self.fetch = fetch
        self.max_seconds = max_seconds
        self.now = now
        self.interval = interval
        self.directory.mkdir(parents=True, exist_ok=True)
        # The device's own sequence number of the newest segment taken. Kept
        # rather than a set of names because the device's window slides: a
        # sequence number is the only stable identity across polls.
        self._taken_through: int | None = None

    async def poll_once(self) -> int:
        """Fetch what is new since the last poll. Returns how many arrived."""
        body = await self.fetch(self.playlist_url)
        device_sequence, segments = parse_device_playlist(
            body.decode("utf-8", errors="ignore")
        )

        written = 0
        for offset, (uri, duration) in enumerate(segments):
            sequence = device_sequence + offset
            if self._taken_through is not None and sequence <= self._taken_through:
                continue

            try:
                payload = await self.fetch(urljoin(self.playlist_url, uri))
            except Exception:
                # Leave _taken_through where it is so the next poll retries this
                # segment. Skipping past it would leave a hole in the ring that
                # nothing ever fills.
                break

            name = self.ring.next_name()
            (self.directory / name).write_bytes(payload)
            self.ring.append(duration, self.now())
            self._taken_through = sequence
            written += 1

        for evicted in self.ring.trim(self.max_seconds):
            (self.directory / evicted.name).unlink(missing_ok=True)
        return written

    async def run(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A transient device failure must not end the session; the next
                # poll is two seconds away.
                pass
            await asyncio.sleep(self.interval)
