"""A finished recording's playlist, held as an index rather than copied.

The device serves a finished recording as a complete VOD playlist: every
segment addressable, a real duration, and `EXT-X-ENDLIST` at the end. Measured
on a 3.5 hour recording: 8542 segments across 29 byte-ranged files, 1.2MB of
playlist, averaging 1.512s a segment.

That index is what makes seeking possible, and holding it is all we need to
do. Downloading the media would be ~25GB for one viewing of content the device
already has, so segments are fetched on demand instead - which is the whole
difference between this and `RingFollower`, and the reason the two are separate
things.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urljoin

from .live_follower import ByteRange, parse_device_playlist


@dataclass(frozen=True)
class VodSegment:
    """One segment, resolved against the playlist it came from."""

    url: str
    byte_range: ByteRange | None
    duration: float


@dataclass(frozen=True)
class VodIndex:
    segments: list[VodSegment]
    duration: float

    def playlist(self) -> str:
        """Our own playlist over the same media.

        No `PROGRAM-DATE-TIME`: media time for a recording is elapsed time from
        zero, which is what the scrubber already shows. The live ring needs
        dates because its window slides; this does not move at all.
        """
        target = max((s.duration for s in self.segments), default=1.0)
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{int(target) + 1}",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:VOD",
        ]
        for i, seg in enumerate(self.segments):
            lines.append(f"#EXTINF:{seg.duration:.3f},")
            lines.append(f"{i:05d}.ts")
        lines.append("#EXT-X-ENDLIST")
        return "\n".join(lines) + "\n"


class NotFinished(Exception):
    """The recording is still being written, so it has no index to build.

    An in-progress recording is published as a live-shaped playlist with no
    `ENDLIST` and only a rolling window, so it cannot be seeked - by us, or by
    the device's own app. It has its own path.
    """


def parse_vod_playlist(text: str, base_url: str) -> VodIndex:
    """Build an index from a finished recording's variant playlist.

    Segment parsing is shared with the live follower, which already understands
    this device's byte-range packing - including the continuation form where an
    offset is omitted and the segment carries on from the last one.
    """
    if "#EXT-X-ENDLIST" not in text:
        raise NotFinished("playlist has no EXT-X-ENDLIST")

    _sequence, segments = parse_device_playlist(text)
    resolved = [
        VodSegment(
            url=urljoin(base_url, seg.uri),
            byte_range=seg.byte_range,
            duration=seg.duration,
        )
        for seg in segments
    ]
    return VodIndex(segments=resolved, duration=sum(s.duration for s in resolved))
