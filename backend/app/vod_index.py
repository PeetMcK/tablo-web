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

from dataclasses import dataclass, replace
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
    #: False while the recording is still being written, which is the only way
    #: the device's two playlist shapes differ: no `EXT-X-ENDLIST`.
    finished: bool = True

    def playlist(self) -> str:
        """Our own playlist over the same media.

        No `PROGRAM-DATE-TIME`: media time for a recording is elapsed time from
        zero, which is what the scrubber already shows. The live ring needs
        dates because its window slides; this does not move at all.

        An unfinished recording gets neither `ENDLIST` nor `PLAYLIST-TYPE`. Both
        would be lies - it has more coming, and its length is not yet known -
        and their absence is what keeps the player re-reading this.
        """
        target = max((s.duration for s in self.segments), default=1.0)
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{int(target) + 1}",
            "#EXT-X-MEDIA-SEQUENCE:0",
        ]
        if self.finished:
            lines.append("#EXT-X-PLAYLIST-TYPE:VOD")
        for i, seg in enumerate(self.segments):
            lines.append(f"#EXTINF:{seg.duration:.3f},")
            lines.append(f"{i:05d}.ts")
        if self.finished:
            lines.append("#EXT-X-ENDLIST")
        return "\n".join(lines) + "\n"

    def extended_with(self, fresh: VodIndex) -> VodIndex:
        """This index plus whatever a later read of the same playlist added.

        Accumulating rather than replacing, because a segment's name here is its
        position. A viewer forty minutes into a recording is holding names this
        index issued minutes ago; renumbering under them would not fail loudly,
        it would quietly serve different content for every name still held. So
        nothing already held is reordered or dropped - a refresh can only add.

        Measured on this device, `fresh` is always a superset: 75 seconds apart
        the head byte-range and `MEDIA-SEQUENCE` were unchanged while the tail
        grew by 70 segments. The identity match handles that in one step. The
        fallback below covers a sliding window that has never been observed, and
        costs one scan to be safe against.
        """
        held = self.segments
        if not held:
            return fresh

        last = held[-1]
        try:
            after = fresh.segments.index(last) + 1
            added = fresh.segments[after:]
        except ValueError:
            # Our tail is not in this read at all. Add whatever it holds that we
            # do not, in its own order, and keep every name already issued.
            seen = set(held)
            added = [s for s in fresh.segments if s not in seen]

        if not added:
            # Nothing new, but the recording may have ended since the last read.
            return replace(self, finished=fresh.finished)

        segments = held + added
        return VodIndex(
            segments=segments,
            duration=sum(s.duration for s in segments),
            finished=fresh.finished,
        )


def parse_vod_playlist(text: str, base_url: str) -> VodIndex:
    """Build an index from a recording's variant playlist.

    Segment parsing is shared with the live follower, which already understands
    this device's byte-range packing - including the continuation form where an
    offset is omitted and the segment carries on from the last one.

    A recording still being written parses exactly the same way. It was refused
    here until its playlist was actually read: the belief that it offered only a
    rolling window with no reachable beginning turned out to be false. The
    device publishes it from byte 0 and appends, and `finished` is the whole
    difference.
    """
    _sequence, segments = parse_device_playlist(text)
    resolved = [
        VodSegment(
            url=urljoin(base_url, seg.uri),
            byte_range=seg.byte_range,
            duration=seg.duration,
        )
        for seg in segments
    ]
    return VodIndex(
        segments=resolved,
        duration=sum(s.duration for s in resolved),
        finished="#EXT-X-ENDLIST" in text,
    )
