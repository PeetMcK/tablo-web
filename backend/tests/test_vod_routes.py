"""Serving a finished recording from the device, without copying it.

The point of this path is that the media stays where it is. A 3.5 hour
recording is ~25GB; the index that makes it seekable is a few hundred KB.
"""

import time

from fastapi.testclient import TestClient

from app.main import app
from app.routes import stream
from app.vod_index import parse_vod_playlist

SESSION = "abcdef1234567890abcdef1234567890"
BASE = "http://dev/stream/pls.m3u8?tok"

PLAYLIST = """#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:1.500,
#EXT-X-BYTERANGE:1000@0
/stream/segw.ts?a
#EXTINF:1.500,
#EXT-X-BYTERANGE:1000
/stream/segw.ts?a
#EXT-X-ENDLIST
"""


def _register():
    index = parse_vod_playlist(PLAYLIST, BASE)
    stream.vod_sessions[SESSION] = index
    return index


def _clear():
    stream.vod_sessions.pop(SESSION, None)
    stream.session_touched.pop(SESSION, None)


def test_serves_a_finished_playlist_over_the_devices_media():
    index = _register()
    try:
        with TestClient(app) as client:
            r = client.get(f"/api/vod/{SESSION}/playlist.m3u8")
        assert r.status_code == 200
        body = r.text
        assert body.count("#EXTINF") == len(index.segments)
        assert body.rstrip().endswith("#EXT-X-ENDLIST")
        # Our names, not the device's tokens.
        assert "00000.ts" in body
        assert "segw.ts" not in body
    finally:
        _clear()


def test_asking_for_the_playlist_keeps_the_session_alive():
    """A viewer paused in a recording stops asking for segments.

    Without this the idle reaper would take the session out from under them,
    which is exactly the case a long recording invites.
    """
    _register()
    try:
        stream.session_touched[SESSION] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
        with TestClient(app) as client:
            client.get(f"/api/vod/{SESSION}/playlist.m3u8")
        assert stream.reap_idle_sessions() == []
        assert SESSION in stream.vod_sessions
    finally:
        _clear()


def test_a_segment_past_the_end_is_not_found():
    _register()
    try:
        with TestClient(app) as client:
            assert client.get(f"/api/vod/{SESSION}/00099.ts").status_code == 404
    finally:
        _clear()


def test_a_bad_segment_name_is_refused():
    _register()
    try:
        with TestClient(app) as client:
            assert client.get(f"/api/vod/{SESSION}/../../etc/passwd").status_code in (400, 404)
    finally:
        _clear()


def test_an_unknown_session_is_not_found():
    _clear()
    with TestClient(app) as client:
        assert client.get(f"/api/vod/{SESSION}/playlist.m3u8").status_code == 404


def test_nothing_is_written_to_disk_for_a_vod_session(tmp_path, monkeypatch):
    """The constraint the whole design rests on.

    If a VOD session ever creates a directory under RAW_DIR, it has become a
    ring - and a ring over a three-hour recording is 25GB of a file the device
    already holds.
    """
    monkeypatch.setattr(stream, "RAW_DIR", tmp_path)
    _register()
    try:
        with TestClient(app) as client:
            client.get(f"/api/vod/{SESSION}/playlist.m3u8")
        assert list(tmp_path.iterdir()) == []
    finally:
        _clear()


def test_an_idle_vod_session_is_reaped():
    _register()
    try:
        stream.session_touched[SESSION] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
        reaped = stream.reap_idle_sessions()
        assert SESSION in reaped
        assert SESSION not in stream.vod_sessions
    finally:
        _clear()
