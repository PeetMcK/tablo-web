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


#: Consecutive missing segments that mean the stream is gone rather than one
#: segment being lost. Three is comfortably more than the one or two a window
#: boundary produces, and far below the fourteen-and-counting a dead watch
#: session produced while the player sat on an empty playlist.
GONE_LIMIT = 3


def _is_gone(exc: Exception) -> bool:
    """Whether the device has said this segment does not exist.

    A 4xx is the device's considered answer rather than a hiccup, so the only
    thing retrying buys is another one. Read off the response rather than by
    exception type, so this does not depend on which HTTP client is in use -
    the tests supply their own ``fetch``.
    """
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    return isinstance(status, int) and 400 <= status < 500


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
        initial_backlog: float = 12.0,
    ) -> None:
        self.ring = ring
        self.directory = Path(directory)
        self.playlist_url = playlist_url
        self.fetch = fetch
        self.max_seconds = max_seconds
        self.now = now
        self.interval = interval
        self.verbose = verbose
        #: How much of the device's history to take on the first poll.
        self.initial_backlog = initial_backlog
        self.directory.mkdir(parents=True, exist_ok=True)
        # The device's own sequence number of the newest segment taken. Kept
        # rather than a set of names because the device's window slides: a
        # sequence number is the only stable identity across polls.
        self._taken_through: int | None = None
        #: Segments the device has answered 404 for, back to back. Reset by any
        #: segment that arrives, so this only counts an unbroken run.
        self._consecutive_gone = 0
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

    def _start_at_live_edge(self, device_sequence: int, segments: list[DeviceSegment]) -> None:
        """Skip the device's history, keeping only the newest few seconds.

        This device is a DVR and its playlist offers minutes of recording, not
        a live window. Taking all of it means the ring ingests history as fast
        as it can be fetched - measured at 3.5x realtime, with the ring's live
        edge running away from the viewer at two and a half seconds per second
        and playback nearly five minutes behind the broadcast while appearing,
        from inside, to be following live.

        Enough of the tail to start decoding immediately, and no more.
        """
        kept = 0.0
        index = len(segments)
        while index > 0 and kept + segments[index - 1].duration <= self.initial_backlog:
            index -= 1
            kept += segments[index].duration
        self._taken_through = device_sequence + index - 1
        if self.verbose:
            print(
                f"[ring]   joining at the live edge: skipped {index} of"
                f" {len(segments)} segments, kept {kept:.1f}s",
                flush=True,
            )

    async def poll_once(self) -> int:
        """Fetch what is new since the last poll. Returns how many arrived."""
        text, media_url = await self._media_playlist()
        device_sequence, segments = parse_device_playlist(text)

        if self._taken_through is None and segments:
            self._start_at_live_edge(device_sequence, segments)

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
                if self.verbose:
                    print(f"[ring]   segment {sequence} failed: {exc}", flush=True)
                if _is_gone(exc):
                    self._consecutive_gone += 1
                    if self._consecutive_gone >= GONE_LIMIT:
                        # Not one lost segment - the stream itself. This device
                        # packs live as a single file addressed by byte range,
                        # so every segment in the window shares one uri: when
                        # that 404s, the device's watch session is dead and no
                        # amount of skipping forward finds media again.
                        # Measured: fourteen consecutive 404s on the same token
                        # while the player polled an empty playlist twice a
                        # second and showed nothing, for ever.
                        #
                        # Giving up is what lets the client fall back to the
                        # transcode, which opens its own watch session.
                        raise RuntimeError(
                            f"device lost the stream: {GONE_LIMIT} consecutive"
                            f" segments missing (last: {exc})"
                        ) from exc
                    # The device says this segment does not exist, and that is
                    # not a verdict it revises: the stream has rolled past it,
                    # or it was advertised before it was written. Retrying it
                    # is retrying it for ever - and because the loop stops at
                    # the first failure, one dead segment at the head of the
                    # window stops the ring dead. Measured on a freshly started
                    # channel: two polls, the same 404 both times, primed
                    # 0.0s of 8.0s wanted in 0 segments, timed out at 15s, and
                    # the viewer got neither the WASM path nor the transcode.
                    #
                    # A one-segment hole in the ring is the cheaper failure by
                    # a wide margin, and the decoder resynchronises on the next
                    # sequence header.
                    self._taken_through = sequence
                    continue
                # Anything else - a timeout, a 5xx, a dropped connection - may
                # well succeed next time. Leave _taken_through where it is so
                # the next poll picks this segment up again rather than leaving
                # a hole nothing fills.
                break

            name = self.ring.next_name()
            (self.directory / name).write_bytes(payload)
            self.ring.append(segment.duration, self.now())
            self._taken_through = sequence
            self._consecutive_gone = 0
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
