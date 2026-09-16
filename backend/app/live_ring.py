"""The raw DVR window.

Removing the live transcode removes the DVR window with it: today's hour of
rewind is FFmpeg's own ``-hls_list_size``. This holds the same window by
copying the device's segments instead of re-encoding them, which costs disk
and no CPU at all.

This module is the bookkeeping only — what is held, what falls off, what the
playlist says. Fetching and file deletion live in ``live_follower``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import NamedTuple


class RingSegment(NamedTuple):
    sequence: int
    name: str
    duration: float
    started_at: datetime


@dataclass
class SegmentRing:
    """An ordered window of segments on disk, published as a live playlist."""

    origin: datetime
    segments: list[RingSegment] = field(default_factory=list)
    _next_sequence: int = 0

    def next_name(self) -> str:
        """The filename the next ``append`` will use."""
        return f"{self._next_sequence:05d}.ts"

    def append(self, duration: float, started_at: datetime) -> RingSegment:
        segment = RingSegment(self._next_sequence, self.next_name(), duration, started_at)
        self._next_sequence += 1
        self.segments.append(segment)
        return segment

    def trim(self, max_seconds: float) -> list[RingSegment]:
        """Drop the oldest segments until the window fits, returning what went.

        Never drops the last one: a window configured shorter than a single
        segment would otherwise publish an empty playlist while playback was
        in progress.
        """
        evicted: list[RingSegment] = []
        held = sum(s.duration for s in self.segments)
        while len(self.segments) > 1 and held > max_seconds:
            evicted.append(self.segments.pop(0))
            held -= evicted[-1].duration
        return evicted

    def holds(self, name: str) -> bool:
        return any(s.name == name for s in self.segments)

    def window(self) -> tuple[float, float]:
        """The held window in media seconds since ``origin``."""
        if not self.segments:
            return (0.0, 0.0)
        start = (self.segments[0].started_at - self.origin).total_seconds()
        return (start, start + sum(s.duration for s in self.segments))

    def playlist(self) -> str:
        target = max((s.duration for s in self.segments), default=6.0)
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{math.ceil(target)}",
            f"#EXT-X-MEDIA-SEQUENCE:{self.segments[0].sequence if self.segments else 0}",
        ]
        for index, segment in enumerate(self.segments):
            if index == 0:
                # The browser ties media time to this stamp, so it has to move
                # with the window: it dates whatever is currently first, not
                # where the session began.
                lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{segment.started_at.isoformat()}")
            lines.append(f"#EXTINF:{segment.duration:.3f},")
            lines.append(segment.name)
        return "\n".join(lines) + "\n"
