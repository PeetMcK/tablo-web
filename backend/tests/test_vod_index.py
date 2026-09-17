"""A recording's playlist becomes an index, not a download.

The index is what makes seeking work: every segment's position is known up
front, so any point in a three-hour recording is one byte-range fetch away.
Copying the media instead would be ~25GB for one viewing of something the
device already has.

A recording still being written gets the same treatment, and the index simply
grows. What must never happen while it grows is renumbering: a segment's name
here is its position, and viewers hold names issued minutes ago.
"""

import pytest

from app.vod_index import parse_vod_playlist

BASE = "http://dev/stream/pls.m3u8?tok"

# This device packs a recording as a handful of files addressed by byte range:
# every EXTINF names the same uri and differs only in EXT-X-BYTERANGE.
FINISHED = """#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1.534870,
#EXT-X-PROGRAM-DATE-TIME:2026-09-13T20:24:48.000Z
#EXT-X-BYTERANGE:1667560@0
/stream/segw.ts?aOTs
#EXTINF:1.501000,
#EXT-X-BYTERANGE:1400000
/stream/segw.ts?aOTs
#EXTINF:1.464130,
#EXT-X-BYTERANGE:900000@4000000
/stream/segw.ts?bPUt
#EXT-X-ENDLIST
"""

# A recording still being written. Measured against SNL on 2026-09-17: the
# device publishes it from byte 0 of the first file, appends about a segment a
# second, and differs from a finished one in exactly one way - no ENDLIST.
IN_PROGRESS = """#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1.534870,
#EXT-X-PROGRAM-DATE-TIME:2026-09-17T08:00:03.000Z
#EXT-X-BYTERANGE:218644@0
/stream/segw.ts?live
#EXTINF:1.501000,
#EXT-X-BYTERANGE:260756
/stream/segw.ts?live
"""

GROWN = IN_PROGRESS + """#EXTINF:1.464130,
#EXT-X-BYTERANGE:217328
/stream/segw.ts?live
#EXTINF:1.501000,
#EXT-X-BYTERANGE:230676
/stream/segw.ts?live
"""

# The same recording if the device ever did drop its head. It does not today -
# 75 seconds apart the head byte-range and MEDIA-SEQUENCE were unchanged while
# the tail grew by 70 segments - but positional names must survive it anyway.
SLID = """#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:3
#EXTINF:1.464130,
#EXT-X-BYTERANGE:217328@479400
/stream/segw.ts?live
#EXTINF:1.501000,
#EXT-X-BYTERANGE:230676
/stream/segw.ts?live
"""


def test_builds_an_index_of_byte_ranged_segments():
    index = parse_vod_playlist(FINISHED, BASE)

    assert len(index.segments) == 3
    assert index.duration == pytest.approx(4.5, abs=0.01)

    first = index.segments[0]
    assert first.url == "http://dev/stream/segw.ts?aOTs"
    assert first.byte_range == (0, 1667559)
    assert first.duration == pytest.approx(1.53487)


def test_a_range_without_an_offset_continues_from_the_last():
    """The device omits the offset when a segment carries straight on.

    Read as a fresh offset of zero, every such segment would hand back the
    start of the file instead of the next part of it.
    """
    index = parse_vod_playlist(FINISHED, BASE)
    assert index.segments[1].byte_range == (1667560, 1667560 + 1400000 - 1)


def test_an_explicit_offset_is_honoured():
    index = parse_vod_playlist(FINISHED, BASE)
    assert index.segments[2].byte_range == (4000000, 4000000 + 900000 - 1)
    assert index.segments[2].url == "http://dev/stream/segw.ts?bPUt"


def test_a_recording_still_being_written_is_an_index_too():
    """It has no ENDLIST, but it does have a beginning - and that is the point.

    This replaces a test that asserted the opposite. The belief it encoded, that
    such a recording cannot be played from its start, was measured and found
    false: the device publishes it from byte 0 and simply keeps appending.
    """
    index = parse_vod_playlist(IN_PROGRESS, BASE)

    assert index.finished is False
    assert index.segments[0].byte_range == (0, 218643)


def test_a_finished_recording_says_so():
    assert parse_vod_playlist(FINISHED, BASE).finished is True


def test_an_unfinished_index_publishes_no_endlist():
    """ENDLIST is what tells a player to stop asking. This one is still growing."""
    text = parse_vod_playlist(IN_PROGRESS, BASE).playlist()

    assert "#EXT-X-ENDLIST" not in text
    # Nor is it a VOD: its length is not yet known.
    assert "#EXT-X-PLAYLIST-TYPE" not in text
    assert text.count("#EXTINF") == 2


def test_growth_keeps_every_segment_at_the_position_it_already_had():
    """Positional names are only safe while position 0 stays segment 0.

    A viewer forty minutes into a recording holds names this index issued
    minutes ago. Renumbering under them would not fail loudly - it would
    quietly serve different content for every name they still hold.
    """
    first = parse_vod_playlist(IN_PROGRESS, BASE)
    grown = first.extended_with(parse_vod_playlist(GROWN, BASE))

    assert len(grown.segments) == 4
    assert grown.segments[:2] == first.segments
    assert grown.duration > first.duration
    assert grown.finished is False


def test_growth_carries_the_end_of_a_recording_that_has_finished():
    """The refresh that sees ENDLIST is how a growing session learns it is over."""
    first = parse_vod_playlist(IN_PROGRESS, BASE)
    grown = first.extended_with(parse_vod_playlist(FINISHED, BASE + "?x"))

    assert grown.finished is True


def test_a_refresh_that_dropped_its_head_does_not_shift_the_names():
    """The device appends today. If it ever slides, names must still not move.

    Reconciling on identity rather than position: everything already held keeps
    the number it was issued under, and the refresh can only add.
    """
    first = parse_vod_playlist(IN_PROGRESS, BASE)
    grown = first.extended_with(parse_vod_playlist(SLID, BASE))

    assert grown.segments[:2] == first.segments
    assert len(grown.segments) == 4
    # Contiguous across the join: the slid playlist picks up where ours ended.
    assert grown.segments[2].byte_range == (479400, 479400 + 217328 - 1)


def test_nothing_a_refresh_omits_is_ever_dropped():
    """A viewer's held names outlive the device's own window, whatever it does."""
    first = parse_vod_playlist(GROWN, BASE)
    shrunk = first.extended_with(parse_vod_playlist(IN_PROGRESS, BASE))

    assert shrunk.segments == first.segments


def test_the_playlist_it_serves_is_a_finished_vod():
    index = parse_vod_playlist(FINISHED, BASE)
    text = index.playlist()

    assert text.startswith("#EXTM3U")
    assert "#EXT-X-PLAYLIST-TYPE:VOD" in text
    assert text.rstrip().endswith("#EXT-X-ENDLIST")
    # Our own names, so the device's tokens never reach the browser.
    assert "00000.ts" in text and "00002.ts" in text
    assert "segw.ts" not in text
    assert text.count("#EXTINF") == len(index.segments)


def test_media_time_is_elapsed_time_so_no_dates_are_published():
    """A recording does not slide, so it needs no PROGRAM-DATE-TIME.

    The live ring publishes dates because its window moves out from under a
    paused viewer. Here the index is fixed and position is simply seconds from
    the start, which is what the scrubber already shows.
    """
    assert "PROGRAM-DATE-TIME" not in parse_vod_playlist(FINISHED, BASE).playlist()
