"""The follower pulls each device segment exactly once and keeps the ring honest.

Tests drive the coroutines with ``asyncio.run``, the way ``test_recordings``
does, rather than pulling in an async plugin convention this suite does not use.
"""

import asyncio
from datetime import datetime, timedelta, timezone

from app.live_follower import RingFollower, parse_device_playlist
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
    assert segments == [("seg100.ts", 6.0), ("seg101.ts", 6.0)]


def test_parse_playlist_without_media_sequence_starts_at_zero():
    sequence, segments = parse_device_playlist("#EXTM3U\n#EXTINF:6.0,\na.ts\n")
    assert sequence == 0
    assert segments == [("a.ts", 6.0)]


def test_parse_playlist_ignores_tags_between_extinf_and_uri():
    text = "#EXTM3U\n#EXTINF:6.0,\n#EXT-X-DISCONTINUITY\na.ts\n"
    assert parse_device_playlist(text)[1] == [("a.ts", 6.0)]


class FakeDevice:
    """Serves playlists in order and records every URL asked for."""

    def __init__(self, playlists):
        self.playlists = list(playlists)
        self.requested: list[str] = []

    async def fetch(self, url: str) -> bytes:
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

        async def fetch(self, url: str) -> bytes:
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
