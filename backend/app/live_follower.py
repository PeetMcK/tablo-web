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
from typing import Awaitable, Callable, NamedTuple
from urllib.parse import urljoin

from .live_ring import SegmentRing

ByteRange = tuple[int, int]
Fetch = Callable[..., Awaitable[bytes]]
Clock = Callable[[], datetime]


class DeviceSegment(NamedTuple):
    uri: str
    duration: float
    #: Inclusive ``(start, end)`` for a byte-range segment, else None.
    byte_range: ByteRange | None

_MEDIA_SEQUENCE = re.compile(r"#EXT-X-MEDIA-SEQUENCE:(\d+)")
_EXTINF = re.compile(r"#EXTINF:([0-9.]+)")
_BYTERANGE = re.compile(r"#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?")
_STREAM_INF = "#EXT-X-STREAM-INF:"


def variant_of(text: str) -> str | None:
    """The media playlist a master playlist points at, if this is one.

    The device serves a master naming a single variant, which FFmpeg and hls.js
    both follow on their own — so nothing before this needed to know. A
    follower that reads only EXTINF finds no segments in it and waits for ever.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for index, line in enumerate(lines):
        if not line.startswith(_STREAM_INF):
            continue
        for candidate in lines[index + 1:]:
            if not candidate.startswith("#"):
                return candidate
        return None
    return None


def parse_device_playlist(text: str) -> tuple[int, list[DeviceSegment]]:
    """Return ``(media_sequence, segments)`` from a media playlist.

    This device packs its stream as one file addressed by byte range: every
    EXTINF names the same uri and differs only in ``#EXT-X-BYTERANGE``. Keyed
    on the uri alone it looks like a single segment repeated for ever, which is
    exactly what the first live run produced - a ring that never filled.
    """
    match = _MEDIA_SEQUENCE.search(text)
    sequence = int(match.group(1)) if match else 0

    segments: list[DeviceSegment] = []
    duration: float | None = None
    byte_range: ByteRange | None = None
    # An EXT-X-BYTERANGE with no offset continues from the last one.
    next_offset = 0

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if extinf := _EXTINF.match(line):
            duration = float(extinf.group(1))
        elif byterange := _BYTERANGE.match(line):
            length = int(byterange.group(1))
            start = int(byterange.group(2)) if byterange.group(2) else next_offset
            byte_range = (start, start + length - 1)
            next_offset = start + length
        elif line.startswith("#"):
            # Other tags may sit between the EXTINF and its uri - a
            # discontinuity, a date. They must not clear what is pending.
            continue
        elif duration is not None:
            segments.append(DeviceSegment(line, duration, byte_range))
            duration = None
            byte_range = None
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
        verbose: bool = False,
    ) -> None:
        self.ring = ring
        self.directory = Path(directory)
        self.playlist_url = playlist_url
        self.fetch = fetch
        self.max_seconds = max_seconds
        self.now = now
        self.interval = interval
        self.verbose = verbose
        self.directory.mkdir(parents=True, exist_ok=True)
        # The device's own sequence number of the newest segment taken. Kept
        # rather than a set of names because the device's window slides: a
        # sequence number is the only stable identity across polls.
        self._taken_through: int | None = None
        # Resolved once from the master playlist, then polled directly.
        self._media_url: str | None = None

    async def _media_playlist(self) -> tuple[str, str]:
        """The media playlist's text and the url it came from."""
        url = self._media_url or self.playlist_url
        text = (await self.fetch(url)).decode("utf-8", errors="ignore")

        if self._media_url is None:
            if variant := variant_of(text):
                self._media_url = urljoin(self.playlist_url, variant)
                url = self._media_url
                text = (await self.fetch(url)).decode("utf-8", errors="ignore")
            else:
                # Not a master: this url is the media playlist, so poll it.
                self._media_url = url
        return text, url

    async def poll_once(self) -> int:
        """Fetch what is new since the last poll. Returns how many arrived."""
        text, media_url = await self._media_playlist()
        device_sequence, segments = parse_device_playlist(text)

        written = 0
        for offset, segment in enumerate(segments):
            sequence = device_sequence + offset
            if self._taken_through is not None and sequence <= self._taken_through:
                continue

            try:
                # Relative to the media playlist, which on this device lives a
                # directory below the master. A byte-range segment is fetched
                # as its own file, so what the ring publishes is an ordinary
                # segment and the browser never learns how the device packs it.
                payload = await self.fetch(
                    urljoin(media_url, segment.uri), segment.byte_range,
                )
            except Exception as exc:
                # Leave _taken_through where it is so the next poll retries this
                # segment. Skipping past it would leave a hole in the ring that
                # nothing ever fills.
                if self.verbose:
                    print(f"[ring]   segment {sequence} failed: {exc}", flush=True)
                break

            name = self.ring.next_name()
            (self.directory / name).write_bytes(payload)
            self.ring.append(segment.duration, self.now())
            self._taken_through = sequence
            written += 1

        for evicted in self.ring.trim(self.max_seconds):
            (self.directory / evicted.name).unlink(missing_ok=True)
        return written

    async def prime(self, seconds: float, timeout: float) -> float:
        """Poll until the ring holds ``seconds`` of media. Returns what it holds.

        The browser's demuxer has no header to read: MPEG-TS describes itself
        periodically, so opening a live stream means listening until the tables
        come round. Handed a ring holding one segment it gets a trickle - a
        segment every poll interval - and that is the only condition the WASM
        path has ever failed to start under. Filling the ring first makes every
        channel open under the conditions a warm one already works under.

        The wait is real but it is not new: the transcode path budgets twelve
        seconds for its first playlist segment, and the UI already shows a
        spinner for it.

        Returns rather than raises on timeout. A device that will not fill is
        still worth handing to the client, which falls back on its own.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout

        while self.ring.held_seconds < seconds:
            try:
                # Bounded by the deadline, not merely checked against it. A
                # device that accepts the connection and then says nothing
                # leaves this poll outstanding for ever, and a deadline tested
                # only between polls never gets to run - which is exactly what
                # held a request open past its own timeout the first time this
                # met a busy tuner.
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                await asyncio.wait_for(self.poll_once(), timeout=remaining)
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                if self.verbose:
                    print("[ring]   priming: device did not answer in time", flush=True)
                break
            except Exception as exc:
                # Same reasoning as `run`: a transient device failure is not the
                # end of the session, and the deadline below bounds the retrying.
                if self.verbose:
                    print(f"[ring]   priming: poll failed: {exc}", flush=True)
            if self.ring.held_seconds >= seconds or loop.time() >= deadline:
                break
            if self.verbose:
                print(
                    f"[ring]   priming: {self.ring.held_seconds:.1f}/{seconds:.1f}s"
                    f" in {len(self.ring.segments)} segments",
                    flush=True,
                )
            await asyncio.sleep(self.interval)

        return self.ring.held_seconds

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
