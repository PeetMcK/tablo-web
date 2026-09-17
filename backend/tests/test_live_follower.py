"""The follower pulls each device segment exactly once and keeps the ring honest.

Tests drive the coroutines with ``asyncio.run``, the way ``test_recordings``
does, rather than pulling in an async plugin convention this suite does not use.
"""

import asyncio
from datetime import datetime, timedelta, timezone

from app.live_follower import (
    DeviceSegment, RingFollower, parse_device_playlist, variant_of,
)
from app.live_ring import SegmentRing

T0 = datetime(2026, 9, 16, 20, 0, 0, tzinfo=timezone.utc)

PLAYLIST_A = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:6.000,
seg100.ts
#EXTINF:6.000,
seg101.ts
"""

# The device advanced by one: 100 fell off the front, 102 arrived at the back.
PLAYLIST_B = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:101
#EXTINF:6.000,
seg101.ts
#EXTINF:6.000,
seg102.ts
"""


def test_parse_device_playlist():
    sequence, segments = parse_device_playlist(PLAYLIST_A)
    assert sequence == 100
    assert segments == [
        DeviceSegment("seg100.ts", 6.0, None),
        DeviceSegment("seg101.ts", 6.0, None),
    ]


def test_parse_playlist_without_media_sequence_starts_at_zero():
    sequence, segments = parse_device_playlist("#EXTM3U\n#EXTINF:6.0,\na.ts\n")
    assert sequence == 0
    assert segments == [DeviceSegment("a.ts", 6.0, None)]


def test_parse_playlist_ignores_tags_between_extinf_and_uri():
    text = "#EXTM3U\n#EXTINF:6.0,\n#EXT-X-DISCONTINUITY\na.ts\n"
    assert parse_device_playlist(text)[1] == [DeviceSegment("a.ts", 6.0, None)]


# What this device actually serves: one file, sliced by byte range. Every
# EXTINF names the same uri, so a follower keyed on the uri alone sees one
# segment repeated for ever.
BYTERANGE = """#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:1
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1.5015,
#EXT-X-BYTERANGE:584492@0
stream/segw.ts?token
#EXTINF:1.5015,
#EXT-X-BYTERANGE:633372@584492
stream/segw.ts?token
"""


def test_parse_reads_byte_ranges():
    _sequence, segments = parse_device_playlist(BYTERANGE)
    assert segments == [
        DeviceSegment("stream/segw.ts?token", 1.5015, (0, 584491)),
        DeviceSegment("stream/segw.ts?token", 1.5015, (584492, 1217863)),
    ]


def test_a_byterange_without_an_offset_follows_the_previous_one():
    text = (
        "#EXTM3U\n"
        "#EXTINF:1.5,\n#EXT-X-BYTERANGE:100@0\nseg.ts\n"
        "#EXTINF:1.5,\n#EXT-X-BYTERANGE:200\nseg.ts\n"
    )
    assert parse_device_playlist(text)[1][1] == DeviceSegment("seg.ts", 1.5, (100, 299))


class ByteRangeDevice:
    """Serves a master, a byte-range media playlist, and one backing file."""

    def __init__(self):
        self.requested: list[tuple[str, tuple[int, int] | None]] = []

    async def fetch(self, url: str, byte_range: tuple[int, int] | None = None) -> bytes:
        self.requested.append((url, byte_range))
        if url.endswith("playlist.m3u8"):
            return MASTER_TO_BYTERANGE.encode()
        if "pls.m3u8" in url:
            return BYTERANGE.encode()
        assert byte_range is not None, "a byte-range segment must be fetched by range"
        start, end = byte_range
        return bytes(end - start + 1)


MASTER_TO_BYTERANGE = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=10000000
stream/pls.m3u8?token
"""


def test_byte_range_segments_become_whole_files(tmp_path):
    device = ByteRangeDevice()
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 2

    # Each range is fetched as its own file, so the browser sees ordinary
    # segments and knows nothing about the device's packing.
    assert (tmp_path / "00000.ts").stat().st_size == 584492
    assert (tmp_path / "00001.ts").stat().st_size == 633372
    ranges = [r for _url, r in device.requested if r is not None]
    assert ranges == [(0, 584491), (584492, 1217863)]


def test_the_same_uri_at_a_new_range_is_a_new_segment(tmp_path):
    """Keyed on the uri alone, this device looks like one segment for ever."""
    device = ByteRangeDevice()
    follower = _follower(tmp_path, device)

    asyncio.run(follower.poll_once())

    assert [s.name for s in follower.ring.segments] == ["00000.ts", "00001.ts"]


# What the device actually serves: a master playlist naming one variant. The
# transcode path never saw this because FFmpeg follows it itself.
MASTER = """#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=10000000
stream/pls.m3u8?token=abc&fmt=v4
"""


def test_variant_of_finds_the_media_playlist_in_a_master():
    assert variant_of(MASTER) == "stream/pls.m3u8?token=abc&fmt=v4"


def test_variant_of_says_nothing_about_a_media_playlist():
    assert variant_of(PLAYLIST_A) is None


def test_variant_of_ignores_a_master_with_no_uri_after_the_tag():
    assert variant_of("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n") is None


class MasterDevice:
    """Serves a master playlist first, then the media playlist behind it."""

    def __init__(self):
        self.requested: list[str] = []

    async def fetch(self, url: str, byte_range=None) -> bytes:
        self.requested.append(url)
        if url.endswith("playlist.m3u8"):
            return MASTER.encode()
        if "pls.m3u8" in url:
            return PLAYLIST_A.encode()
        return b"TS" + url.encode()


def test_follows_a_master_playlist_to_its_variant(tmp_path):
    device = MasterDevice()
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 2
    assert "http://device/live/stream/pls.m3u8?token=abc&fmt=v4" in device.requested
    # Segment URIs resolve against the variant, not against the master.
    assert "http://device/live/stream/seg100.ts" in device.requested


def test_remembers_the_variant_rather_than_re_reading_the_master(tmp_path):
    device = MasterDevice()
    follower = _follower(tmp_path, device)

    asyncio.run(follower.poll_once())
    asyncio.run(follower.poll_once())

    masters = [u for u in device.requested if u.endswith("playlist.m3u8")]
    assert len(masters) == 1


class FakeDevice:
    """Serves playlists in order and records every URL asked for."""

    def __init__(self, playlists):
        self.playlists = list(playlists)
        self.requested: list[str] = []

    async def fetch(self, url: str, byte_range=None) -> bytes:
        self.requested.append(url)
        if url.endswith(".m3u8"):
            body = self.playlists.pop(0) if len(self.playlists) > 1 else self.playlists[0]
            return body.encode()
        return b"TS" + url.encode()


def _follower(tmp_path, device, max_seconds=3600.0):
    clock = {"t": T0}

    def now():
        value = clock["t"]
        clock["t"] += timedelta(seconds=6)
        return value

    return RingFollower(
        ring=SegmentRing(origin=T0),
        directory=tmp_path,
        playlist_url="http://device/live/playlist.m3u8",
        fetch=device.fetch,
        max_seconds=max_seconds,
        now=now,
    )


def test_first_poll_writes_every_segment(tmp_path):
    device = FakeDevice([PLAYLIST_A])
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 2
    assert [s.name for s in follower.ring.segments] == ["00000.ts", "00001.ts"]
    assert (tmp_path / "00000.ts").read_bytes().startswith(b"TS")


def test_second_poll_fetches_only_what_is_new(tmp_path):
    device = FakeDevice([PLAYLIST_A, PLAYLIST_B])
    follower = _follower(tmp_path, device)

    asyncio.run(follower.poll_once())
    assert asyncio.run(follower.poll_once()) == 1

    # seg101 was already held; fetching it twice would double the device load
    # and duplicate a segment in the ring.
    assert sum(1 for u in device.requested if u.endswith("seg101.ts")) == 1
    assert [s.name for s in follower.ring.segments] == ["00000.ts", "00001.ts", "00002.ts"]


def test_retention_deletes_evicted_files(tmp_path):
    device = FakeDevice([PLAYLIST_A, PLAYLIST_B])
    follower = _follower(tmp_path, device, max_seconds=12.0)

    asyncio.run(follower.poll_once())
    asyncio.run(follower.poll_once())

    assert not (tmp_path / "00000.ts").exists()
    assert (tmp_path / "00002.ts").exists()
    assert [s.name for s in follower.ring.segments] == ["00001.ts", "00002.ts"]


def test_relative_segment_uris_resolve_against_the_playlist(tmp_path):
    device = FakeDevice([PLAYLIST_A])
    follower = _follower(tmp_path, device)

    asyncio.run(follower.poll_once())

    assert "http://device/live/seg100.ts" in device.requested


def test_an_empty_playlist_is_not_an_error(tmp_path):
    device = FakeDevice(["#EXTM3U\n"])
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 0
    assert follower.ring.segments == []


def test_a_failed_segment_fetch_does_not_advance_past_it(tmp_path):
    """The next poll must retry it rather than leaving a hole in the ring."""

    class Flaky(FakeDevice):
        def __init__(self, playlists):
            super().__init__(playlists)
            self.fail_once = True

        async def fetch(self, url: str, byte_range=None) -> bytes:
            if url.endswith("seg100.ts") and self.fail_once:
                self.fail_once = False
                raise RuntimeError("device hiccup")
            return await super().fetch(url)

    device = Flaky([PLAYLIST_A])
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 0
    assert asyncio.run(follower.poll_once()) == 2
    assert [s.name for s in follower.ring.segments] == ["00000.ts", "00001.ts"]


def test_run_stops_when_cancelled(tmp_path):
    device = FakeDevice([PLAYLIST_A])
    follower = _follower(tmp_path, device)
    follower.interval = 0.01

    async def drive():
        task = asyncio.create_task(follower.run())
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return task.cancelled() or task.done()

    assert asyncio.run(drive())
    assert follower.ring.segments  # it did some work before being stopped


# ---------------------------------------------------------------------------
# Priming: filling the ring before the browser is told the session exists
# ---------------------------------------------------------------------------

class TricklingDevice:
    """One new segment per poll, the way a freshly tuned channel arrives."""

    def __init__(self, count: int = 10, duration: float = 1.5):
        self.count = count
        self.duration = duration
        self.polls = 0

    async def fetch(self, url: str, byte_range=None) -> bytes:
        if url.endswith(".m3u8"):
            self.polls += 1
            lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2",
                     "#EXT-X-MEDIA-SEQUENCE:0"]
            for i in range(min(self.polls, self.count)):
                lines += [f"#EXTINF:{self.duration},", f"seg{i}.ts"]
            return ("\n".join(lines) + "\n").encode()
        return b"TS" + url.encode()


def test_prime_waits_until_the_ring_holds_enough(tmp_path):
    device = TricklingDevice()
    follower = _follower(tmp_path, device)
    follower.interval = 0.0

    held = asyncio.run(follower.prime(seconds=6.0, timeout=5.0))

    # Four segments of 1.5s is the first moment 6s is satisfied.
    assert held >= 6.0
    assert len(follower.ring.segments) == 4


def test_prime_returns_early_rather_than_waiting_for_a_device_that_stalled(tmp_path):
    """A device that never fills must not hold the request open for ever."""

    class Stalled:
        async def fetch(self, url: str, byte_range=None) -> bytes:
            if url.endswith(".m3u8"):
                return b"#EXTM3U\n"
            return b"TS"

    follower = _follower(tmp_path, Stalled())
    follower.interval = 0.0

    async def drive():
        loop = asyncio.get_running_loop()
        started = loop.time()
        held = await follower.prime(seconds=6.0, timeout=0.2)
        return held, loop.time() - started

    held, elapsed = asyncio.run(drive())
    assert held == 0.0
    assert elapsed < 2.0


def test_prime_keeps_trying_through_a_device_error(tmp_path):
    class Flaky(TricklingDevice):
        async def fetch(self, url: str, byte_range=None) -> bytes:
            if url.endswith(".m3u8") and self.polls == 1:
                self.polls += 1
                raise RuntimeError("device hiccup")
            return await super().fetch(url, byte_range)

    follower = _follower(tmp_path, Flaky())
    follower.interval = 0.0

    assert asyncio.run(follower.prime(seconds=3.0, timeout=5.0)) >= 3.0


def test_prime_does_not_refetch_what_run_then_polls(tmp_path):
    """Priming advances the same bookmark ``run`` uses, so nothing is doubled."""
    device = TricklingDevice()
    follower = _follower(tmp_path, device)
    follower.interval = 0.0

    asyncio.run(follower.prime(seconds=3.0, timeout=5.0))
    before = len(follower.ring.segments)
    asyncio.run(follower.poll_once())

    names = [s.name for s in follower.ring.segments]
    assert len(names) == len(set(names))
    assert len(follower.ring.segments) >= before
