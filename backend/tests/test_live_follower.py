"""The follower pulls each device segment exactly once and keeps the ring honest.

Tests drive the coroutines with ``asyncio.run``, the way ``test_recordings``
does, rather than pulling in an async plugin convention this suite does not use.
"""

import asyncio

import pytest
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


def test_prime_gives_up_on_a_device_that_accepts_and_then_says_nothing(tmp_path):
    """A hung fetch must not outlive the deadline it was started under.

    The first live run met a busy tuner: the connection was accepted, no bytes
    ever came, and a deadline tested only between polls never got a turn - so
    the session open blocked past its own timeout with nothing to show for it.
    """

    class Wedged:
        async def fetch(self, url, byte_range=None):
            await asyncio.sleep(3600)

    follower = _follower(tmp_path, Wedged())
    follower.interval = 0.0

    async def drive():
        loop = asyncio.get_running_loop()
        started = loop.time()
        held = await follower.prime(seconds=6.0, timeout=0.2)
        return held, loop.time() - started

    held, elapsed = asyncio.run(drive())
    assert held == 0.0
    assert elapsed < 2.0


# ---------------------------------------------------------------------------
# Joining at the live edge rather than at the start of the device's history
# ---------------------------------------------------------------------------

def _history(count: int, duration: float = 1.5) -> str:
    lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:0"]
    for i in range(count):
        lines += [f"#EXTINF:{duration},", f"seg{i}.ts"]
    return "\n".join(lines) + "\n"


class HistoryDevice:
    """A DVR offering minutes of recording, which is what this device does."""

    def __init__(self, count: int):
        self.text = _history(count)

    async def fetch(self, url: str, byte_range=None) -> bytes:
        if url.endswith(".m3u8"):
            return self.text.encode()
        return b"TS" + url.encode()


def test_joins_at_the_live_edge_rather_than_taking_the_whole_history(tmp_path):
    """The device is a DVR: its playlist is history, not a live window.

    Taking all of it means the ring ingests the past as fast as it can be
    fetched. Measured against the real device at 3.5x realtime - the ring's
    live edge running away at two and a half seconds per second, and playback
    nearly five minutes behind the broadcast while appearing, from inside, to
    be following live.
    """
    device = HistoryDevice(200)          # five minutes of recording
    follower = _follower(tmp_path, device)
    follower.initial_backlog = 12.0

    written = asyncio.run(follower.poll_once())

    # Twelve seconds of 1.5s segments, and none of the history before them.
    assert written == 8
    assert follower.ring.held_seconds == 12.0


def test_takes_everything_when_the_device_offers_less_than_the_backlog(tmp_path):
    device = HistoryDevice(3)
    follower = _follower(tmp_path, device)
    follower.initial_backlog = 12.0

    assert asyncio.run(follower.poll_once()) == 3


def test_after_joining_it_follows_rather_than_rewinding(tmp_path):
    """The second poll takes what is new, not the history deliberately skipped."""
    device = HistoryDevice(200)
    follower = _follower(tmp_path, device)
    follower.initial_backlog = 12.0

    asyncio.run(follower.poll_once())
    device.text = _history(202)

    assert asyncio.run(follower.poll_once()) == 2


class _Response:
    """Just enough of an HTTP response for the follower to read a status off."""

    def __init__(self, status_code: int):
        self.status_code = status_code


class _HttpError(Exception):
    def __init__(self, status_code: int):
        super().__init__(f"Client error '{status_code}' for url")
        self.response = _Response(status_code)


class MissingSegmentDevice(FakeDevice):
    """A device that has rolled past one segment and says so, for ever."""

    def __init__(self, playlists, gone: str, status: int = 404):
        super().__init__(playlists)
        self.gone = gone
        self.status = status

    async def fetch(self, url: str, byte_range=None) -> bytes:
        if url.endswith(self.gone):
            self.requested.append(url)
            raise _HttpError(self.status)
        return await super().fetch(url, byte_range)


def test_a_segment_the_device_has_lost_does_not_stop_the_ring(tmp_path):
    """A 404 is permanent, and retrying it stops the ring dead.

    The loop breaks at the first failure and leaves ``_taken_through`` where it
    was, so a dead segment at the head of the window is re-requested on every
    poll and nothing after it is ever fetched. Measured on a freshly started
    channel: the same 404 twice, primed 0.0s of 8.0s wanted in 0 segments,
    timed out at 15s — and the viewer got neither the WASM path nor the
    transcode, because the fallback had nothing to fall back to.
    """
    device = MissingSegmentDevice([PLAYLIST_A], gone="seg100.ts")
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 1
    assert [s.name for s in follower.ring.segments] == ["00000.ts"]

    # And the next poll moves on rather than asking for the dead one again.
    asyncio.run(follower.poll_once())
    assert sum(1 for u in device.requested if u.endswith("seg100.ts")) == 1


def test_a_transient_failure_is_retried_rather_than_skipped(tmp_path):
    """The opposite case, and why the 404 check has to be narrow.

    A timeout or a 5xx may well succeed next time, and skipping past it would
    leave a hole in the ring that nothing ever fills.
    """
    class FlakyDevice(FakeDevice):
        def __init__(self, playlists):
            super().__init__(playlists)
            self.failures = 1

        async def fetch(self, url: str, byte_range=None) -> bytes:
            if url.endswith("seg100.ts") and self.failures:
                self.failures -= 1
                self.requested.append(url)
                raise TimeoutError("device did not answer")
            return await super().fetch(url, byte_range)

    device = FlakyDevice([PLAYLIST_A])
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 0
    assert asyncio.run(follower.poll_once()) == 2
    assert [s.name for s in follower.ring.segments] == ["00000.ts", "00001.ts"]


def test_a_5xx_is_not_treated_as_gone(tmp_path):
    device = MissingSegmentDevice([PLAYLIST_A], gone="seg100.ts", status=503)
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 0
    assert follower.ring.segments == []


def test_a_stream_the_device_has_lost_entirely_gives_up(tmp_path):
    """One missing segment is a hole; every segment missing is a dead stream.

    This device packs live as a single file addressed by byte range, so every
    segment in the window shares one uri. When that 404s the device's watch
    session is gone, and skipping forward just marches through sequence numbers
    for ever. Measured: fourteen consecutive 404s on the same token while the
    player polled an empty playlist twice a second and showed nothing.

    Giving up is what lets the client fall back to the transcode, which opens a
    watch session of its own.
    """
    class DeadStreamDevice(FakeDevice):
        async def fetch(self, url: str, byte_range=None) -> bytes:
            if url.endswith(".m3u8"):
                return await super().fetch(url, byte_range)
            self.requested.append(url)
            raise _HttpError(404)

    # A window longer than the give-up threshold, so the run can reach it.
    playlist = (
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n"
        "#EXT-X-MEDIA-SEQUENCE:100\n"
        # Short segments, so the live-edge backlog keeps the whole window and
        # the run of failures can actually reach the threshold.
        + "".join(f"#EXTINF:1.000,\nseg{100 + i}.ts\n" for i in range(10))
    )
    device = DeadStreamDevice([playlist])
    follower = _follower(tmp_path, device)

    with pytest.raises(RuntimeError, match="device lost the stream"):
        asyncio.run(follower.poll_once())


def test_one_lost_segment_does_not_trip_the_give_up_rule(tmp_path):
    device = MissingSegmentDevice([PLAYLIST_A], gone="seg100.ts")
    follower = _follower(tmp_path, device)

    assert asyncio.run(follower.poll_once()) == 1
