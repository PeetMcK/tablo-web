"""Serving the raw ring: shape, safety, lifecycle."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app.live_ring import SegmentRing
from app.main import app
from app.routes import stream as stream_routes

client = TestClient(app)

VALID_HEX = "abcdef1234567890abcdef1234567890"
T0 = datetime(2026, 9, 16, 20, 0, 0, tzinfo=timezone.utc)


def _register(tmp_path, session_id=VALID_HEX, segments=2):
    """Put a ring in place without a device, a task, or a running loop."""
    ring = SegmentRing(origin=T0)
    directory = tmp_path / session_id
    directory.mkdir(parents=True, exist_ok=True)
    for _ in range(segments):
        name = ring.next_name()
        (directory / name).write_bytes(b"TS-payload")
        ring.append(6.0, T0)
    stream_routes.RAW_DIR = tmp_path
    stream_routes.ring_sessions[session_id] = (ring, None, None)
    return ring


def _clear():
    stream_routes.ring_sessions.clear()


def test_raw_playlist_requires_a_known_session():
    _clear()
    assert client.get(f"/api/raw/{VALID_HEX}/playlist.m3u8").status_code == 404


def test_raw_rejects_a_non_hex_session():
    resp = client.get("/api/raw/not-a-session/playlist.m3u8")
    assert resp.status_code in (400, 404, 422)


def test_raw_rejects_traversal_in_the_session_id():
    resp = client.get("/api/raw/../../../etc/passwd/playlist.m3u8")
    assert resp.status_code in (400, 404, 422)


def test_raw_rejects_traversal_in_the_segment_name(tmp_path):
    _register(tmp_path)
    try:
        resp = client.get(f"/api/raw/{VALID_HEX}/../../etc/passwd")
        assert resp.status_code in (400, 404)
    finally:
        _clear()


def test_raw_rejects_a_name_that_is_not_a_segment(tmp_path):
    """Only NNNNN.ts is servable - not a log, not a playlist by another name."""
    _register(tmp_path)
    try:
        assert client.get(f"/api/raw/{VALID_HEX}/ffmpeg.log").status_code in (400, 404)
    finally:
        _clear()


def test_raw_playlist_is_served_as_hls(tmp_path):
    _register(tmp_path)
    try:
        resp = client.get(f"/api/raw/{VALID_HEX}/playlist.m3u8")
        assert resp.status_code == 200
        assert "mpegurl" in resp.headers["content-type"].lower()
        assert resp.headers["cache-control"] == "no-cache"
        assert "#EXT-X-MEDIA-SEQUENCE:0" in resp.text
        assert "00000.ts" in resp.text
    finally:
        _clear()


def test_raw_segment_is_served_as_mpegts(tmp_path):
    _register(tmp_path)
    try:
        resp = client.get(f"/api/raw/{VALID_HEX}/00000.ts")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "video/mp2t"
        assert resp.content == b"TS-payload"
    finally:
        _clear()


def test_a_segment_the_ring_has_evicted_is_gone(tmp_path):
    ring = _register(tmp_path)
    try:
        ring.trim(max_seconds=6.0)
        assert client.get(f"/api/raw/{VALID_HEX}/00000.ts").status_code == 404
        assert client.get(f"/api/raw/{VALID_HEX}/00001.ts").status_code == 200
    finally:
        _clear()


def test_start_stream_still_requires_auth():
    assert client.post("/api/stream/some-channel-id?mode=ring").status_code == 401


def test_start_stream_rejects_an_unknown_mode():
    resp = client.post("/api/stream/some-channel-id?mode=nonsense")
    # Rejected on the mode or on auth, but never accepted.
    assert resp.status_code in (401, 422)


# ---------------------------------------------------------------------------
# Starting a ring session primes it before the browser hears about it
# ---------------------------------------------------------------------------

import asyncio


class _Trickle:
    """One more segment per poll, like a channel that has just been tuned."""

    def __init__(self, duration=1.5):
        self.duration = duration
        self.polls = 0

    async def fetch(self, url, byte_range=None):
        if url.endswith(".m3u8"):
            self.polls += 1
            lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:0"]
            for i in range(self.polls):
                lines += [f"#EXTINF:{self.duration},", f"seg{i}.ts"]
            return ("\n".join(lines) + "\n").encode()
        return b"TS"


def test_starting_a_ring_session_fills_it_before_returning(tmp_path):
    _clear()
    stream_routes.RAW_DIR = tmp_path
    device = _Trickle()

    async def drive():
        return await stream_routes._start_ring_session(
            VALID_HEX, "http://device/live/playlist.m3u8", T0,
            fetch=device.fetch, prime_seconds=6.0, prime_timeout=5.0, interval=0.0,
        )

    try:
        ring = asyncio.run(drive())
        # The browser is handed a window it can demux, not a single segment.
        assert ring is not None and ring.held_seconds >= 6.0
    finally:
        _cancel_ring_tasks()
        _clear()


def test_a_session_stopped_while_priming_does_not_leave_a_follower_running(tmp_path):
    """Closing the player mid-open must not leak a tuner for the whole window."""
    _clear()
    stream_routes.RAW_DIR = tmp_path
    device = _Trickle()

    async def drive():
        task = asyncio.create_task(stream_routes._start_ring_session(
            VALID_HEX, "http://device/live/playlist.m3u8", T0,
            fetch=device.fetch, prime_seconds=600.0, prime_timeout=1.0, interval=0.01,
        ))
        await asyncio.sleep(0.05)
        stream_routes.ring_sessions.pop(VALID_HEX, None)   # what stop_stream does
        return await task

    try:
        assert asyncio.run(drive()) is None
        assert VALID_HEX not in stream_routes.ring_sessions
    finally:
        _cancel_ring_tasks()
        _clear()


def _cancel_ring_tasks():
    for _ring, _follower, task in stream_routes.ring_sessions.values():
        if task is not None:
            task.cancel()


# ---------------------------------------------------------------------------
# Orphaned ring directories
# ---------------------------------------------------------------------------

def test_sweep_removes_a_ring_directory_nothing_is_writing(tmp_path):
    _clear()
    stream_routes.RAW_DIR = tmp_path
    stale = tmp_path / "deadbeef00000000"
    stale.mkdir()
    (stale / "00000.ts").write_bytes(b"TS")

    assert stream_routes.sweep_stale_raw_dirs(idle_seconds=0.0) == ["deadbeef00000000"]
    assert not stale.exists()


def test_sweep_leaves_a_directory_another_backend_is_still_filling(tmp_path):
    """Two backends share this directory; one must not wipe the other's ring."""
    _clear()
    stream_routes.RAW_DIR = tmp_path
    live = tmp_path / "abcdef0123456789"
    live.mkdir()
    (live / "00000.ts").write_bytes(b"TS")

    assert stream_routes.sweep_stale_raw_dirs(idle_seconds=3600.0) == []
    assert live.exists()


def test_sweep_leaves_a_directory_this_backend_owns(tmp_path):
    _clear()
    stream_routes.RAW_DIR = tmp_path
    owned = tmp_path / VALID_HEX
    owned.mkdir()
    (owned / "00000.ts").write_bytes(b"TS")
    stream_routes.ring_sessions[VALID_HEX] = (SegmentRing(origin=T0), None, None)

    try:
        assert stream_routes.sweep_stale_raw_dirs(idle_seconds=0.0) == []
        assert owned.exists()
    finally:
        _clear()
