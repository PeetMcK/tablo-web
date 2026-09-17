"""A finished recording's playlist becomes an index, not a download.

The index is what makes seeking work: every segment's position is known up
front, so any point in a three-hour recording is one byte-range fetch away.
Copying the media instead would be ~25GB for one viewing of something the
device already has.
"""

import pytest

from app.vod_index import NotFinished, parse_vod_playlist

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

IN_PROGRESS = """#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1.001,
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


def test_a_recording_still_being_written_is_refused():
    """It has no ENDLIST, so there is no index to build and no seeking to do.

    The device publishes an in-progress recording as a live-shaped playlist
    with a rolling window; it cannot be played from its beginning by us or by
    the device's own app, and it has its own path.
    """
    with pytest.raises(NotFinished):
        parse_vod_playlist(IN_PROGRESS, BASE)


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
