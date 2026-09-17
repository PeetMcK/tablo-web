"""The raw DVR ring: what it holds, what it evicts, what it publishes."""

from datetime import datetime, timedelta, timezone

from app.live_ring import SegmentRing

T0 = datetime(2026, 9, 16, 20, 0, 0, tzinfo=timezone.utc)


def _ring(count: int, duration: float = 6.0) -> SegmentRing:
    ring = SegmentRing(origin=T0)
    for i in range(count):
        ring.append(duration, T0 + timedelta(seconds=i * duration))
    return ring


def test_sequences_increase_from_zero():
    ring = _ring(3)
    assert [s.sequence for s in ring.segments] == [0, 1, 2]
    assert [s.name for s in ring.segments] == ["00000.ts", "00001.ts", "00002.ts"]


def test_next_name_is_the_name_the_next_append_will_take():
    ring = _ring(2)
    expected = ring.next_name()
    assert ring.append(6.0, T0).name == expected


def test_trim_evicts_oldest_beyond_the_window():
    ring = _ring(10)  # 60s held
    evicted = ring.trim(max_seconds=30)
    assert [s.name for s in evicted] == [
        "00000.ts", "00001.ts", "00002.ts", "00003.ts", "00004.ts",
    ]
    assert [s.sequence for s in ring.segments] == [5, 6, 7, 8, 9]


def test_trim_keeps_everything_inside_the_window():
    ring = _ring(3)
    assert ring.trim(max_seconds=3600) == []
    assert len(ring.segments) == 3


def test_trim_never_empties_the_ring():
    """A window shorter than one segment must still leave something playable."""
    ring = _ring(3)
    ring.trim(max_seconds=1.0)
    assert len(ring.segments) == 1


def test_playlist_is_a_live_sliding_window():
    ring = _ring(10)
    ring.trim(max_seconds=30)
    text = ring.playlist()
    assert "#EXTM3U" in text
    assert "#EXT-X-VERSION:3" in text
    # The sequence of the first segment still held, not a count of evictions.
    assert "#EXT-X-MEDIA-SEQUENCE:5" in text
    assert "#EXT-X-TARGETDURATION:6" in text
    # Live: no ENDLIST, or the player stops chasing the edge.
    assert "#EXT-X-ENDLIST" not in text
    assert text.count("#EXTINF:") == 5
    assert "00005.ts" in text and "00004.ts" not in text


def test_playlist_dates_the_first_segment_it_still_holds():
    """The browser derives media time from this, so it must move with the window."""
    ring = _ring(10)
    ring.trim(max_seconds=30)
    assert "#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:30+00:00" in ring.playlist()


def test_playlist_dates_only_the_first_segment():
    ring = _ring(4)
    assert ring.playlist().count("#EXT-X-PROGRAM-DATE-TIME") == 1


def test_window_is_media_seconds_from_the_origin():
    ring = _ring(10)
    ring.trim(max_seconds=30)
    assert ring.window() == (30.0, 60.0)


def test_empty_ring_publishes_an_empty_playlist():
    ring = SegmentRing(origin=T0)
    assert ring.window() == (0.0, 0.0)
    assert "#EXTINF:" not in ring.playlist()
    assert "#EXT-X-MEDIA-SEQUENCE:0" in ring.playlist()


def test_target_duration_rounds_up():
    """HLS requires TARGETDURATION >= every EXTINF, as an integer."""
    ring = SegmentRing(origin=T0)
    ring.append(5.5, T0)
    assert "#EXT-X-TARGETDURATION:6" in ring.playlist()


def test_holds_returns_a_name_it_published():
    ring = _ring(3)
    assert ring.holds("00001.ts")
    assert not ring.holds("00009.ts")
    ring.trim(max_seconds=6.0)
    assert not ring.holds("00000.ts")


def test_held_seconds_is_zero_for_an_empty_ring():
    assert SegmentRing(origin=T0).held_seconds == 0.0


def test_held_seconds_sums_what_the_window_holds():
    ring = SegmentRing(origin=T0)
    ring.append(6.0, T0)
    ring.append(1.5, T0)
    assert ring.held_seconds == 7.5
