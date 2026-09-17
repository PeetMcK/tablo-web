"""A ring session nobody is watching must not hold a tuner for ever.

The WASM live path copies raw MPEG-2 off the device into a ring on disk. That
ring holds a tuner through its polling task and up to LIVE_DVR_SECONDS of
1080i - about 7-8GB at this device's bitrate, roughly eight times what a
transcode's window costs.

Nothing reaped it. `touch_session` and the idle reaper both looked only at
`transcode_procs`; `sweep_stale_raw_dirs` deliberately skips any directory
belonging to a live session, so it could not catch one either; and the
follower's own loop runs until it is cancelled. The only orderly stop was a
DELETE, which a closed laptop never sends.
"""

import time
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.live_ring import SegmentRing
from app.main import app
from app.routes import stream

SESSION = "abcdef1234567890abcdef1234567890"
T0 = datetime(2026, 9, 16, 20, 0, 0, tzinfo=timezone.utc)


class _Task:
    """Stands in for the follower's polling task, which needs a running loop."""

    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True


@pytest.fixture
def ring_session(tmp_path):
    ring = SegmentRing(origin=T0)
    directory = tmp_path / SESSION
    directory.mkdir(parents=True, exist_ok=True)
    name = ring.next_name()
    (directory / name).write_bytes(b"TS-payload")
    ring.append(6.0, T0)

    previous_dir = stream.RAW_DIR
    stream.RAW_DIR = tmp_path
    task = _Task()
    stream.ring_sessions[SESSION] = (ring, None, task)
    try:
        yield task, directory
    finally:
        stream.ring_sessions.pop(SESSION, None)
        stream.session_touched.pop(SESSION, None)
        stream.RAW_DIR = previous_dir


def test_an_idle_ring_session_is_reaped(ring_session):
    task, directory = ring_session
    stream.session_touched[SESSION] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1

    reaped = stream.reap_idle_sessions()

    assert SESSION in reaped
    assert SESSION not in stream.ring_sessions
    assert task.cancelled, "the follower kept polling the device"
    assert not directory.exists(), "an hour of 1080i was left on disk"


def test_a_watched_ring_session_is_left_alone(ring_session):
    task, _directory = ring_session
    stream.session_touched[SESSION] = time.monotonic()

    assert stream.reap_idle_sessions() == []
    assert SESSION in stream.ring_sessions
    assert not task.cancelled


def test_a_brand_new_ring_session_gets_the_same_grace(ring_session):
    """Never touched means started moments ago, not abandoned."""
    task, _directory = ring_session
    stream.session_touched.pop(SESSION, None)

    assert stream.reap_idle_sessions() == []
    assert not task.cancelled


def test_asking_for_the_playlist_keeps_the_session_alive(ring_session):
    """The player's real heartbeat.

    It polls the playlist about twice a second for as long as it holds the
    session, including while paused - when no segment is being fetched at all.
    """
    task, _directory = ring_session
    stream.session_touched[SESSION] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1

    with TestClient(app) as client:
        assert client.get(f"/api/raw/{SESSION}/playlist.m3u8").status_code == 200

    assert stream.reap_idle_sessions() == []
    assert not task.cancelled


def test_reaping_covers_transcodes_as_well(ring_session):
    """The two kinds share one reaper, so neither can be forgotten again."""
    task, _directory = ring_session
    proc = __import__("subprocess").Popen(["sleep", "60"])
    stream.transcode_procs["deadbeef"] = proc
    stream.session_touched["deadbeef"] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
    stream.session_touched[SESSION] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
    try:
        reaped = stream.reap_idle_sessions()
        assert set(reaped) == {"deadbeef", SESSION}
        assert proc.poll() is not None
        assert task.cancelled
    finally:
        stream.transcode_procs.pop("deadbeef", None)
        stream.session_touched.pop("deadbeef", None)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_stopping_a_session_cancels_its_follower_and_clears_its_disk(ring_session):
    """The teardown `stop_stream` and the reaper now share."""
    task, directory = ring_session

    stream._stop_ring(SESSION)

    assert SESSION not in stream.ring_sessions
    assert task.cancelled
    assert not directory.exists()


def test_two_windows_on_one_channel_share_a_tuner(ring_session, monkeypatch):
    """Five windows on one channel must not take five of the four tuners.

    Nothing about the ring needs a tuner per viewer: the follower fetches each
    segment from the device exactly once and every viewer reads the same files
    off disk. But `start_stream` opened a fresh device watch and minted a new
    session id per request, so identical bytes cost a tuner each and the fifth
    window got a 503.
    """
    task, _directory = ring_session
    stream.ring_for_channel["S1_007_01"] = SESSION
    stream.ring_channel_of[SESSION] = "S1_007_01"
    stream.ring_viewers[SESSION] = 1
    # The join must happen before the device is touched, so the only thing
    # standing in the way here is the auth gate in front of it.
    monkeypatch.setattr(type(stream.state), "is_authenticated",
                        property(lambda self: True))
    try:
        with TestClient(app) as client:
            resp = client.post("/api/stream/S1_007_01?transcode=false&mode=ring")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["session_id"] == SESSION
        assert body["shared"] is True
        assert stream.ring_viewers[SESSION] == 2
        assert not task.cancelled
    finally:
        stream.ring_for_channel.pop("S1_007_01", None)
        stream.ring_channel_of.pop(SESSION, None)
        stream.ring_viewers.pop(SESSION, None)


def test_one_window_closing_leaves_the_others_watching(ring_session):
    task, directory = ring_session
    stream.ring_for_channel["S1_007_01"] = SESSION
    stream.ring_channel_of[SESSION] = "S1_007_01"
    stream.ring_viewers[SESSION] = 3
    try:
        stream.ring_viewers[SESSION] -= 1        # what the DELETE branch does
        assert stream.ring_viewers[SESSION] == 2
        assert SESSION in stream.ring_sessions
        assert not task.cancelled
        assert directory.exists()
    finally:
        stream.ring_for_channel.pop("S1_007_01", None)
        stream.ring_channel_of.pop(SESSION, None)
        stream.ring_viewers.pop(SESSION, None)


def test_ending_a_ring_forgets_its_channel(ring_session):
    """Or the next viewer joins a session that no longer exists."""
    _task, _directory = ring_session
    stream.ring_for_channel["S1_007_01"] = SESSION
    stream.ring_channel_of[SESSION] = "S1_007_01"
    stream.ring_viewers[SESSION] = 1

    stream._stop_ring(SESSION)

    assert "S1_007_01" not in stream.ring_for_channel
    assert SESSION not in stream.ring_channel_of
    assert SESSION not in stream.ring_viewers


def test_keepalive_skips_a_session_nobody_is_watching(ring_session, monkeypatch):
    """The expiry is the backstop, so it must not be refreshed away.

    Renewing every session we hold would keep an abandoned one alive for ever -
    the tuner locked out until the process ended - which is the opposite of
    what the loop is for. Only a session whose heartbeat is current is
    refreshed, so "nobody is watching" and "let it lapse" are the same thing.
    """
    import asyncio as _asyncio

    refreshed: list[str] = []
    monkeypatch.setattr(stream.state, "session_token", lambda sid: f"token-{sid}")

    async def fake_keepalive(token):
        refreshed.append(token)
        return True

    monkeypatch.setattr(stream.state, "keepalive_stream_session", fake_keepalive)
    monkeypatch.setattr(stream, "KEEPALIVE_INTERVAL", 0.01)

    stream.session_touched[SESSION] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1

    async def run_once():
        task = _asyncio.create_task(stream.keepalive_forever())
        await _asyncio.sleep(0.05)
        task.cancel()

    _asyncio.run(run_once())
    assert refreshed == [], "an abandoned session was kept alive"


def test_keepalive_refreshes_a_session_being_watched(ring_session, monkeypatch):
    import asyncio as _asyncio

    refreshed: list[str] = []
    monkeypatch.setattr(stream.state, "session_token", lambda sid: f"token-{sid}")

    async def fake_keepalive(token):
        refreshed.append(token)
        return True

    monkeypatch.setattr(stream.state, "keepalive_stream_session", fake_keepalive)
    monkeypatch.setattr(stream, "KEEPALIVE_INTERVAL", 0.01)

    stream.session_touched[SESSION] = time.monotonic()

    async def run_once():
        task = _asyncio.create_task(stream.keepalive_forever())
        await _asyncio.sleep(0.05)
        task.cancel()

    _asyncio.run(run_once())
    assert f"token-{SESSION}" in refreshed
