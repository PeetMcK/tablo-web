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
