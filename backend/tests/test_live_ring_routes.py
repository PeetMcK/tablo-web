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
