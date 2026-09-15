"""Tests for recording listing, projection, and the transcode cache."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.state import AppState
from app.transcode_cache import (
    CacheFull,
    CacheMeta,
    CacheState,
    InsufficientDisk,
    TranscodeCache,
    resolve_within,
)

client = TestClient(app)


# Shape taken from a real device response (Tablo 4G QUAD, firmware 2.2.58).
DEVICE_RECORDING = {
    "object_id": 80888,
    "path": "/recordings/sports/events/80888",
    "snapshot_image": {"image_id": 81904, "has_title": True},
    "airing_details": {
        "datetime": "2026-09-15T00:15Z",
        "duration": 10800,
        "show_title": "NFL Football",
    },
    "video_details": {
        "state": "finished",
        "duration": 12615,
        "width": 1280,
        "height": 720,
        "container_format": "mpeg2",
        "error": None,
    },
    "user_info": {"position": 42, "watched": False},
    "event": {
        "title": "Denver Broncos at Kansas City Chiefs",
        "description": "AFC West matchup at Arrowhead Stadium.",
    },
}


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------

def test_duration_prefers_recorded_over_scheduled():
    """airing_details.duration is the scheduled slot and understates the file."""
    out = AppState._recording_fields(DEVICE_RECORDING)
    assert out["duration"] == 12615


def test_sports_description_comes_from_event():
    """Reading only episode/series left every sports recording description null."""
    out = AppState._recording_fields(DEVICE_RECORDING)
    assert out["description"] == "AFC West matchup at Arrowhead Stadium."
    assert out["subtitle"] == "Denver Broncos at Kansas City Chiefs"


def test_description_precedence_episode_over_series():
    data = dict(DEVICE_RECORDING)
    data.pop("event")
    data["episode"] = {"description": "ep desc", "title": "Ep 1"}
    data["series"] = {"description": "series desc"}
    out = AppState._recording_fields(data)
    assert out["description"] == "ep desc"
    assert out["subtitle"] == "Ep 1"


def test_description_falls_back_to_series():
    data = dict(DEVICE_RECORDING)
    data.pop("event")
    data["series"] = {"description": "series desc"}
    out = AppState._recording_fields(data)
    assert out["description"] == "series desc"


def test_thumbnail_url_built_from_snapshot_image():
    out = AppState._recording_fields(DEVICE_RECORDING)
    assert out["thumbnail"] == "/api/recordings/80888/thumbnail"


def test_thumbnail_none_without_snapshot():
    data = dict(DEVICE_RECORDING)
    data.pop("snapshot_image")
    assert AppState._recording_fields(data)["thumbnail"] is None


def test_identifier_retained_for_backward_compatibility():
    out = AppState._recording_fields(DEVICE_RECORDING)
    assert out["identifier"] == out["object_id"] == 80888


def test_resume_position_surfaced():
    assert AppState._recording_fields(DEVICE_RECORDING)["position"] == 42


# ---------------------------------------------------------------------------
# Path containment
# ---------------------------------------------------------------------------

def test_resolve_within_allows_plain_filename(tmp_path):
    assert resolve_within(tmp_path, "playlist.m3u8") == (tmp_path / "playlist.m3u8").resolve()


def test_resolve_within_rejects_parent_traversal(tmp_path):
    with pytest.raises(ValueError):
        resolve_within(tmp_path, "../../etc/passwd")


def test_resolve_within_rejects_sibling_prefix_escape(tmp_path):
    """The case a startswith() containment check gets wrong.

    '/cache/1' is a string prefix of '/cache/12', so a prefix comparison would
    accept an escape into a sibling directory whose name merely starts the same.
    """
    base = tmp_path / "1"
    base.mkdir()
    (tmp_path / "12").mkdir()
    with pytest.raises(ValueError):
        resolve_within(base, "../12/seg_00000.ts")


# ---------------------------------------------------------------------------
# Cache state
# ---------------------------------------------------------------------------

def _cache(tmp_path, budget=10**9) -> TranscodeCache:
    async def never_called(path):  # pragma: no cover - guard
        raise AssertionError("session_starter should not be called")

    return TranscodeCache(session_starter=never_called, root=tmp_path, budget_bytes=budget)


def test_state_absent_for_unknown(tmp_path):
    assert _cache(tmp_path).state(1) is CacheState.ABSENT


def test_state_complete_roundtrip(tmp_path):
    c = _cache(tmp_path)
    c.write_meta(CacheMeta(object_id=1, path="/recordings/x/1",
                           state=CacheState.COMPLETE.value, source_duration=100))
    assert c.state(1) is CacheState.COMPLETE


def test_running_without_process_reports_failed(tmp_path):
    """A container killed mid-job leaves RUNNING metadata with no process.

    Reporting it as RUNNING forever would make that recording unplayable.
    """
    c = _cache(tmp_path)
    c.write_meta(CacheMeta(object_id=1, path="/recordings/x/1",
                           state=CacheState.RUNNING.value))
    assert c.state(1) is CacheState.FAILED


def test_sweep_orphans_marks_running_failed(tmp_path):
    c = _cache(tmp_path)
    c.write_meta(CacheMeta(object_id=7, path="/recordings/x/7",
                           state=CacheState.RUNNING.value))
    assert c.sweep_orphans() == [7]
    meta = c.read_meta(7)
    assert meta.state == CacheState.FAILED.value
    assert "restart" in meta.error


def test_corrupt_meta_reads_as_absent(tmp_path):
    c = _cache(tmp_path)
    d = c.dir_for(3)
    d.mkdir(parents=True)
    (d / "meta.json").write_text("{not json")
    assert c.state(3) is CacheState.ABSENT


def test_progress_complete_is_one(tmp_path):
    c = _cache(tmp_path)
    c.write_meta(CacheMeta(object_id=1, path="/r/1",
                           state=CacheState.COMPLETE.value, source_duration=600))
    assert c.progress(1) == 1.0


def test_progress_tracks_segments(tmp_path):
    c = _cache(tmp_path)
    c.write_meta(CacheMeta(object_id=1, path="/r/1",
                           state=CacheState.FAILED.value, source_duration=600))
    d = c.dir_for(1)
    for i in range(10):  # 10 segments * 6s = 60s of 600s
        (d / f"seg_{i:05d}.ts").write_bytes(b"x")
    assert c.progress(1) == pytest.approx(0.1)


# ---------------------------------------------------------------------------
# Eviction and guards
# ---------------------------------------------------------------------------

def _entry(c: TranscodeCache, oid: int, size: int, last_access: str, state=CacheState.COMPLETE):
    c.write_meta(CacheMeta(object_id=oid, path=f"/recordings/x/{oid}",
                           state=state.value, last_access=last_access))
    (c.dir_for(oid) / "seg_00000.ts").write_bytes(b"0" * size)


def test_make_room_evicts_least_recently_accessed_first(tmp_path):
    c = _cache(tmp_path, budget=1000)
    _entry(c, 1, 400, "2026-01-01T00:00:00Z")   # oldest
    _entry(c, 2, 400, "2026-06-01T00:00:00Z")
    _entry(c, 3, 400, "2026-09-01T00:00:00Z")   # newest
    c.make_room(0)
    assert c.state(1) is CacheState.ABSENT
    assert c.state(3) is CacheState.COMPLETE


def test_make_room_never_evicts_running(tmp_path):
    c = _cache(tmp_path, budget=100)
    _entry(c, 1, 400, "2026-01-01T00:00:00Z", state=CacheState.RUNNING)
    # RUNNING with no live process reads as FAILED, so force a live-looking job.
    c._jobs[1] = type("P", (), {"returncode": None})()
    with pytest.raises(CacheFull):
        c.make_room(0)
    assert c.dir_for(1).exists()


def test_evict_refuses_running(tmp_path):
    c = _cache(tmp_path)
    _entry(c, 1, 10, "2026-01-01T00:00:00Z", state=CacheState.RUNNING)
    c._jobs[1] = type("P", (), {"returncode": None})()
    assert c.evict(1) is False


def test_evict_removes_completed(tmp_path):
    c = _cache(tmp_path)
    _entry(c, 1, 10, "2026-01-01T00:00:00Z")
    assert c.evict(1) is True
    assert c.state(1) is CacheState.ABSENT


def test_disk_guard_refuses_when_short(tmp_path):
    c = _cache(tmp_path)
    with pytest.raises(InsufficientDisk):
        c._check_disk(10**18)  # an exabyte


def test_estimate_scales_with_duration(tmp_path):
    c = _cache(tmp_path)
    assert c.estimate_bytes(12615) == pytest.approx(12615 * 4_000_000 / 8)


# ---------------------------------------------------------------------------
# Job start
# ---------------------------------------------------------------------------

def test_ensure_starts_job_and_marks_running(tmp_path, monkeypatch):
    started = {}

    async def fake_session(path):
        started["path"] = path
        return {"playlist_url": "http://device/stream/pl.m3u8?tok", "keepalive": 165}

    c = TranscodeCache(session_starter=fake_session, root=tmp_path, budget_bytes=10**12)

    class FakeProc:
        returncode = None

        def kill(self):
            self.returncode = -9

        async def wait(self):
            if self.returncode is not None:
                return self.returncode
            await asyncio.sleep(3600)

    async def fake_spawn(cwd, url):
        started["url"] = url
        return FakeProc()

    monkeypatch.setattr(c, "_spawn_ffmpeg", fake_spawn)

    async def run():
        meta = await c.ensure(80888, "/recordings/sports/events/80888", 12615)
        assert meta.state == CacheState.RUNNING.value
        assert c.state(80888) is CacheState.RUNNING
        await c.stop(80888)

    asyncio.run(run())
    assert started["path"] == "/recordings/sports/events/80888"
    assert started["url"].startswith("http://device/stream/pl.m3u8")


def test_ensure_reuses_completed_without_device_call(tmp_path):
    async def fail(path):  # pragma: no cover
        raise AssertionError("must not contact device for a completed entry")

    c = TranscodeCache(session_starter=fail, root=tmp_path, budget_bytes=10**12)
    c.write_meta(CacheMeta(object_id=5, path="/recordings/x/5",
                           state=CacheState.COMPLETE.value, source_duration=100))

    meta = asyncio.run(c.ensure(5, "/recordings/x/5", 100))
    assert meta.state == CacheState.COMPLETE.value


def test_finalize_playlist_converts_event_to_vod(tmp_path):
    c = _cache(tmp_path)
    d = c.dir_for(1)
    d.mkdir(parents=True)
    (d / "playlist.m3u8").write_text(
        "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:6,\nseg_00000.ts\n"
    )
    c._finalize_playlist(1)
    text = (d / "playlist.m3u8").read_text()
    assert "#EXT-X-PLAYLIST-TYPE:VOD" in text
    assert "EVENT" not in text
    assert text.rstrip().endswith("#EXT-X-ENDLIST")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("method,path", [
    ("get", "/api/recordings"),
    ("post", "/api/recordings/1/watch"),
    ("get", "/api/recordings/1/status"),
    ("get", "/api/recordings/1/thumbnail"),
    ("get", "/api/recordings/cache/1/playlist.m3u8"),
    ("delete", "/api/recordings/1/cache"),
])
def test_routes_require_auth(method, path):
    assert getattr(client, method)(path).status_code == 401


def test_cached_media_rejects_traversal():
    resp = client.get("/api/recordings/cache/1/..%2F..%2Fetc%2Fpasswd")
    assert resp.status_code in (400, 401, 404)


def test_non_integer_object_id_rejected():
    """object_id is typed int, which removes the directory-injection surface."""
    assert client.get("/api/recordings/cache/abc/playlist.m3u8").status_code == 422
