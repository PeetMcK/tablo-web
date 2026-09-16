"""The live transcoder's lifecycle: no FFmpeg may outlive the backend.

A live transcode holds a tuner on the device for as long as it runs. One that
survives the process that started it keeps that tuner, keeps pulling segments,
and keeps a core busy, with nothing left that knows how to stop it. Two were
found reparented to init after a restart, 23 and 10 minutes old.
"""

import subprocess

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
