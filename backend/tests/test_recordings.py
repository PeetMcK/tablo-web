"""Tests for recording listing, projection, and the windowed transcode cache."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.state import AppState
from app.transcode_cache import (
    MAX_ONDEMAND_WINDOWS,
    SEGMENT_SECONDS,
    WINDOW_SECONDS,
    CacheFull,
    CacheMeta,
    CacheState,
    InsufficientDisk,
    TranscodeCache,
    resolve_within,
    segments_in_window,
    window_count,
    window_length,
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

# 12615s = 210 full 60s windows + a 15s tail.
GAME = 12615


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------

def test_duration_prefers_recorded_over_scheduled():
    """airing_details.duration is the scheduled slot and understates the file."""
    assert AppState._recording_fields(DEVICE_RECORDING)["duration"] == 12615


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
    assert AppState._recording_fields(data)["description"] == "series desc"


def test_thumbnail_url_built_from_snapshot_image():
    assert AppState._recording_fields(DEVICE_RECORDING)["thumbnail"] == \
        "/api/recordings/80888/thumbnail"


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
# Window arithmetic
# ---------------------------------------------------------------------------

def test_window_count_covers_the_tail():
    assert window_count(GAME) == 211          # 210 full + 15s remainder
    assert window_count(WINDOW_SECONDS) == 1
    assert window_count(WINDOW_SECONDS + 1) == 2


def test_final_window_is_short():
    assert window_length(GAME, 0) == WINDOW_SECONDS
    assert window_length(GAME, 210) == 15


def test_segments_per_window():
    assert segments_in_window(GAME, 0) == WINDOW_SECONDS // SEGMENT_SECONDS
    assert segments_in_window(GAME, 210) == 3   # ceil(15 / 6)


# ---------------------------------------------------------------------------
# Playlist
# ---------------------------------------------------------------------------

def _cache(tmp_path, budget=10**9) -> TranscodeCache:
    async def never_called(path):  # pragma: no cover - guard
        raise AssertionError("session_starter should not be called")

    return TranscodeCache(session_starter=never_called, root=tmp_path, budget_bytes=budget)


def _register(c: TranscodeCache, oid=80888, duration=GAME) -> CacheMeta:
    meta = CacheMeta(object_id=oid, path=f"/recordings/x/{oid}", source_duration=duration)
    c.write_meta(meta)
    return meta


def test_playlist_spans_the_whole_recording_before_anything_is_encoded(tmp_path):
    """The point of window addressing: full timeline with zero segments on disk."""
    c = _cache(tmp_path)
    _register(c)
    assert c.windows_done(80888) == 0

    pl = c.build_playlist(80888)
    declared = sum(
        float(ln.split(":")[1].rstrip(","))
        for ln in pl.splitlines() if ln.startswith("#EXTINF")
    )
    assert declared == pytest.approx(GAME, abs=1.0)


def test_playlist_segment_count_matches_window_math(tmp_path):
    c = _cache(tmp_path)
    _register(c)
    pl = c.build_playlist(80888)
    uris = [ln for ln in pl.splitlines() if ln.endswith(".ts")]
    assert len(uris) == 210 * 10 + 3
    assert uris[0] == "w00000/seg_00.ts"
    assert uris[-1] == "w00210/seg_02.ts"


def test_playlist_is_vod_and_terminated(tmp_path):
    """A VOD playlist with ENDLIST is what makes the player expose full seeking."""
    c = _cache(tmp_path)
    _register(c)
    pl = c.build_playlist(80888)
    assert "#EXT-X-PLAYLIST-TYPE:VOD" in pl
    assert pl.rstrip().endswith("#EXT-X-ENDLIST")


def test_playlist_has_no_discontinuities(tmp_path):
    """Windows are muxed with absolute timestamps, so the stream is continuous.

    Marking a discontinuity would tell the player to re-base its timeline at each
    boundary - which is exactly the snap-back this avoids.
    """
    c = _cache(tmp_path)
    _register(c)
    assert "#EXT-X-DISCONTINUITY" not in c.build_playlist(80888)


def test_playlist_none_when_unregistered(tmp_path):
    assert _cache(tmp_path).build_playlist(999) is None


# ---------------------------------------------------------------------------
# Window readiness and state
# ---------------------------------------------------------------------------

def _mark_done(c: TranscodeCache, oid: int, w: int, size: int = 10):
    wd = c.window_dir(oid, w)
    wd.mkdir(parents=True, exist_ok=True)
    (wd / "seg_00.ts").write_bytes(b"0" * size)
    (wd / ".done").write_text("x")


def test_state_absent_for_unknown(tmp_path):
    assert _cache(tmp_path).state(1) is CacheState.ABSENT


def test_state_partial_then_complete(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=1, duration=120)          # 2 windows
    _mark_done(c, 1, 0)
    assert c.state(1) is CacheState.PARTIAL
    assert c.progress(1) == pytest.approx(0.5)
    _mark_done(c, 1, 1)
    assert c.state(1) is CacheState.COMPLETE
    assert c.progress(1) == 1.0


def test_window_without_marker_is_not_ready(tmp_path):
    """A window directory with no marker holds a truncated encode."""
    c = _cache(tmp_path)
    _register(c, oid=1, duration=120)
    wd = c.window_dir(1, 0)
    wd.mkdir(parents=True)
    (wd / "seg_00.ts").write_bytes(b"partial")
    assert c.window_ready(1, 0) is False


def test_sweep_orphans_removes_unmarked_windows(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=1, duration=120)
    _mark_done(c, 1, 0)
    (c.window_dir(1, 1)).mkdir(parents=True)
    (c.window_dir(1, 1) / "seg_00.ts").write_bytes(b"truncated")

    assert c.sweep_orphans() == [1]
    assert c.window_ready(1, 0) is True          # completed work survives
    assert not c.window_dir(1, 1).exists()       # truncated work removed


def test_corrupt_meta_reads_as_absent(tmp_path):
    c = _cache(tmp_path)
    d = c.dir_for(3)
    d.mkdir(parents=True)
    (d / "meta.json").write_text("{not json")
    assert c.state(3) is CacheState.ABSENT


# ---------------------------------------------------------------------------
# Path containment
# ---------------------------------------------------------------------------

def test_resolve_within_allows_segment_path(tmp_path):
    assert resolve_within(tmp_path, "w00000/seg_00.ts") == \
        (tmp_path / "w00000/seg_00.ts").resolve()


def test_resolve_within_rejects_parent_traversal(tmp_path):
    with pytest.raises(ValueError):
        resolve_within(tmp_path, "../../etc/passwd")


def test_resolve_within_rejects_sibling_prefix_escape(tmp_path):
    """The case a startswith() containment check gets wrong.

    '/cache/1' is a string prefix of '/cache/12', so a prefix comparison would
    accept an escape into a sibling whose name merely starts the same.
    """
    base = tmp_path / "1"
    base.mkdir()
    (tmp_path / "12").mkdir()
    with pytest.raises(ValueError):
        resolve_within(base, "../12/seg_00.ts")


# ---------------------------------------------------------------------------
# Eviction and guards
# ---------------------------------------------------------------------------

def test_make_room_evicts_least_recently_accessed_first(tmp_path):
    c = _cache(tmp_path, budget=1000)
    for oid, when in ((1, "2026-01-01T00:00:00Z"), (2, "2026-06-01T00:00:00Z"),
                      (3, "2026-09-01T00:00:00Z")):
        c.write_meta(CacheMeta(object_id=oid, path=f"/r/{oid}",
                               source_duration=60, last_access=when))
        _mark_done(c, oid, 0, size=400)

    c.make_room(0)
    assert c.state(1) is CacheState.ABSENT
    assert c.state(3) is CacheState.COMPLETE


def test_make_room_never_evicts_an_encoding_entry(tmp_path):
    c = _cache(tmp_path, budget=100)
    c.write_meta(CacheMeta(object_id=1, path="/r/1", source_duration=60))
    _mark_done(c, 1, 0, size=400)
    c._window_jobs[(1, 0)] = object()          # pretend a window is encoding
    with pytest.raises(CacheFull):
        c.make_room(0)
    assert c.dir_for(1).exists()


def test_evict_refuses_while_encoding(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=1, duration=60)
    c._window_jobs[(1, 0)] = object()
    assert c.evict(1) is False


def test_evict_removes_idle_entry(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=1, duration=60)
    _mark_done(c, 1, 0)
    assert c.evict(1) is True
    assert c.state(1) is CacheState.ABSENT


def test_disk_guard_refuses_when_short(tmp_path):
    with pytest.raises(InsufficientDisk):
        _cache(tmp_path)._check_disk(10**18)   # an exabyte


def test_estimate_scales_with_duration(tmp_path):
    assert _cache(tmp_path).estimate_bytes(GAME) == pytest.approx(GAME * 4_000_000 / 8)


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------

def test_ensure_window_encodes_the_right_offset(tmp_path, monkeypatch):
    calls = {}

    async def fake_session(path):
        calls["path"] = path
        return {"playlist_url": "http://device/stream/pl.m3u8?tok"}

    c = TranscodeCache(session_starter=fake_session, root=tmp_path, budget_bytes=10**12)
    _register(c, oid=80888, duration=GAME)

    real_exec = asyncio.create_subprocess_exec

    async def fake_exec(*cmd, cwd=None, **kw):
        calls["cmd"] = cmd
        # Emulate ffmpeg writing the window's segments.
        from pathlib import Path as P
        for n in range(segments_in_window(GAME, 7)):
            (P(cwd) / f"seg_{n:02d}.ts").write_bytes(b"x")

        class P0:
            returncode = 0
            async def wait(self): return 0
        return P0()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    try:
        ok = asyncio.run(c.ensure_window(80888, 7, "/recordings/x/80888", GAME))
    finally:
        monkeypatch.setattr(asyncio, "create_subprocess_exec", real_exec)

    assert ok is True
    assert c.window_ready(80888, 7)
    cmd = list(calls["cmd"])
    # Window 7 starts at 420s. The input seek lands 3s early and the output seek
    # discards that pre-roll, so decoding starts clean rather than mid-GOP.
    assert cmd[cmd.index("-ss") + 1] == "417.000"
    assert cmd[cmd.index("-i") + 1].startswith("http://")
    assert cmd[cmd.index("-t") + 1] == "60.000"
    # Second -ss, after the input, is the accurate seek across the pre-roll.
    assert cmd[cmd.index("-ss", cmd.index("-i")) + 1] == "3.000"
    # Absolute output timestamps are what keep playback from snapping back to
    # the start at each window boundary.
    assert cmd[cmd.index("-output_ts_offset") + 1] == "420"
    assert calls["path"] == "/recordings/x/80888"


def test_ready_window_is_not_re_encoded(tmp_path):
    async def fail(path):  # pragma: no cover
        raise AssertionError("must not contact device for a ready window")

    c = TranscodeCache(session_starter=fail, root=tmp_path, budget_bytes=10**12)
    _register(c, oid=5, duration=120)
    _mark_done(c, 5, 0)
    assert asyncio.run(c.ensure_window(5, 0, "/r/5", 120)) is True


def test_on_demand_windows_are_bounded(tmp_path):
    """A client requesting many windows at once must not start one encode each.

    This is the failure that saturated the host: 105 windows were demanded
    concurrently, each with its own FFmpeg and its own device session.
    """
    c = _cache(tmp_path)
    killed = []
    c._kill_window = killed.append  # type: ignore[method-assign]

    for w in range(20):
        c._claim_ondemand((80888, w))

    assert len(c._ondemand) == MAX_ONDEMAND_WINDOWS
    # The newest claims survive; a viewer is only ever in one place.
    assert list(c._ondemand) == [(80888, w) for w in range(16, 20)]
    assert killed == [(80888, w) for w in range(16)]


def test_evicted_waiter_is_released_not_left_pending(tmp_path):
    """Eviction must end the wait, so the client retries instead of hanging."""
    c = _cache(tmp_path)
    c._kill_window = lambda _k: None  # type: ignore[method-assign]

    c._claim_ondemand((80888, 0))
    for w in range(1, MAX_ONDEMAND_WINDOWS + 1):
        c._claim_ondemand((80888, w))

    assert (80888, 0) not in c._ondemand


def test_reclaiming_an_active_window_does_not_reorder_it(tmp_path):
    """Re-requesting a held window must not refresh its position.

    Otherwise a client polling one window keeps it alive forever while newer,
    genuinely wanted windows are evicted around it.
    """
    c = _cache(tmp_path)
    c._kill_window = lambda _k: None  # type: ignore[method-assign]

    c._claim_ondemand((80888, 0))
    c._claim_ondemand((80888, 1))
    c._claim_ondemand((80888, 0))
    assert list(c._ondemand) == [(80888, 0), (80888, 1)]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("method,path", [
    ("get", "/api/recordings"),
    ("post", "/api/recordings/1/watch"),
    ("get", "/api/recordings/1/status"),
    ("get", "/api/recordings/1/thumbnail"),
    ("get", "/api/recordings/cache/1/playlist.m3u8"),
    ("get", "/api/recordings/cache/1/w00000/seg_00.ts"),
    ("delete", "/api/recordings/1/cache"),
])
def test_routes_require_auth(method, path):
    assert getattr(client, method)(path).status_code == 401


def test_non_integer_object_id_rejected():
    """object_id is typed int, which removes the directory-injection surface."""
    assert client.get("/api/recordings/cache/abc/playlist.m3u8").status_code == 422


# ---------------------------------------------------------------------------
# Offline copies
# ---------------------------------------------------------------------------

def test_pinned_entry_survives_eviction_pressure(tmp_path):
    """The point of keeping a copy: LRU must not reclaim it."""
    c = _cache(tmp_path, budget=100)
    for oid in (1, 2):
        c.write_meta(CacheMeta(object_id=oid, path=f"/r/{oid}", source_duration=60,
                               last_access="2026-01-01T00:00:00Z"))
        _mark_done(c, oid, 0, size=400)
    c.set_pinned(1, True)

    c.make_room(0)
    assert c.state(1) is CacheState.COMPLETE   # kept
    assert c.state(2) is CacheState.ABSENT     # reclaimed


def test_evict_refuses_pinned_unless_forced(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=1, duration=60)
    _mark_done(c, 1, 0)
    c.set_pinned(1, True)

    assert c.evict(1) is False                 # automatic paths cannot
    assert c.evict(1, force=True) is True      # the explicit delete can
    assert c.state(1) is CacheState.ABSENT


def test_snapshot_lets_a_deleted_recording_still_be_listed(tmp_path):
    """Once the Tablo deletes it, meta.info is all that is left to render."""
    c = _cache(tmp_path)
    _register(c, oid=80888, duration=GAME)
    info = AppState._recording_fields(DEVICE_RECORDING)
    c.set_pinned(80888, True, info=info)

    meta = c.read_meta(80888)
    assert meta.pinned is True
    assert meta.info["title"] == "NFL Football"
    assert meta.info["subtitle"] == "Denver Broncos at Kansas City Chiefs"
    assert meta.info["duration"] == 12615
    assert 80888 in c.pinned_ids()


def test_storage_separates_pinned_from_reclaimable(tmp_path):
    c = _cache(tmp_path, budget=10_000)
    for oid in (1, 2):
        c.write_meta(CacheMeta(object_id=oid, path=f"/r/{oid}", source_duration=60))
        _mark_done(c, oid, 0, size=500)
    c.set_pinned(1, True)

    st = c.storage()
    # Pinned bytes are exempt from the budget, so reporting one number would
    # misrepresent how much is actually reclaimable.
    assert st["pinned_bytes"] >= 500
    assert st["cache_bytes"] >= 500
    assert st["pinned_count"] == 1
    assert st["budget_bytes"] == 10_000


def test_unpinning_makes_it_reclaimable_again(tmp_path):
    c = _cache(tmp_path, budget=100)
    _register(c, oid=1, duration=60)
    _mark_done(c, 1, 0, size=400)
    c.set_pinned(1, True)
    c.make_room(0)
    assert c.state(1) is CacheState.COMPLETE

    c.set_pinned(1, False)
    c.make_room(0)
    assert c.state(1) is CacheState.ABSENT


def test_set_pinned_on_unknown_recording_reports_failure(tmp_path):
    assert _cache(tmp_path).set_pinned(999, True) is False


@pytest.mark.parametrize("method,path", [
    ("post", "/api/recordings/1/keep"),
    ("delete", "/api/recordings/1/keep"),
    ("get", "/api/recordings/storage"),
])
def test_offline_routes_require_auth(method, path):
    assert getattr(client, method)(path).status_code == 401
