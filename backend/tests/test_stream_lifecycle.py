"""The live transcoder's lifecycle: no FFmpeg may outlive the backend.

A live transcode holds a tuner on the device for as long as it runs. One that
survives the process that started it keeps that tuner, keeps pulling segments,
and keeps a core busy, with nothing left that knows how to stop it. Two were
found reparented to init after a restart, 23 and 10 minutes old.
"""

import asyncio
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routes import stream


def _sleeper() -> subprocess.Popen:
    """A stand-in for FFmpeg: something real that will not exit on its own."""
    return subprocess.Popen(["sleep", "60"])


def test_shutdown_kills_live_transcoders():
    proc = _sleeper()
    stream.transcode_procs["deadbeef"] = proc
    try:
        stream.shutdown_transcoders()
        assert proc.poll() is not None, "the transcoder was left running"
        assert "deadbeef" not in stream.transcode_procs
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_backend_shutdown_reaps_them():
    """Wired into the app's own teardown, not merely available to be called."""
    proc = _sleeper()
    stream.transcode_procs["deadbeef"] = proc
    try:
        with TestClient(app):
            pass
        assert proc.poll() is not None, "the backend exited and left FFmpeg behind"
    finally:
        stream.transcode_procs.pop("deadbeef", None)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_idle_transcoders_are_reaped():
    """A viewer who closes the laptop lid sends no `DELETE /stream/{id}`.

    Nothing then stops the transcode: it keeps pulling segments and keeps the
    tuner for as long as the backend lives. Two were found 24 and 22 minutes
    old with no player anywhere.
    """
    proc = _sleeper()
    stream.transcode_procs["deadbeef"] = proc
    stream.session_touched["deadbeef"] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
    try:
        stream.reap_idle_transcoders()
        assert proc.poll() is not None, "an abandoned transcode was left running"
        assert "deadbeef" not in stream.transcode_procs
    finally:
        stream.transcode_procs.pop("deadbeef", None)
        stream.session_touched.pop("deadbeef", None)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_a_watched_transcoder_is_left_alone():
    proc = _sleeper()
    stream.transcode_procs["deadbeef"] = proc
    stream.session_touched["deadbeef"] = time.monotonic()
    try:
        stream.reap_idle_transcoders()
        assert proc.poll() is None, "a transcode being watched was killed"
    finally:
        stream.transcode_procs.pop("deadbeef", None)
        stream.session_touched.pop("deadbeef", None)
        proc.kill()
        proc.wait(timeout=5)


def test_serving_a_segment_counts_as_watching(tmp_path, monkeypatch):
    """What marks a session alive is the player still asking for it.

    Only for a session that is actually running: an id nobody started is
    something a stray or hostile request made up, and recording those would let
    anyone grow this dict without limit.
    """
    monkeypatch.setattr(stream, "TRANSCODE_DIR", tmp_path)
    session_dir = tmp_path / "deadbeef"
    session_dir.mkdir()
    (session_dir / "00000.ts").write_bytes(b"\x47" * 188)
    proc = _sleeper()
    stream.transcode_procs["deadbeef"] = proc
    stream.session_touched["deadbeef"] = time.monotonic() - 10_000
    try:
        with TestClient(app) as client:
            resp = client.get("/api/transcoded/deadbeef/00000.ts")
            assert resp.status_code == 200
            idle = time.monotonic() - stream.session_touched["deadbeef"]
            assert idle < 5, "the fetch did not count as the session being watched"

        stream.session_touched.pop("stranger", None)
        with TestClient(app) as client:
            client.get("/api/transcoded/stranger/00000.ts")
        assert "stranger" not in stream.session_touched
    finally:
        stream.transcode_procs.pop("deadbeef", None)
        stream.session_touched.pop("deadbeef", None)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_the_backend_runs_the_sweep_on_its_own(monkeypatch):
    """Nobody is left to make a request, so the sweep cannot wait for one."""
    monkeypatch.setattr(stream, "REAP_INTERVAL", 0.01)
    proc = _sleeper()
    stream.transcode_procs["deadbeef"] = proc
    stream.session_touched["deadbeef"] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
    try:
        with TestClient(app):
            deadline = time.monotonic() + 3
            while proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            # Asserted inside the context on purpose: the teardown kills every
            # transcoder anyway, so the same check after it would pass without
            # a sweep ever having run.
            assert proc.poll() is not None, "the backend never swept by itself"
    finally:
        stream.transcode_procs.pop("deadbeef", None)
        stream.session_touched.pop("deadbeef", None)
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


@pytest.mark.asyncio
async def test_start_transcoder_spawns_and_registers(tmp_path, monkeypatch):
    """Nothing drove this function before; the registry was filled by hand.

    So the spawn — the part every live session depends on — had no coverage at
    all, and the move onto a thread could have broken it silently.
    """
    monkeypatch.setattr(stream, "TRANSCODE_DIR", tmp_path)
    monkeypatch.setattr(stream, "live_ffmpeg_cmd", lambda _dir, _url: ["sleep", "60"])

    try:
        await stream.start_transcoder("deadbeef", "http://device/pl.m3u8")
        proc = stream.transcode_procs.get("deadbeef")
        assert proc is not None, "the session was never registered"
        assert proc.poll() is None, "FFmpeg was not started"
        log = (tmp_path / "deadbeef" / "ffmpeg.log").read_text()
        assert "http://device/pl.m3u8" in log, "the log records what was started"
    finally:
        proc = stream.transcode_procs.pop("deadbeef", None)
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


@pytest.mark.asyncio
async def test_evicting_a_transcoder_leaves_the_loop_free(tmp_path, monkeypatch):
    """Eviction gives FFmpeg two seconds to die. That wait used to happen on
    the event loop, which stalled every other request in the process — segment
    fetches for players already watching included."""
    monkeypatch.setattr(stream, "TRANSCODE_DIR", tmp_path)
    monkeypatch.setattr(stream, "live_ffmpeg_cmd", lambda _dir, _url: ["sleep", "60"])

    class SlowToDie:
        """Stands in for FFmpeg ignoring a kill for a second."""
        def kill(self):
            pass

        def wait(self, timeout=None):
            time.sleep(1)

    for i in range(stream.MAX_TRANSCODE_SESSIONS):
        stream.transcode_procs[f"old{i}"] = SlowToDie()

    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    beat = asyncio.create_task(ticker())
    try:
        await stream.start_transcoder("newborn", "http://device/pl.m3u8")
        beat.cancel()
        # A second of eviction at 10ms a tick. Held on the loop, this is 0.
        assert ticks > 20, f"the loop was blocked through the eviction ({ticks} ticks)"
    finally:
        beat.cancel()
        for key in [*stream.transcode_procs]:
            proc = stream.transcode_procs.pop(key)
            if isinstance(proc, subprocess.Popen) and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def test_live_ffmpeg_carries_the_marker_the_sweep_looks_for():
    """`_startup_cleanup` pgreps for the transcode directory.

    FFmpeg is started with ``cwd`` set to the session directory and purely
    relative arguments, so that string appeared nowhere in its command line and
    the sweep matched none of the processes it exists to kill.
    """
    cmd = stream.live_ffmpeg_cmd(stream.TRANSCODE_DIR / "deadbeef",
                                 "http://device/stream/pl.m3u8?token")
    assert any(stream.SWEEP_MARKER in arg for arg in cmd), (
        f"nothing in {cmd} matches pgrep -f {stream.SWEEP_MARKER}")
