"""Serving a finished recording from the device, without copying it.

The point of this path is that the media stays where it is. A 3.5 hour
recording is ~25GB; the index that makes it seekable is a few hundred KB.
"""

import asyncio
import threading
import time
from types import SimpleNamespace

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


GROWING = PLAYLIST.replace("#EXT-X-ENDLIST\n", "")

GROWN = GROWING + """#EXTINF:1.500,
#EXT-X-BYTERANGE:1000
/stream/segw.ts?a
#EXTINF:1.500,
#EXT-X-BYTERANGE:1000
/stream/segw.ts?a
"""


def _register(text: str = PLAYLIST):
    index = parse_vod_playlist(text, BASE)
    stream.vod_sessions[SESSION] = stream.VodSession(index=index, device_url=BASE)
    return index


def _serving(pages: list[str], calls: list[str] | None = None):
    """Stand in for the device, handing back each playlist in turn."""
    async def fetch(url: str) -> str:
        if calls is not None:
            calls.append(url)
        return pages.pop(0) if len(pages) > 1 else pages[0]
    return fetch


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


def test_a_growing_playlist_is_re_read_from_the_device(monkeypatch):
    """The point of the whole path: what can be reached grows as it records."""
    _register(GROWING)
    try:
        monkeypatch.setattr(stream, "_fetch_text", _serving([GROWN]))
        session = stream.vod_sessions[SESSION]
        asyncio.run(stream._refresh_now(SESSION, session))

        assert len(session.index.segments) == 4
        text = session.index.playlist()
        assert text.count("#EXTINF") == 4
        # And the names already handed out still mean what they meant.
        assert "00000.ts" in text and "00003.ts" in text
    finally:
        _clear()


def test_the_playlist_request_never_waits_on_the_device(monkeypatch):
    """The browser feeds its decoder from this response.

    Awaiting the refresh put a measured ~330ms device round-trip inside one poll
    in six. Feeding stalled behind it, never got ahead of playback, and the
    frozen-picture watchdog fell the session back to the transcode about fifteen
    seconds in - which is how this was found.
    """
    _register(GROWING)
    started = threading.Event()

    async def slow(_url: str) -> str:
        started.set()
        await asyncio.sleep(5)
        return GROWN

    try:
        monkeypatch.setattr(stream, "_fetch_text", slow)
        with TestClient(app) as client:
            stream.vod_sessions[SESSION].refreshed_at = 0.0
            began = time.monotonic()
            r = client.get(f"/api/vod/{SESSION}/playlist.m3u8")
            elapsed = time.monotonic() - began

        assert r.status_code == 200
        assert elapsed < 1.0, f"blocked {elapsed:.2f}s on the device"
        # Served from what was already held, not from the read it kicked off.
        assert r.text.count("#EXTINF") == 2
        assert started.is_set(), "the refresh should still have been started"
    finally:
        _clear()


def test_a_growing_playlist_is_not_re_read_on_every_ask(monkeypatch):
    """The player polls about twice a second; the device adds about one a second."""
    _register(GROWING)
    calls: list[str] = []
    try:
        monkeypatch.setattr(stream, "_fetch_text", _serving([GROWN], calls))
        with TestClient(app) as client:
            stream.vod_sessions[SESSION].refreshed_at = 0.0
            for _ in range(5):
                client.get(f"/api/vod/{SESSION}/playlist.m3u8")
        # The first ask was stale and started a read; the next four fell inside
        # the interval and started nothing.
        assert len(calls) == 1
    finally:
        _clear()


def test_a_finished_index_is_never_re_read(monkeypatch):
    """It cannot change, and the 3.5 hour one is a 1.2MB playlist."""
    _register(PLAYLIST)
    calls: list[str] = []
    try:
        monkeypatch.setattr(stream, "_fetch_text", _serving([GROWN], calls))
        with TestClient(app) as client:
            stream.vod_sessions[SESSION].refreshed_at = 0.0
            client.get(f"/api/vod/{SESSION}/playlist.m3u8")
        assert calls == []
    finally:
        _clear()


def test_a_refresh_the_device_fails_keeps_serving_what_we_hold(monkeypatch):
    """Losing the device mid-recording must not empty a session that is playing."""
    _register(GROWING)

    async def broken(_url: str) -> str:
        raise RuntimeError("device went away")

    try:
        monkeypatch.setattr(stream, "_fetch_text", broken)
        session = stream.vod_sessions[SESSION]
        asyncio.run(stream._refresh_now(SESSION, session))

        assert len(session.index.segments) == 2
        with TestClient(app) as client:
            r = client.get(f"/api/vod/{SESSION}/playlist.m3u8")
        assert r.status_code == 200
        assert r.text.count("#EXTINF") == 2
    finally:
        _clear()


def test_a_recording_that_finishes_under_a_live_session_stops_being_re_read(monkeypatch):
    """The refresh that sees ENDLIST is how a growing session learns it is over."""
    _register(GROWING)
    calls: list[str] = []
    try:
        monkeypatch.setattr(stream, "_fetch_text", _serving([PLAYLIST], calls))
        session = stream.vod_sessions[SESSION]
        asyncio.run(stream._refresh_now(SESSION, session))
        assert session.index.playlist().rstrip().endswith("#EXT-X-ENDLIST")

        # Now finished, so the next ask starts nothing however stale it looks.
        session.refreshed_at = 0.0
        stream._refresh_if_growing(SESSION, session)
        assert len(calls) == 1
    finally:
        _clear()


def test_a_segment_the_refresh_added_is_servable(monkeypatch):
    """Growth is pointless if the new names 404."""
    _register(GROWING)
    try:
        monkeypatch.setattr(stream, "_fetch_text", _serving([GROWN]))

        async def bytes_for(_url, _rng):
            return b"\x47" * 188

        monkeypatch.setattr(stream, "_fetch_bytes", bytes_for)
        with TestClient(app) as client:
            assert client.get(f"/api/vod/{SESSION}/00003.ts").status_code == 404
            asyncio.run(stream._refresh_now(SESSION, stream.vod_sessions[SESSION]))
            assert client.get(f"/api/vod/{SESSION}/00003.ts").status_code == 200
    finally:
        _clear()


def _device_serving(variant: str, monkeypatch):
    """A device that hands back one master and one variant playlist."""
    from app.routes import recordings as rec

    class Resp:
        def __init__(self, text): self.text = text
        def raise_for_status(self): pass

    async def get(url, **_kw):
        if "pl.m3u8" in url:
            return Resp("#EXTM3U\n/stream/pls.m3u8?tok\n")
        return Resp(variant)

    async def resolve(_oid): return "/recordings/series/episodes/1", 3600
    async def start(_path): return {"token": "tok", "playlist_url": "http://dev/stream/pl.m3u8"}

    async def aclose(): pass

    cls = type(rec.state)
    monkeypatch.setattr(cls, "is_authenticated", property(lambda _s: True))
    # `aclose` because the app's shutdown closes this client on the way out.
    monkeypatch.setattr(
        cls, "http", property(lambda _s: SimpleNamespace(get=get, aclose=aclose)),
    )
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    monkeypatch.setattr(rec.state, "start_recording_session", start)
    return rec


def test_a_recording_still_being_written_is_no_longer_refused(monkeypatch):
    """It used to 409 with "use watch-raw", and the raw ring began at the live
    edge - so opening a show forty minutes in began forty minutes in.

    The belief behind that refusal was that the device published no reachable
    beginning. Measured 2026-09-17: it publishes from byte 0 and appends.
    """
    _device_serving(GROWING, monkeypatch)
    try:
        with TestClient(app) as client:
            r = client.post("/api/recordings/1/watch-vod")
        assert r.status_code == 200
        body = r.json()
        assert body["growing"] is True
        assert body["segments"] == 2
        assert body["stream_url"].startswith("/api/vod/")
        # And it is re-readable: without the variant url the index could never grow.
        assert stream.vod_sessions[body["session_id"]].device_url.endswith("pls.m3u8?tok")
    finally:
        for sid in list(stream.vod_sessions):
            stream.vod_sessions.pop(sid, None)


def test_a_finished_recording_is_not_marked_growing(monkeypatch):
    _device_serving(PLAYLIST, monkeypatch)
    try:
        with TestClient(app) as client:
            body = client.post("/api/recordings/1/watch-vod").json()
        assert body["growing"] is False
    finally:
        for sid in list(stream.vod_sessions):
            stream.vod_sessions.pop(sid, None)


def _watching_for_bif(monkeypatch, variant: str):
    """Records which recordings a watch-vod asks the device for thumbnails of."""
    rec = _device_serving(variant, monkeypatch)
    asked: list[int] = []

    async def fetch_bif(object_id, _path):
        asked.append(object_id)
        return True

    monkeypatch.setattr(rec.cache, "preview_available", lambda _oid: False)
    monkeypatch.setattr(rec.cache, "fetch_bif", fetch_bif)
    return asked


def test_a_finished_recording_fetches_its_thumbnail_pack(monkeypatch):
    """This path returns long before `register()`, which normally pulls it.

    Measured: of eleven recordings, the only four with thumbnails were the four
    that had been transcoded - so MPEG-2 playback had no scrub previews at all.
    """
    asked = _watching_for_bif(monkeypatch, PLAYLIST)
    try:
        with TestClient(app) as client:
            client.post("/api/recordings/1/watch-vod")
        assert asked == [1]
    finally:
        for sid in list(stream.vod_sessions):
            stream.vod_sessions.pop(sid, None)


def test_a_recording_still_being_written_asks_for_no_thumbnails(monkeypatch):
    """The device has none to give.

    Watched across a two-hour recording: no pack while `state` was `recording`,
    then a complete one within five minutes of it ending. Asking earlier only
    spends a device session on a null url.
    """
    asked = _watching_for_bif(monkeypatch, GROWING)
    try:
        with TestClient(app) as client:
            client.post("/api/recordings/1/watch-vod")
        assert asked == []
    finally:
        for sid in list(stream.vod_sessions):
            stream.vod_sessions.pop(sid, None)


def test_an_idle_vod_session_is_reaped():
    _register()
    try:
        stream.session_touched[SESSION] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
        reaped = stream.reap_idle_sessions()
        assert SESSION in reaped
        assert SESSION not in stream.vod_sessions
    finally:
        _clear()
