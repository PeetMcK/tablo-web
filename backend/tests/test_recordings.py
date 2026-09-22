"""Tests for recording listing, projection, and the windowed transcode cache."""

import asyncio
import signal
import struct
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import store
from app.main import app
from app.state import AppState
from app.transcode_cache import (
    _BIF_MAGIC,
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
        # Nesting taken from a real record: the outer wrapper carries only
        # `channel`, `object_id` and `path`, and the identifier sits on the
        # inner channel beside the call sign. Getting this wrong is not
        # theoretical - the first version read it off the wrapper, passed, and
        # returned null against the device.
        "channel": {
            "object_id": 8101,
            "path": "/guide/channels/8101",
            "channel": {
                "call_sign": "KTMFABC", "network": "ABC",
                "major": 23, "minor": 1,
                "channel_identifier": "S34654_008_01",
            },
        },
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

def test_a_recording_carries_the_identifier_the_guide_is_keyed_by():
    """Without it a recording cannot be matched to its own airing.

    Live and Guide key on `(channel_identifier, start)`, and the info sheet is
    addressed the same way - so a recording with no identifier cannot be joined
    to the row describing it, or looked up at all.
    """
    out = AppState._recording_fields(DEVICE_RECORDING)
    assert out["channel"]["identifier"] == "S34654_008_01"


def test_duration_prefers_recorded_over_scheduled():
    """airing_details.duration is the scheduled slot and understates the file."""
    assert AppState._recording_fields(DEVICE_RECORDING)["duration"] == 12615


def _in_progress(minutes_ago: float, scheduled: int = 3600) -> dict:
    began = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return {
        **DEVICE_RECORDING,
        "airing_details": {
            **DEVICE_RECORDING["airing_details"],
            "datetime": began.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "duration": scheduled,
            "show_title": "Today 3rd Hour",
        },
        # What the device really reports mid-recording: the slot, not the file.
        "video_details": {**DEVICE_RECORDING["video_details"],
                          "state": "recording", "duration": 0},
    }


def test_a_finished_recording_reports_no_progress():
    """Its `duration` already is what was recorded; a second number would only
    be another thing to keep in step."""
    assert AppState._recording_fields(DEVICE_RECORDING)["recorded_seconds"] is None


def test_a_recording_in_progress_reports_how_much_exists():
    out = AppState._recording_fields(_in_progress(32))

    # Wall clock, to the nearest few seconds. The device publishes no such
    # figure while recording - `duration` stays the scheduled slot until it
    # finishes - and the exact one costs a device session to read.
    assert out["recorded_seconds"] == pytest.approx(32 * 60, abs=5)
    assert out["duration"] == 3600, "the slot is still what the card counts against"


def test_progress_never_exceeds_the_slot():
    """A tuner that started late or dropped out must not read as overrunning.

    Measured: one two-hour slot yielded 57.9 minutes of video. Wall clock alone
    would have claimed the full two hours right up to the end.
    """
    assert AppState._recording_fields(_in_progress(200, scheduled=3600))["recorded_seconds"] == 3600


def test_progress_is_absent_when_the_start_is_unknown():
    data = _in_progress(10)
    data["airing_details"] = {**data["airing_details"], "datetime": None}
    assert AppState._recording_fields(data)["recorded_seconds"] is None


def _with_offsets(minutes_ago: float, start: int, end: int = 0, scheduled: int = 7200) -> dict:
    data = _in_progress(minutes_ago, scheduled=scheduled)
    data["video_details"] = {**data["video_details"],
                             "recorded_offsets": {"start": start, "end": end}}
    return data


def test_a_late_start_is_taken_from_the_device_not_the_schedule():
    """The real numbers from a recording that began 63 minutes into its slot.

    Booked 13:00Z for two hours, `recorded_offsets: {start: 3786}`, really began
    14:03:06Z - three seconds from what its own playlist said. Counting from the
    scheduled start would have claimed two hours of video where 57.9 minutes
    existed, and claimed it for the whole final hour.
    """
    # 93 minutes into the slot, less the 3786s late start, is 1794s of video —
    # not the 5580s that counting from the schedule would have claimed.
    out = AppState._recording_fields(_with_offsets(93, start=3786))

    assert out["recorded_seconds"] == pytest.approx(93 * 60 - 3786, abs=5)
    assert out["recorded_seconds"] < 93 * 60
    assert out["recording_started"] is not None


def test_an_early_start_reads_as_more_recorded_not_less():
    """`start` is signed: -15 is a tuner that began fifteen seconds early."""
    out = AppState._recording_fields(_with_offsets(10, start=-15, scheduled=3600))
    assert out["recorded_seconds"] == pytest.approx(10 * 60 + 15, abs=5)


def test_the_bar_counts_against_what_the_recording_will_be():
    """Not the slot.

    A show that starts 63 minutes into a two-hour slot will be 57 minutes long,
    and a bar drawn against two hours could never fill. Verified against the
    finished recording: 7200 - 3786 + 59 = 3473, and its `duration` was 3473.
    """
    assert AppState._recording_fields(_with_offsets(93, start=3786, end=59))[
        "expected_seconds"] == 3473


def test_end_padding_is_absent_until_it_finishes():
    """`end` reads 0 mid-recording, so this runs slightly short until the end."""
    assert AppState._recording_fields(_with_offsets(93, start=3786))[
        "expected_seconds"] == 7200 - 3786


def test_progress_cannot_exceed_what_the_recording_will_be():
    """A tuner that stopped early must not read as growing for ever."""
    out = AppState._recording_fields(_with_offsets(500, start=3786, end=59))
    assert out["recorded_seconds"] == out["expected_seconds"] == 3473


def test_a_finished_recording_needs_no_expected_length():
    """Its `duration` already is what was captured."""
    assert AppState._recording_fields(DEVICE_RECORDING)["expected_seconds"] is None


def test_every_recording_says_when_it_really_began():
    """Finished ones too, because they get the same coverage bar.

    A recording that started fifteen minutes into its slot is missing fifteen
    minutes whether or not it is still going, and that is worth seeing most
    after the fact - when it is too late to do anything but know.
    """
    out = AppState._recording_fields(DEVICE_RECORDING)

    # -15s: the tuner began just before the slot, as it routinely does.
    assert out["recording_started"] == "2026-09-15T00:15:00Z"
    assert out["slot_seconds"] == 10800, "the slot, not the 12615s captured"
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


def test_protected_surfaced_defaulting_false():
    # Absent in the base record -> False.
    assert AppState._recording_fields(DEVICE_RECORDING)["protected"] is False
    # Present -> passed through.
    rec = {**DEVICE_RECORDING,
           "user_info": {"position": 0, "watched": False, "protected": True}}
    assert AppState._recording_fields(rec)["protected"] is True


def test_protect_endpoint_forwards_flat_body(monkeypatch):
    from app.state import state as app_state
    monkeypatch.setattr(type(app_state), "is_authenticated",
                        property(lambda self: True))

    async def fake_resolve(object_id):
        return "/recordings/series/episodes/86128", 1875
    seen = {}

    async def fake_patch(path, payload):
        seen["path"], seen["payload"] = path, payload
        return 200, {}
    monkeypatch.setattr(app_state, "resolve_recording", fake_resolve)
    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    r = client.patch("/api/recordings/86128/protect", json={"protected": True})
    assert r.status_code == 200
    assert r.json() == {"object_id": 86128, "protected": True}
    assert seen == {"path": "/recordings/series/episodes/86128",
                    "payload": {"protected": True}}


def test_protect_endpoint_requires_auth():
    assert client.patch("/api/recordings/1/protect",
                        json={"protected": True}).status_code == 401


def test_cancel_keep_stops_unpins_and_clears_error_keeping_cache(monkeypatch):
    from app.routes import recordings as rec_routes
    from app.state import state as app_state
    monkeypatch.setattr(type(app_state), "is_authenticated",
                        property(lambda self: True))
    calls = {"stop": False, "pinned": None, "error": "unset", "evicted": False}

    async def fake_stop(oid):
        calls["stop"] = True

    monkeypatch.setattr(rec_routes.cache, "read_meta", lambda oid: object())
    monkeypatch.setattr(rec_routes.cache, "stop", fake_stop)
    monkeypatch.setattr(rec_routes.cache, "set_pinned",
                        lambda oid, pinned, info=None: calls.__setitem__("pinned", pinned) or True)
    monkeypatch.setattr(rec_routes.cache, "set_error",
                        lambda oid, err: calls.__setitem__("error", err) or True)
    # Cancel must never delete bytes.
    monkeypatch.setattr(rec_routes.cache, "evict",
                        lambda *a, **k: calls.__setitem__("evicted", True) or True)

    r = client.post("/api/recordings/42/keep/cancel")
    assert r.status_code == 200
    assert r.json() == {"object_id": 42, "pinned": False, "canceled": True}
    assert calls["stop"] is True          # active work stopped
    assert calls["pinned"] is False       # un-pinned
    assert calls["error"] is None         # error cleared
    assert calls["evicted"] is False      # cache NOT deleted


def test_cancel_keep_requires_auth():
    assert client.post("/api/recordings/1/keep/cancel").status_code == 401


# A series episode, as the device returns one. Measured against
# /recordings/series/episodes/86128: `series` is null on an episode record and
# only `series_path` links it to its show, which is why the end card fetches
# the series separately for artwork.
EPISODE_RECORDING = {
    "object_id": 86128,
    "path": "/recordings/series/episodes/86128",
    "series_path": "/recordings/series/86119",
    "airing_details": {
        "datetime": "2026-09-17T17:30Z",
        "duration": 1800,
        "show_title": "Carl the Collector",
    },
    "video_details": {"state": "finished", "duration": 1875, "height": 480},
    "user_info": {"position": 0, "watched": False},
    "episode": {
        "title": "The Tool Collection",
        "description": "Carl gets a universal screwdriver.",
        "number": 5,
        "season_number": 1,
        "orig_air_date": "2024-11-20",
    },
}


def test_an_episode_carries_what_orders_it_against_its_siblings():
    """All four are already in the record, so listing them costs no fetch."""
    out = AppState._recording_fields(EPISODE_RECORDING)
    assert out["series_path"] == "/recordings/series/86119"
    assert out["season_number"] == 1
    assert out["episode_number"] == 5
    assert out["orig_air_date"] == "2024-11-20"


def test_a_recording_with_no_episode_data_still_lists():
    """Sport has none of it.

    Measured on the live library: six of eighteen recordings carry no
    `series_path` and no episode numbers at all, and every one of them is NFL
    Football - which is exactly the case the end card's date ordering exists
    for. They must project cleanly rather than raising.
    """
    out = AppState._recording_fields(DEVICE_RECORDING)
    assert out["series_path"] is None
    assert out["season_number"] is None
    assert out["episode_number"] is None
    assert out["orig_air_date"] is None
    # And the title is still there, which is what groups them instead.
    assert out["title"] == "NFL Football"


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


def test_rate_is_reported_from_completed_windows(tmp_path):
    c = _cache(tmp_path)
    # 27 MB of output produced in 36s of encoding.
    c._rate[66220] = deque([(time.monotonic(), 27 * 1024**2, 36.0, 60.0)])
    rate = c.rate(66220)
    assert rate["mbps"] == pytest.approx(6.29, abs=0.05)
    assert rate["realtime"] == pytest.approx(1.67, abs=0.05)


def test_rate_survives_the_gap_between_window_completions(tmp_path):
    """A sample only lands when a window finishes, and that takes 35-40s.

    Treating a sample older than that as idle made the readout blink out
    mid-download even though encoding never stopped.
    """
    c = _cache(tmp_path)
    c._rate[66220] = deque([(time.monotonic() - 45.0, 27 * 1024**2, 36.0, 60.0)])
    assert c.rate(66220)["mbps"] > 0


def test_rate_reads_as_idle_once_nothing_is_encoding(tmp_path):
    c = _cache(tmp_path)
    c._rate[66220] = deque([(time.monotonic() - 600.0, 27 * 1024**2, 36.0, 60.0)])
    assert c.rate(66220) == {"mbps": 0.0, "realtime": 0.0}


def test_a_live_encoder_outranks_a_stale_sample(tmp_path):
    """Evidence of work beats the clock: a slow window must not read as idle."""
    c = _cache(tmp_path)
    c._rate[66220] = deque([(time.monotonic() - 600.0, 27 * 1024**2, 36.0, 60.0)])
    c._procs[(66220, 7)] = (object(), False)
    assert c.rate(66220)["mbps"] > 0


def test_rate_is_zero_for_a_recording_that_never_encoded(tmp_path):
    assert _cache(tmp_path).rate(66220) == {"mbps": 0.0, "realtime": 0.0}


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

    # Within one recording the tighter per-recording cap applies: a viewer is
    # only ever in one place, and anything older is somewhere they have left.
    assert list(c._ondemand) == [(80888, w) for w in range(16, 20)]
    assert killed == [(80888, w) for w in range(16)]


def test_the_global_cap_bounds_windows_across_recordings(tmp_path):
    """Several recordings at once still cannot exceed the global budget."""
    c = _cache(tmp_path)
    c._kill_window = lambda _k: None  # type: ignore[method-assign]
    for oid in (1, 2, 3, 4, 5):
        c._claim_ondemand((oid, 0))
    assert len(c._ondemand) <= MAX_ONDEMAND_WINDOWS


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


def test_set_error_marks_a_partial_download_failed(tmp_path):
    # A 2-window recording with one window done is PARTIAL; an error on the
    # stopped fill makes it FAILED at that progress; clearing returns to PARTIAL.
    c = _cache(tmp_path)
    _register(c, oid=1, duration=120)
    _mark_done(c, 1, 0)
    assert c.state(1) is CacheState.PARTIAL
    c.set_error(1, "source gone")
    assert c.state(1) is CacheState.FAILED
    c.set_error(1, None)
    assert c.state(1) is CacheState.PARTIAL


def test_a_complete_download_ignores_a_stale_error(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=1, duration=60)
    _mark_done(c, 1, 0)   # 60s = one window = complete
    c.set_error(1, "ignored")
    assert c.state(1) is CacheState.COMPLETE


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


# ---------------------------------------------------------------------------
# Export to a single file
# ---------------------------------------------------------------------------

def test_segment_files_are_in_playback_order(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=5, duration=120)          # 2 windows, 10 segments each
    for w in (0, 1):
        _mark_done(c, 5, w)
        for n in range(segments_in_window(120, w)):
            (c.window_dir(5, w) / f"seg_{n:02d}.ts").write_bytes(b"x")

    files = c.segment_files(5)
    assert [f.parent.name + "/" + f.name for f in files[:3]] == [
        "w00000/seg_00.ts", "w00000/seg_01.ts", "w00000/seg_02.ts",
    ]
    assert files[-1].parent.name == "w00001"


def test_segment_files_skip_windows_that_were_never_encoded(tmp_path):
    """A hole is left as a hole rather than padded with something wrong."""
    c = _cache(tmp_path)
    _register(c, oid=5, duration=120)
    _mark_done(c, 5, 1)
    for n in range(segments_in_window(120, 1)):
        (c.window_dir(5, 1) / f"seg_{n:02d}.ts").write_bytes(b"x")

    files = c.segment_files(5)
    assert files
    assert all(f.parent.name == "w00001" for f in files)


def test_segment_files_empty_for_unknown_recording(tmp_path):
    assert _cache(tmp_path).segment_files(999) == []


def test_export_refuses_when_nothing_is_cached(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=5, duration=120)
    with pytest.raises(FileNotFoundError):
        asyncio.run(c.build_mp4(5))


def test_a_new_window_invalidates_a_previous_export(tmp_path):
    """The export is a snapshot; more encoding makes it stale."""
    c = _cache(tmp_path)
    _register(c, oid=5, duration=120)
    c.export_path(5).parent.mkdir(parents=True, exist_ok=True)
    c.export_path(5).write_bytes(b"stale")
    _mark_done(c, 5, 0)
    c.export_path(5).unlink(missing_ok=True)   # what _encode_window does
    assert not c.export_path(5).exists()


def test_download_name_is_readable_and_filesystem_safe():
    from app.routes.recordings import _download_name

    meta = CacheMeta(object_id=66220, path="/r/66220",
                     info={"title": "NFL Football",
                           "subtitle": "Green Bay Packers at Minnesota Vikings"})
    assert _download_name(meta) == "NFL Football - Green Bay Packers at Minnesota Vikings.mp4"


def test_download_name_strips_path_separators():
    """A device-supplied title must not be able to steer where a file lands."""
    from app.routes.recordings import _download_name

    meta = CacheMeta(object_id=1, path="/r/1", info={"title": "../../etc/passwd"})
    name = _download_name(meta)
    assert "/" not in name and "\\" not in name
    # A leading dot would make it a hidden file.
    assert not name.startswith(".")
    assert name.endswith(".mp4")


def test_download_name_falls_back_without_metadata():
    from app.routes.recordings import _download_name

    assert _download_name(CacheMeta(object_id=77, path="/r/77")) == "recording-77.mp4"


def test_re_registering_keeps_a_recording_pinned(tmp_path):
    """Registration must not undo what the user asked to keep.

    Rebuilding the record on a duration change cleared `pinned`, which made an
    explicitly-kept offline copy eligible for eviction. Two were destroyed that
    way: the cache promise is that only a user action removes them.
    """
    c = _cache(tmp_path)
    c.write_meta(CacheMeta(object_id=80888, path="/r/80888", source_duration=12615,
                           pinned=True, paused=True, info={"title": "NFL Football"}))

    asyncio.run(c.register(80888, "/r/80888", 12700))   # device reports a new duration

    meta = c.read_meta(80888)
    assert meta.pinned is True
    assert meta.paused is True
    assert meta.info == {"title": "NFL Football"}
    assert meta.source_duration == 12700   # the fact still updates


def test_a_re_registered_pinned_copy_is_still_exempt_from_eviction(tmp_path):
    """The consequence of the bug above, asserted end to end."""
    c = _cache(tmp_path, budget=1000)
    c.write_meta(CacheMeta(object_id=80888, path="/r/80888", source_duration=120,
                           pinned=True))
    _mark_done(c, 80888, 0, size=5000)

    asyncio.run(c.register(80888, "/r/80888", 180))
    c.make_room(0)

    assert c.read_meta(80888) is not None
    assert c.state(80888) is not CacheState.ABSENT


def test_a_window_a_viewer_waits_on_is_never_suspended(tmp_path):
    """Prefetch and a viewer race for the same window.

    If prefetch claims it first, the viewer's request attaches to that existing
    job - and going by the spawn-time flag suspended the very window being
    awaited. A cold open sat frozen for the whole segment timeout, returned 503,
    and took 53s to start playing.
    """
    c = _cache(tmp_path)

    class FakeProc:
        returncode = None
        def __init__(self): self.signals = []
        def send_signal(self, sig): self.signals.append(sig)

    waited, background = FakeProc(), FakeProc()
    # Both were started by prefetch, so both carry is_ondemand=False.
    c._procs[(80888, 0)] = (waited, False)
    c._procs[(80888, 5)] = (background, False)

    c._claim_ondemand((80888, 0))
    c._pause_background()

    assert signal.SIGSTOP not in waited.signals
    assert signal.SIGSTOP in background.signals


def test_claiming_a_suspended_window_wakes_it(tmp_path):
    """Skipping it in the suspend pass is not enough if it is already stopped."""
    c = _cache(tmp_path)

    class FakeProc:
        returncode = None
        def __init__(self): self.signals = []
        def send_signal(self, sig): self.signals.append(sig)

    proc = FakeProc()
    c._procs[(80888, 0)] = (proc, False)
    c._pause_background()                  # suspended as background work
    assert signal.SIGSTOP in proc.signals

    c._claim_ondemand((80888, 0))          # a viewer now needs it
    assert signal.SIGCONT in proc.signals


def test_a_prefetch_window_does_not_suspend_itself_when_demanded(tmp_path, monkeypatch):
    """The same race, at the moment the process starts.

    Prefetch spawns the window with on_demand=False. If a viewer claimed it in
    between, the spawn-time check suspended it immediately - so it produced
    nothing and the request timed out at 25s. Measured after the fix: the same
    cold open serves its first segment in 3.1s.
    """
    c = _cache(tmp_path)
    _register(c, oid=66219, duration=120)
    c._claim_ondemand((66219, 0))          # a viewer is waiting on window 0

    sent = []

    class P0:
        returncode = 0
        def send_signal(self, sig): sent.append(sig)
        async def wait(self): return 0

    async def fake_session(path):
        return {"playlist_url": "http://device/pl.m3u8"}

    async def fake_exec(*cmd, cwd=None, **kw):
        from pathlib import Path as _P
        for n in range(segments_in_window(120, 0)):
            (_P(cwd) / f"seg_{n:02d}.ts").write_bytes(b"x")
        return P0()

    c._start_session = fake_session
    real = asyncio.create_subprocess_exec
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    try:
        asyncio.run(c._encode_window(66219, 0, "/r/66219", 120, on_demand=False))
    finally:
        monkeypatch.setattr(asyncio, "create_subprocess_exec", real)

    assert signal.SIGSTOP not in sent


def test_scrubbing_away_abandons_the_previous_target(tmp_path):
    """A mis-aimed scrub must not hold the encoder at a place nobody wants."""
    c = _cache(tmp_path)
    killed = []
    c._kill_window = killed.append  # type: ignore[method-assign]

    for w in (10, 20, 30, 40, 90):
        c._claim_ondemand((66220, w))

    # The oldest target is abandoned; recent ones survive so clicking around
    # does not kill work still wanted.
    assert list(c._ondemand) == [(66220, 20), (66220, 30), (66220, 40), (66220, 90)]
    assert killed == [(66220, 10)]


def test_two_windows_per_recording_survive_for_normal_playback(tmp_path):
    """Playback holds the current window and the one it is rolling into."""
    c = _cache(tmp_path)
    c._kill_window = lambda _k: None  # type: ignore[method-assign]
    c._claim_ondemand((66220, 10))
    c._claim_ondemand((66220, 11))
    assert list(c._ondemand) == [(66220, 10), (66220, 11)]


def test_a_couple_of_clicks_do_not_trip_the_cap(tmp_path):
    """Two seeks cost a window or two each; they must not evict each other."""
    c = _cache(tmp_path)
    killed = []
    c._kill_window = killed.append  # type: ignore[method-assign]
    for w in (50, 51, 120, 121):
        c._claim_ondemand((66220, w))
    assert killed == []


def test_the_per_recording_cap_does_not_evict_other_recordings(tmp_path):
    c = _cache(tmp_path)
    c._kill_window = lambda _k: None  # type: ignore[method-assign]
    c._claim_ondemand((66220, 1))
    c._claim_ondemand((80888, 1))
    c._claim_ondemand((80888, 2))
    assert (66220, 1) in c._ondemand


def test_encoding_progress_counts_finished_segments(tmp_path):
    """Real progress toward playback, not a decorative spinner."""
    c = _cache(tmp_path)
    _register(c, oid=66220, duration=120)
    c._claim_ondemand((66220, 0))
    wd = c.window_dir(66220, 0)
    wd.mkdir(parents=True, exist_ok=True)
    (wd / "index.m3u8").write_text("#EXTM3U\nseg_00.ts\nseg_01.ts\nseg_02.ts\n")

    p = c.encoding_progress(66220)
    assert p["window"] == 0
    assert p["segments_ready"] == 3
    assert p["segments_total"] == segments_in_window(120, 0)


def test_encoding_progress_is_complete_once_the_window_is_done(tmp_path):
    c = _cache(tmp_path)
    _register(c, oid=66220, duration=120)
    c._claim_ondemand((66220, 0))
    _mark_done(c, 66220, 0)
    p = c.encoding_progress(66220)
    assert p["segments_ready"] == p["segments_total"]


def test_no_encoding_progress_when_nothing_is_on_demand(tmp_path):
    """A stall with no encode behind it must not claim to be transcoding."""
    c = _cache(tmp_path)
    _register(c, oid=66220, duration=120)
    assert c.encoding_progress(66220) is None


def test_watching_fills_to_the_end_of_the_recording_by_default(monkeypatch):
    """Twenty minutes of watching should encode the rest of the game to disk.

    The 30-window cap existed because eager filling once pinned every core - but
    that was libx264 at 780% CPU. On hardware the same fill costs ~78% and is
    bound by the device, so the idle watchdog is what prevents a runaway now.
    """
    import app.transcode_cache as tc
    monkeypatch.setattr(tc, "LOOKAHEAD_WINDOWS", 0)
    total = window_count(GAME)
    assert tc.fill_limit(0, total) == total
    assert tc.fill_limit(100, total) == total


def test_the_lookahead_can_still_be_bounded(monkeypatch):
    """Kept as an escape hatch for a machine that cannot afford the full fill."""
    import app.transcode_cache as tc
    monkeypatch.setattr(tc, "LOOKAHEAD_WINDOWS", 30)
    total = window_count(GAME)
    assert tc.fill_limit(0, total) == 30
    assert tc.fill_limit(total - 5, total) == total   # never past the end


def test_background_encoders_yield_the_device_on_hardware_too(tmp_path, monkeypatch):
    """The contended resource is the Tablo, which hardware encoding does not free.

    This was once gated to software encoders, on the grounds that hardware
    leaves no CPU to win back. True, and beside the point: the device serves
    about 10x realtime in total however the frames are encoded, so six streams
    get about 1.1x each. Measured on one seek - the window the viewer was
    waiting on took 55.7s at 1.1x while five prefetch streams ran beside it,
    against 17.5s at 3.4x for the window that had the device largely to itself.
    Playback consumes at 1x, so it rode the encode frontier the whole way.
    """
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "h264_videotoolbox")
    c = _cache(tmp_path)

    class FakeProc:
        returncode = None
        def __init__(self): self.signals = []
        def send_signal(self, sig): self.signals.append(sig)

    proc = FakeProc()
    c._procs[(66219, 5)] = (proc, False)
    c._claim_ondemand((66219, 1))
    c._pause_background()

    assert signal.SIGSTOP in proc.signals


def test_background_encoders_resume_once_nobody_is_waiting(tmp_path, monkeypatch):
    """Suspension must last exactly as long as someone is blocked on a window.

    Pausing is safe only because it always ends: every claim is released in a
    finally and the wait is bounded, so a suspended encoder cannot be stranded.
    """
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "h264_videotoolbox")
    c = _cache(tmp_path)

    class FakeProc:
        returncode = None
        def __init__(self): self.signals = []
        def send_signal(self, sig): self.signals.append(sig)

    proc = FakeProc()
    c._procs[(66219, 5)] = (proc, False)
    c._claim_ondemand((66219, 1))
    c._pause_background()
    c._resume_background()                  # still claimed: stays suspended
    assert signal.SIGCONT not in proc.signals

    c._release_ondemand((66219, 1))
    c._resume_background()
    assert signal.SIGCONT in proc.signals


def test_background_encoders_still_yield_on_software(tmp_path, monkeypatch):
    """With libx264 the CPU is contended as well, so this is doubly true."""
    monkeypatch.setenv("TRANSCODE_VIDEO_ENCODER", "libx264")
    c = _cache(tmp_path)

    class FakeProc:
        returncode = None
        def __init__(self): self.signals = []
        def send_signal(self, sig): self.signals.append(sig)

    proc = FakeProc()
    c._procs[(66219, 5)] = (proc, False)
    c._claim_ondemand((66219, 1))
    c._pause_background()

    assert signal.SIGSTOP in proc.signals


def test_prefetch_follows_a_seek_instead_of_finishing_the_old_batch():
    """Seeking away must abandon the batch, not grind through it.

    A batch runs the best part of a minute and the playhead used to be re-read
    only between batches. Observed: the fill working through 0:00-8:00 while the
    viewer sat at 17:30 waiting on an on-demand transcode - the cached bar grew
    steadily, nowhere near the playhead.
    """
    from app.transcode_cache import should_retarget

    filling = [0, 1, 2, 3, 4, 5]
    assert should_retarget(3, filling) is False     # still inside the batch
    assert should_retarget(6, filling) is False     # next window along
    assert should_retarget(17, filling) is True     # seeked forward
    assert should_retarget(200, filling) is True    # seeked far forward
    assert should_retarget(0, [10, 11, 12]) is True # seeked backwards
    assert should_retarget(5, []) is False          # nothing in flight


def test_running_ahead_of_the_playhead_is_not_a_seek_backwards():
    """Being ahead of the viewer is the goal, not a miss to be corrected.

    ``filling`` skips windows already on disk, so as soon as the fill gets ahead
    the batch starts past the playhead. Treating that as a backwards seek killed
    the batch, recomputed an identical one, and killed that too - every two
    seconds, forever. Observed with the viewer at 17:41 and w17 cached: the fill
    froze at 9:00 of a 3:55 game while playback rode a lone on-demand w18, its
    buffer draining from 0:22 to 0:10.
    """
    from app.transcode_cache import should_retarget

    ahead = [18, 19, 20]
    assert should_retarget(17, ahead, here_ready=True) is False
    # Same shape, but the viewer's own window is missing: they are waiting on a
    # gap behind the fill, which is a real seek backwards.
    assert should_retarget(17, ahead, here_ready=False) is True
    # Running past the batch still retargets however well cached it is.
    assert should_retarget(99, ahead, here_ready=True) is True


@pytest.mark.asyncio
async def test_a_heartbeat_revives_prefetch_that_is_not_running(tmp_path):
    """Prefetch must not depend on /watch being the one to start it.

    It was the only caller, so a backend restart mid-playback left prefetch dead
    for the rest of the session: the player kept polling /status and pulling
    segments, each window transcoded on demand one at a time, with no read-ahead
    and not one line in the log to say the fill was gone.
    """
    c = _cache(tmp_path)
    _register(c, oid=66220, duration=600)
    c.heartbeat(66220, 120.0)
    assert 66220 not in c._prefetch          # the state a restart leaves behind

    c.ensure_prefetch(66220)
    assert 66220 in c._prefetch
    await c.stop(66220)                      # cancels before the loop ever runs


@pytest.mark.asyncio
async def test_a_heartbeat_does_not_revive_a_paused_offline_copy(tmp_path):
    """Paused means "wanted, but not now" - a poll must not override that."""
    c = _cache(tmp_path)
    _register(c, oid=66220, duration=600)
    c.set_pinned(66220, True)
    c.set_paused(66220, True)

    c.ensure_prefetch(66220)
    assert 66220 not in c._prefetch


# ---------------------------------------------------------------------------
# What is recording right now
# ---------------------------------------------------------------------------

def _serving_recordings(monkeypatch, rows):
    """Stand in for the device listing, without touching it."""
    from app.routes import recordings as rec

    async def get_recordings(limit=200):
        return [AppState._recording_fields(r) for r in rows]

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "get_recordings", get_recordings)


def test_in_progress_lists_only_what_is_recording(monkeypatch):
    """Live and Guide ask this once and key it by (channel, start).

    Everything it carries is already computed for the full listing, so this is
    a projection rather than new arithmetic - and small enough to poll beside a
    guide that must not itself carry volatile recording state.
    """
    live = _with_offsets(30, start=1259, scheduled=3600)
    live["object_id"] = 86113
    _serving_recordings(monkeypatch, [DEVICE_RECORDING, live])

    body = client.get("/api/recordings/in-progress").json()

    assert [r["object_id"] for r in body["recordings"]] == [86113]
    row = body["recordings"][0]
    assert row["channel_identifier"] == "S34654_008_01"
    assert row["duration"] == 3600, "the scheduled slot the bar is drawn against"
    assert row["expected_seconds"] == 3600 - 1259
    assert row["recording_started"] is not None
    assert row["recorded_seconds"] == pytest.approx(30 * 60 - 1259, abs=5)


def test_one_recording_answers_in_the_shape_the_player_takes(monkeypatch):
    """The player is handed a recording, not an id.

    Opening it from the Guide or a series panel means fetching that one
    recording; listing the whole library to find it is a device walk per click.
    """
    from app.routes import recordings as rec

    async def snapshot(object_id):
        assert object_id == 80888
        return AppState._recording_fields(DEVICE_RECORDING)

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "recording_snapshot", snapshot)

    r = client.get("/api/recordings/80888")

    assert r.status_code == 200
    body = r.json()
    assert body["object_id"] == 80888
    assert body["title"] == "NFL Football"
    # Decorated like a listing row, because that is what the player reads.
    assert "cache_state" in body
    assert "pinned" in body


def test_a_recording_the_device_does_not_have_is_a_404(monkeypatch):
    from app.routes import recordings as rec

    async def snapshot(object_id):
        raise KeyError(object_id)

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "recording_snapshot", snapshot)

    assert client.get("/api/recordings/999999").status_code == 404


def test_in_progress_carries_the_guide_series_it_belongs_to(monkeypatch):
    """So the sheet can tell that *this* series is the one recording.

    Looked up in the mirror rather than taken from the recording: a recording's
    own `series_path` is `/recordings/series/{id}`, a different namespace from
    the guide's `/guide/series/{id}` that the sheet holds. Comparing the two
    directly matches nothing.
    """
    from app import store

    live = _with_offsets(30, start=1259, scheduled=3600)
    live["object_id"] = 86113
    _serving_recordings(monkeypatch, [live])
    store.save_guide([{
        "identifier": "S34654_008_01",
        "airings": [{
            "start": AppState._recording_fields(live)["start"],
            "duration": 3600,
            "title": "Let's Make a Deal",
            "series_path": "/guide/series/5954",
            "airing_path": "/guide/series/episodes/74075",
        }],
    }])

    row = client.get("/api/recordings/in-progress").json()["recordings"][0]

    assert row["series_path"] == "/guide/series/5954"


def test_in_progress_says_nothing_about_a_series_the_mirror_never_saw(monkeypatch):
    """An airing the guide has no row for still recording is not an error."""
    live = _with_offsets(30, start=1259, scheduled=3600)
    live["object_id"] = 86113
    _serving_recordings(monkeypatch, [live])

    row = client.get("/api/recordings/in-progress").json()["recordings"][0]

    assert row["series_path"] is None


# ---------------------------------------------------------------------------
# Deleting on the device
#
# Mapped by probing a real Tablo on 2026-09-18: DELETE on the recording's own
# path answers 204, and a GET afterwards answers 404 object_not_found. Nothing
# in docs/tablo-api.md described it before that.
# ---------------------------------------------------------------------------

def test_deleting_a_recording_asks_the_device_to_delete_it(monkeypatch):
    from app import store
    from app.routes import recordings as rec

    called = {}

    async def resolve(object_id):
        return f"/recordings/series/episodes/{object_id}", 3600

    async def delete_device(path):
        called["path"] = path

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    monkeypatch.setattr(rec.state, "delete_recording", delete_device)
    store.index_recording_airings([{
        "object_id": 86353, "start": "2026-09-18T07:00Z",
        "channel": {"identifier": "S34654_008_01"},
    }])

    r = client.delete("/api/recordings/86353")

    assert r.status_code == 200
    assert called["path"] == "/recordings/series/episodes/86353"


def test_a_deleted_recording_leaves_nothing_behind_locally(monkeypatch):
    """The local traces outlive the device record otherwise: a search result
    that fails when clicked, and an info sheet still offering to delete it."""
    from app import store
    from app.routes import recordings as rec

    async def resolve(object_id):
        return "/recordings/series/episodes/86353", 3600

    async def delete_device(path):
        return None

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    monkeypatch.setattr(rec.state, "delete_recording", delete_device)
    store.index_recording_airings([{
        "object_id": 86353, "start": "2026-09-18T07:00Z",
        "channel": {"identifier": "S34654_008_01"},
    }])

    client.delete("/api/recordings/86353")

    assert store.recording_for_airing("S34654_008_01", "2026-09-18T07:00Z") is None


def test_deleting_something_the_device_does_not_have_is_a_404(monkeypatch):
    from app.routes import recordings as rec

    async def resolve(object_id):
        raise KeyError(object_id)

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)

    assert client.delete("/api/recordings/999999").status_code == 404


def test_a_refused_delete_keeps_the_local_record(monkeypatch):
    """If the device would not delete it, it still exists - and the sheet has
    to keep saying so."""
    from app import store
    from app.routes import recordings as rec

    async def resolve(object_id):
        return "/recordings/series/episodes/86353", 3600

    async def delete_device(path):
        raise RuntimeError("device refused")

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    monkeypatch.setattr(rec.state, "delete_recording", delete_device)
    store.index_recording_airings([{
        "object_id": 86353, "start": "2026-09-18T07:00Z",
        "channel": {"identifier": "S34654_008_01"},
    }])

    r = client.delete("/api/recordings/86353")

    assert r.status_code == 502
    assert store.recording_for_airing("S34654_008_01", "2026-09-18T07:00Z") == 86353


def test_in_progress_is_empty_rather_than_absent(monkeypatch):
    """Nothing recording is the ordinary case, and not an error."""
    _serving_recordings(monkeypatch, [DEVICE_RECORDING])

    r = client.get("/api/recordings/in-progress")

    assert r.status_code == 200
    assert r.json() == {"recordings": []}


# ---------------------------------------------------------------------------
# Playback position, written back to the device
# ---------------------------------------------------------------------------

def _device_accepting_patch(monkeypatch):
    """Capture what gets PATCHed, without a device."""
    from app.routes import recordings as rec
    sent: list[tuple[str, dict]] = []

    async def patch_device(path, payload):
        sent.append((path, payload))
        return 200, {"user_info": {"position": payload.get("position", 0)}}

    async def resolve(_oid):
        return "/recordings/series/episodes/86113", 3600

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "patch_device", patch_device)
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    return sent


def test_position_is_written_to_the_device_in_the_flat_shape(monkeypatch):
    """The shape is not the one the GET returns, and the wrong one is silent.

    Verified against the device: {"position": 618} takes, while
    {"user_info": {"position": 618}} - exactly what the read hands back -
    answers 200 and changes nothing. That is how this ships broken unnoticed.
    """
    sent = _device_accepting_patch(monkeypatch)

    r = client.post("/api/recordings/86113/position", json={"position": 618})

    assert r.status_code == 200
    assert sent == [("/recordings/series/episodes/86113", {"position": 618})]


def test_a_negative_position_is_refused(monkeypatch):
    sent = _device_accepting_patch(monkeypatch)
    assert client.post("/api/recordings/86113/position",
                       json={"position": -5}).status_code == 422
    assert sent == []


def test_watched_is_written_to_the_device_in_the_flat_shape(monkeypatch):
    """Same trap as `position`, and the device never sets this itself.

    Measured: a recording played to 43% still read `watched: false`, and so did
    one played to its end. Nothing marks it but us.
    """
    sent = _device_accepting_patch(monkeypatch)

    r = client.post("/api/recordings/86113/watched", json={"watched": True})

    assert r.status_code == 200
    assert sent == [("/recordings/series/episodes/86113", {"watched": True})]


def test_watched_can_be_taken_back(monkeypatch):
    sent = _device_accepting_patch(monkeypatch)
    assert client.post("/api/recordings/86113/watched",
                       json={"watched": False}).status_code == 200
    assert sent == [("/recordings/series/episodes/86113", {"watched": False})]


# ---------------------------------------------------------------------------
# The series behind a recording, for the card shown at its end
# ---------------------------------------------------------------------------

def _device_serving_series(monkeypatch, *, series_path="/recordings/series/86119"):
    from app.routes import recordings as rec
    asked: list[str] = []

    async def request_device(_method, path):
        asked.append(path)
        if path.endswith("/episodes/86128"):
            return {"object_id": 86128, "series_path": series_path}
        return {
            "object_id": 86119,
            "series": {
                "title": "Carl the Collector",
                "cover_image": {"image_id": 9345, "has_title": True},
                "thumbnail_image": {"image_id": 9344},
                "background_image": {"image_id": 9346},
            },
        }

    async def resolve(_oid):
        return "/recordings/series/episodes/86128", 1875

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "request_device", request_device)
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    return asked


def test_the_series_cover_comes_from_the_series_record(monkeypatch):
    """A recording carries no `series` object, only a path to one.

    Measured on the device: `series` is null on an episode record, so the cover
    is one fetch further away and cannot be had while listing.
    """
    asked = _device_serving_series(monkeypatch)

    r = client.get("/api/recordings/86128/series")

    assert r.status_code == 200
    assert r.json() == {
        "series_path": "/recordings/series/86119",
        "title": "Carl the Collector",
        "cover_image": 9345,
    }
    assert asked == ["/recordings/series/episodes/86128", "/recordings/series/86119"]


def test_a_game_follows_its_sport_for_a_cover(monkeypatch):
    """A sport is a series under a different noun.

    `/recordings/sports/{id}` carries a title, a description, the same three
    images and its own airing count, and the Tablo app heads its sheet "Series
    Recording Scheduled" over the league's picture. Asking only for
    `series_path` is why every NFL recording had nothing to lead with.
    """
    from app.routes import recordings as rec
    asked: list[str] = []

    async def request_device(_method, path):
        asked.append(path)
        if path.endswith("/events/80888"):
            return {"object_id": 80888, "sport_path": "/recordings/sports/63558"}
        return {
            "object_id": 63558,
            "sport": {
                "title": "NFL Football",
                "cover_image": {"image_id": 38765, "has_title": True},
                "thumbnail_image": {"image_id": 38764},
                "background_image": {"image_id": 38766},
            },
        }

    async def resolve(_oid):
        return "/recordings/sports/events/80888", 12615

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "request_device", request_device)
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)

    r = client.get("/api/recordings/80888/series")

    assert r.status_code == 200
    assert r.json() == {
        "series_path": "/recordings/sports/63558",
        "title": "NFL Football",
        "cover_image": 38765,
    }
    assert asked == ["/recordings/sports/events/80888", "/recordings/sports/63558"]


def test_a_game_carries_the_path_that_groups_it():
    """Projected so the card can file six games together without matching on a
    title, which two different shows could share."""
    data = dict(DEVICE_RECORDING, sport_path="/recordings/sports/63558")
    out = AppState._recording_fields(data)
    assert out["sport_path"] == "/recordings/sports/63558"
    assert out["series_path"] is None


def test_a_recording_with_no_series_asks_the_device_only_once(monkeypatch):
    """Sport has no series record. That is ordinary, not an error.

    The card still lists the other recordings - they group by title - it simply
    has no poster to lead with.
    """
    asked = _device_serving_series(monkeypatch, series_path=None)

    r = client.get("/api/recordings/86128/series")

    assert r.status_code == 200
    assert r.json()["cover_image"] is None
    assert asked == ["/recordings/series/episodes/86128"]


# ---------------------------------------------------------------------------
# The info sheet for a recording, owing the guide nothing
# ---------------------------------------------------------------------------

# Trimmed from a real game record, read off the device 2026-09-18. The shape of
# what is *absent* is the point: no artwork, no genres, no rating anywhere on
# the recording itself. An earlier draft of the route read `genres` off `event`
# and would have returned [] forever without ever failing a test.
DEVICE_GAME = {
    "object_id": 66220,
    "path": "/recordings/sports/events/66220",
    "sport_path": "/recordings/sports/63558",
    "snapshot_image": {"image_id": 80894, "has_title": True},
    "airing_details": {
        "datetime": "2026-09-13T20:25Z",
        "duration": 11100,
        "show_title": "NFL Football",
        "channel": {
            "object_id": 5663,
            "path": "/recordings/channels/5663",
            "channel": {
                "call_sign": "KPAX", "network": "CBS",
                "major": 8, "minor": 1,
                "channel_identifier": "S34654_008_01",
                "source": "ota",
                "logos": [
                    {"kind": "darkLarge", "url": "https://cdn.example/CBS_black.png"},
                    {"kind": "originalLarge", "url": "https://cdn.example/CBS_mod.png"},
                ],
            },
        },
    },
    "video_details": {
        "state": "finished", "duration": 12915,
        "width": 1920, "height": 1080, "error": None,
        "recorded_offsets": {"start": -15, "end": 1800},
    },
    "user_info": {"position": 3, "watched": False, "protected": False},
    "event": {
        "title": "Green Bay Packers at Minnesota Vikings",
        "description": "The Minnesota Vikings host the Green Bay Packers.",
        "teams": [{"name": "Green Bay Packers", "team_id": 42}],
        "venue": "U.S. Bank Stadium",
        "tms_id": "EP000031285690",
    },
}

DEVICE_SPORT = {
    "object_id": 63558,
    "path": "/recordings/sports/63558",
    "guide_path": "/guide/sports/38763",
    "sport": {
        "title": "NFL Football",
        "description": "Football action from around the National Football League.",
        "genres": ["Football"],
        "cover_image": {"image_id": 38765, "has_title": True},
        "thumbnail_image": {"image_id": 38764},
        "background_image": {"image_id": 38766},
    },
}


def _device_serving(monkeypatch, records: dict, path: str):
    from app.routes import recordings as rec
    asked: list[str] = []

    async def request_device(_method, p):
        asked.append(p)
        return records[p]

    async def resolve(_oid):
        return path, 12915

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "request_device", request_device)
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    return asked


def test_a_recording_describes_itself_without_the_guide(monkeypatch):
    """The whole sheet, from two device reads and nothing else.

    Measured 2026-09-18: the guide mirror held no airing older than the 15th
    while these games, from the 13th, were still in the library - so every one
    of their sheets read "Information unavailable". The device had all of this
    the entire time.
    """
    asked = _device_serving(
        monkeypatch,
        {"/recordings/sports/events/66220": DEVICE_GAME,
         "/recordings/sports/63558": DEVICE_SPORT},
        "/recordings/sports/events/66220",
    )

    r = client.get("/api/recordings/66220/detail")

    assert r.status_code == 200
    d = r.json()
    assert d["title"] == "NFL Football"
    assert d["episode_title"] == "Green Bay Packers at Minnesota Vikings"
    assert d["description"].startswith("The Minnesota Vikings host")
    assert d["start"] == "2026-09-13T20:25Z"
    assert d["duration"] == 12915
    assert d["recording_id"] == 66220
    assert asked == ["/recordings/sports/events/66220", "/recordings/sports/63558"]


def test_the_picture_genres_and_rating_come_from_the_show_record(monkeypatch):
    """None of the three is on the recording. Verified against every recording
    on a real device: an episode record carries only `episode`, a game record
    only `event`, and neither holds artwork, genres or a rating."""
    _device_serving(
        monkeypatch,
        {"/recordings/sports/events/66220": DEVICE_GAME,
         "/recordings/sports/63558": DEVICE_SPORT},
        "/recordings/sports/events/66220",
    )

    d = client.get("/api/recordings/66220/detail").json()

    assert d["image_url"] == "/api/channels/image/38765"
    assert d["genres"] == ["Football"]
    # A sport has no `series_rating`. Absent, not guessed at.
    assert d["rating"] is None


def test_a_series_recording_takes_its_rating_from_the_series(monkeypatch):
    """The other noun, and the one key that is not on both."""
    episode = {
        "object_id": 86040,
        "path": "/recordings/series/episodes/86040",
        "series_path": "/recordings/series/86041",
        "airing_details": {
            "datetime": "2026-09-16T22:00Z", "duration": 3600,
            "show_title": "First Civilizations",
            "channel": {"channel": {
                "call_sign": "KUFM", "network": "PBS", "major": 11, "minor": 1,
                "channel_identifier": "S34654_011_01", "source": "ota",
            }},
        },
        "video_details": {"state": "finished", "duration": 3615, "height": 1080},
        "episode": {
            "title": "Ritual", "number": 2, "season_number": 1,
            "description": "How ritual built the first towns.",
            "orig_air_date": "2018-05-01",
        },
        "user_info": {},
    }
    series = {
        "object_id": 86041,
        "path": "/recordings/series/86041",
        "series": {
            "title": "First Civilizations",
            "description": "The history of the first civilizations.",
            "genres": ["Documentary", "History"],
            "series_rating": "tvpg",
            "orig_air_date": "2018-04-24",
            "cover_image": {"image_id": 53983, "has_title": True},
        },
    }
    _device_serving(
        monkeypatch,
        {"/recordings/series/episodes/86040": episode,
         "/recordings/series/86041": series},
        "/recordings/series/episodes/86040",
    )

    d = client.get("/api/recordings/86040/detail").json()

    assert d["rating"] == "tvpg"
    assert d["genres"] == ["Documentary", "History"]
    assert (d["season_number"], d["episode_number"]) == (1, 2)
    # The episode's own air date, not the series premiere sitting beside it.
    assert d["orig_air_date"] == "2018-05-01"
    assert d["image_url"] == "/api/channels/image/53983"


def test_the_channel_eyebrow_reads_the_nested_channel(monkeypatch):
    """`_recording_fields` narrows this to four keys for the Library card and
    drops the number parts and the logos the sheet wants, so the route reads
    the raw block instead."""
    _device_serving(
        monkeypatch,
        {"/recordings/sports/events/66220": DEVICE_GAME,
         "/recordings/sports/63558": DEVICE_SPORT},
        "/recordings/sports/events/66220",
    )

    ch = client.get("/api/recordings/66220/detail").json()["channel"]

    assert ch == {
        "identifier": "S34654_008_01",
        "call_sign": "KPAX",
        "major": 8,
        "minor": 1,
        "network": "CBS",
        "logo_url": "https://cdn.example/CBS_mod.png",
        # The device says `source` where the guide mirror says `kind`.
        "kind": "ota",
    }


def test_nothing_on_a_recording_sheet_is_offered_as_schedulable(monkeypatch):
    """Every one of those controls writes through `(channel, start)` against the
    guide. With no listing there is nothing to address, and an Edit Series
    Recording box that cannot write is worse than none."""
    _device_serving(
        monkeypatch,
        {"/recordings/sports/events/66220": DEVICE_GAME,
         "/recordings/sports/63558": DEVICE_SPORT},
        "/recordings/sports/events/66220",
    )

    d = client.get("/api/recordings/66220/detail").json()

    assert d["schedulable"] is False
    assert d["scheduled"] is False
    assert d["series"] is None
    assert d["past"] is True
    assert d["airing_now"] is False


def test_a_recording_still_on_a_tuner_says_so(monkeypatch):
    """`airing_now` off the recording means "still capturing". The sheet takes
    the guide's answer over this one whenever it has a listing."""
    live = {**DEVICE_GAME,
            "video_details": {**DEVICE_GAME["video_details"], "state": "recording"}}
    _device_serving(
        monkeypatch,
        {"/recordings/sports/events/66220": live,
         "/recordings/sports/63558": DEVICE_SPORT},
        "/recordings/sports/events/66220",
    )

    d = client.get("/api/recordings/66220/detail").json()

    assert d["airing_now"] is True
    assert d["past"] is False


def test_a_show_record_that_will_not_load_still_leaves_a_usable_sheet(monkeypatch):
    """The title and the blurb are what someone opened it for. Losing the
    picture is not worth losing those."""
    from app.routes import recordings as rec

    async def request_device(_method, p):
        if p == "/recordings/sports/events/66220":
            return DEVICE_GAME
        raise RuntimeError("device said no")

    async def resolve(_oid):
        return "/recordings/sports/events/66220", 12915

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "request_device", request_device)
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)

    r = client.get("/api/recordings/66220/detail")

    assert r.status_code == 200
    d = r.json()
    assert d["title"] == "NFL Football"
    assert d["description"].startswith("The Minnesota Vikings host")
    assert d["image_url"] is None
    assert d["genres"] == []


def test_a_library_card_falls_back_to_its_show_cover(monkeypatch):
    """The Library card had the same fault the sheet did, quieter.

    `resolve_recording_art` read the guide and nothing else, so anything whose
    airing the mirror no longer held resolved to nothing forever - retried and
    failed on every listing. Measured 2026-09-18: all six NFL recordings sat
    with an empty `cover_url` while the device had the league's picture the
    whole time, one read away behind `sport_path`.
    """
    from app.routes import recordings as rec
    asked: list[str] = []

    async def get_recordings(limit=200):
        return [AppState._recording_fields(dict(
            DEVICE_GAME, object_id=oid,
            path=f"/recordings/sports/events/{oid}",
        )) for oid in (66220, 66221)]

    async def request_device(_method, path):
        asked.append(path)
        return DEVICE_SPORT

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "get_recordings", get_recordings)
    monkeypatch.setattr(rec.state, "request_device", request_device)

    body = client.get("/api/recordings").json()

    assert [r["image_url"] for r in body["recordings"]] == \
        ["/api/channels/image/38765"] * 2
    # One read for the sport both games share, not one per game. Six NFL
    # recordings are exactly the case this exists for.
    assert asked == ["/recordings/sports/63558"]


def test_a_settled_library_asks_the_device_for_no_covers_at_all(monkeypatch):
    """Resolved once and kept, so the device read happens on the first listing
    that needs it and on none of the ones after."""
    from app.routes import recordings as rec
    asked: list[str] = []

    async def get_recordings(limit=200):
        return [AppState._recording_fields(DEVICE_GAME)]

    async def request_device(_method, path):
        asked.append(path)
        return DEVICE_SPORT

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "get_recordings", get_recordings)
    monkeypatch.setattr(rec.state, "request_device", request_device)

    client.get("/api/recordings")
    client.get("/api/recordings")

    assert asked == ["/recordings/sports/63558"]


def test_a_show_record_the_device_will_not_serve_costs_a_card_nothing_else(monkeypatch):
    """Artwork is the only thing at stake here. The listing is not."""
    from app.routes import recordings as rec

    async def get_recordings(limit=200):
        return [AppState._recording_fields(DEVICE_GAME)]

    async def request_device(_method, _path):
        raise RuntimeError("device said no")

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "get_recordings", get_recordings)
    monkeypatch.setattr(rec.state, "request_device", request_device)

    body = client.get("/api/recordings").json()

    assert len(body["recordings"]) == 1
    assert body["recordings"][0]["image_url"] is None


def test_a_copy_kept_after_deletion_still_describes_itself(monkeypatch, tmp_path):
    """The longest-lived recording there is, and the case that decides the rule.

    The device cannot be asked - that is the point of pinning one - so the sheet
    answers from the snapshot taken when it was pinned and the artwork already
    resolved for its card. A recording describes itself, or eventually nothing
    describes it.
    """
    from app import store
    from app.routes import recordings as rec

    c = _cache(tmp_path)
    meta = _register(c, oid=66220)
    meta.pinned = True
    meta.info = AppState._recording_fields(DEVICE_GAME)
    c.write_meta(meta)
    store.resolve_recording_art([meta.info],
                                fallback={66220: "/api/channels/image/38765"})

    async def resolve(_oid):
        raise KeyError("recording 66220 not found")

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    monkeypatch.setattr(rec, "cache", c)

    r = client.get("/api/recordings/66220/detail")

    assert r.status_code == 200
    d = r.json()
    assert d["title"] == "NFL Football"
    assert d["episode_title"] == "Green Bay Packers at Minnesota Vikings"
    assert d["description"].startswith("The Minnesota Vikings host")
    assert d["image_url"] == "/api/channels/image/38765"
    assert d["duration"] == 12915
    # The number is stored as one "8.1" string for the card; the eyebrow wants
    # the parts.
    assert (d["channel"]["major"], d["channel"]["minor"]) == (8, 1)
    assert d["past"] is True


def test_a_recording_the_device_does_not_have_is_a_404(monkeypatch, tmp_path):
    """Gone on the device and never kept offline: nothing to describe."""
    from app.routes import recordings as rec

    async def resolve(_oid):
        raise KeyError("recording 999 not found")

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    monkeypatch.setattr(rec, "cache", _cache(tmp_path))

    assert client.get("/api/recordings/999/detail").status_code == 404


# ---------------------------------------------------------------------------
# What a Library card leads with
# ---------------------------------------------------------------------------

def test_an_airing_leads_with_its_own_artwork():
    """The episode's picture beats the series cover, which is about the run.

    It is also the only artwork an OTT airing has, and - since the cloud's
    per-event pictures started filling the gap for OTA sport - the only thing
    that tells two NFL games apart.
    """
    from app.store import airing_artwork
    assert airing_artwork("https://cdn/bengals-steelers.jpg", 2706) == \
        "https://cdn/bengals-steelers.jpg"


def test_an_airing_with_no_picture_falls_to_the_series_cover():
    from app.store import airing_artwork
    assert airing_artwork(None, 2706) == "/api/channels/image/2706"


def test_an_airing_with_neither_has_no_artwork():
    """Ordinary for sport, whose airing has aged out of the guide. The card
    falls back to the snapshot frame it has always used."""
    from app.store import airing_artwork
    assert airing_artwork(None, None) is None


def test_the_cover_frame_is_written_as_milliseconds(monkeypatch):
    """A position, not a picture: the frame is already on disk in the BIF pack
    the scrub preview reads, so an override copies nothing."""
    from app.routes import recordings as rec
    written: list[tuple] = []

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.store, "set_recording_frame",
                        lambda oid, ms: written.append((oid, ms)))

    r = client.post("/api/recordings/86113/cover", json={"t": 612.5})

    assert r.status_code == 200
    assert written == [(86113, 612500)]


def test_clearing_the_cover_puts_the_artwork_back(monkeypatch):
    from app.routes import recordings as rec
    written: list[tuple] = []

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.store, "set_recording_frame",
                        lambda oid, ms: written.append((oid, ms)))

    r = client.delete("/api/recordings/86113/cover")

    assert r.status_code == 200
    assert written == [(86113, None)]


def test_a_negative_cover_position_is_refused(monkeypatch):
    from app.routes import recordings as rec
    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    assert client.post("/api/recordings/86113/cover",
                       json={"t": -1}).status_code == 422


# ---------------------------------------------------------------------------
# Artwork the recording actually owns
# ---------------------------------------------------------------------------

JPEG = b"\xff\xd8\xff\xe0" + b"pretend this is a picture" * 40
CDN = "https://lighthousetv-cdn.ewscloud.com/assets/GNLZZGG0039L2CP.jpg?w=1280"


def _listing(monkeypatch, rows, *, fetched: list | None = None,
             cdn_body=JPEG, device_body=JPEG):
    """The library listing, with the device and the CDN both stood in for."""
    from app.routes import recordings as rec

    async def get_recordings(limit=200):
        return [AppState._recording_fields(r) for r in rows]

    async def request_device(_method, path):
        if path == "/recordings/sports/63558":
            return DEVICE_SPORT
        raise RuntimeError(f"unexpected device path {path}")

    async def fetch_device_image(image_id):
        if fetched is not None:
            fetched.append(f"device:{image_id}")
        if device_body is None:
            raise RuntimeError("device image gone")
        return device_body, "image/jpeg"

    class FakeHttp:
        async def get(self, url, **_kw):
            if fetched is not None:
                fetched.append(url)
            if cdn_body is None:
                raise RuntimeError("cdn gone")
            return SimpleNamespace(
                content=cdn_body, raise_for_status=lambda: None,
            )

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "get_recordings", get_recordings)
    monkeypatch.setattr(rec.state, "request_device", request_device)
    monkeypatch.setattr(rec.state, "fetch_device_image", fetch_device_image)
    monkeypatch.setattr(type(rec.state), "http", property(lambda _s: FakeHttp()))


def test_a_cards_picture_is_bytes_we_hold_not_a_url_we_hope_about(monkeypatch):
    """The whole point. A resolved URL is either someone else's CDN or a proxy
    to the Tablo, and a recording is kept because neither can be relied on."""
    _listing(monkeypatch, [DEVICE_GAME])

    body = client.get("/api/recordings").json()
    card = body["recordings"][0]

    assert card["image_url"] == "/api/recordings/66220/art"
    assert "lighthousetv" not in str(card["image_url"])
    assert store.cover_bytes(66220) == JPEG


def test_the_picture_outlives_the_place_it_came_from(monkeypatch):
    """A protected recording can outlive a CDN asset by years. Once the bytes
    are in hand, losing the source must change nothing at all."""
    _listing(monkeypatch, [DEVICE_GAME])
    client.get("/api/recordings")
    assert store.cover_bytes(66220) == JPEG

    # Now both sources fail, exactly as they will one day.
    _listing(monkeypatch, [DEVICE_GAME], cdn_body=None, device_body=None)

    card = client.get("/api/recordings").json()["recordings"][0]
    assert card["image_url"] == "/api/recordings/66220/art"
    assert client.get("/api/recordings/66220/art").content == JPEG


def test_a_picture_already_held_is_never_fetched_again(monkeypatch):
    """A settled library costs nothing: no CDN traffic, no device traffic."""
    fetched: list[str] = []
    _listing(monkeypatch, [DEVICE_GAME], fetched=fetched)

    client.get("/api/recordings")
    first = len(fetched)
    client.get("/api/recordings")

    assert first == 1, fetched
    assert len(fetched) == first, "a second listing re-fetched the picture"


def test_reclaiming_disk_never_takes_the_artwork(tmp_path):
    """The reason artwork lives beside the database rather than in the cache.

    `evict` rmtree's a recording's cache directory to reclaim space. The media
    is gigabytes and can be pulled from the device again; the picture is tens
    of kilobytes and, once the guide has moved on, can be pulled from nowhere.
    """
    from app.transcode_cache import CacheMeta, TranscodeCache

    async def never(_path):  # pragma: no cover - guard
        raise AssertionError("no session should start")

    c = TranscodeCache(session_starter=never, root=tmp_path, budget_bytes=10**9)
    c.write_meta(CacheMeta(object_id=66220, path="/recordings/x/66220",
                           source_duration=100))
    store.store_cover(66220, JPEG, CDN)

    assert c.evict(66220) is True
    assert store.cover_bytes(66220) == JPEG, "eviction took the artwork with it"


def test_forgetting_the_recording_is_the_one_thing_that_drops_it():
    store.store_cover(66220, JPEG, CDN)
    store.forget_recording(66220)
    assert store.cover_bytes(66220) is None


def test_a_half_written_picture_never_replaces_a_good_one():
    """Written to a temporary file and renamed, so a crash leaves the old
    picture or none - not half a JPEG that renders broken for ever."""
    store.store_cover(66220, JPEG, CDN)
    assert not list(store.artwork_dir().glob("*.part"))
    assert store.cover_path(66220).read_bytes() == JPEG


def test_artwork_with_nothing_stored_is_a_404(monkeypatch):
    from app.routes import recordings as rec
    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    assert client.get("/api/recordings/424242/art").status_code == 404


def test_a_guide_cover_is_pulled_from_the_cdn_and_then_never_again(monkeypatch):
    """The per-game picture, which is the only thing that tells two NFL games
    apart - and the one most certain to stop resolving one day."""
    fetched: list[str] = []
    store.save_guide([{
        "identifier": "S34654_008_01",
        "airings": [{
            "start": AppState._recording_fields(DEVICE_GAME)["start"],
            "duration": 11100, "title": "NFL Football", "image_url": CDN,
        }],
    }])
    _listing(monkeypatch, [DEVICE_GAME], fetched=fetched)

    card = client.get("/api/recordings").json()["recordings"][0]

    assert fetched == [CDN], "the per-game picture came from somewhere else"
    assert card["image_url"] == "/api/recordings/66220/art"
    assert store.cover_bytes(66220) == JPEG


def test_a_device_cover_is_pulled_straight_from_the_device(monkeypatch):
    """A series resolves to `/api/channels/image/{id}`. Fetching that through
    our own proxy would be this process calling itself."""
    fetched: list[str] = []
    episode = dict(DEVICE_GAME)
    _listing(monkeypatch, [episode], fetched=fetched)
    client.get("/api/recordings")

    assert fetched == ["device:38765"]
    assert store.cover_bytes(66220) == JPEG


def test_a_source_that_blinks_is_tried_again_next_listing(monkeypatch):
    """Nothing is forgotten: the row keeps its `cover_url`, and every listing
    is another chance to make the picture permanent."""
    _listing(monkeypatch, [DEVICE_GAME], cdn_body=None, device_body=None)
    body = client.get("/api/recordings").json()

    # Meanwhile the card shows the URL it resolved, rather than nothing.
    assert body["recordings"][0]["image_url"] == "/api/channels/image/38765"
    assert store.cover_bytes(66220) is None

    _listing(monkeypatch, [DEVICE_GAME])
    card = client.get("/api/recordings").json()["recordings"][0]
    assert card["image_url"] == "/api/recordings/66220/art"


# ---------------------------------------------------------------------------
# The preview pack, which a chosen cover frame points into
# ---------------------------------------------------------------------------

def _bif(frames: list[tuple[int, bytes]]) -> bytes:
    """A minimal BIF: magic, version, count, interval, index, then payloads."""
    head = _BIF_MAGIC + struct.pack("<II", 0, len(frames)) + struct.pack("<I", 10000)
    head += b"\x00" * (64 - len(head))
    offset = 64 + (len(frames) + 1) * 8
    index, payload = b"", b""
    for ts, body in frames:
        index += struct.pack("<II", ts, offset + len(payload))
        payload += body
    index += struct.pack("<II", 0xFFFFFFFF, offset + len(payload))
    return head + index + payload


def test_reclaiming_disk_never_takes_the_preview_pack(tmp_path):
    """A chosen cover picture is stored as a *position* into this pack, not as
    a copy of the frame. A position is only as durable as what it indexes, and
    this used to live in the directory `evict` rmtree's - so a card whose
    picture the viewer had deliberately picked went blank the first time the
    cache came under pressure.
    """
    async def never(_path):  # pragma: no cover - guard
        raise AssertionError("no session should start")

    c = TranscodeCache(session_starter=never, root=tmp_path, budget_bytes=10**9)
    c.write_meta(CacheMeta(object_id=66220, path="/recordings/x/66220",
                           source_duration=100))
    c.bif_path(66220).write_bytes(_bif([(0, b"\xff\xd8frame-zero")]))
    assert c.preview_available(66220)

    assert c.evict(66220) is True

    assert c.preview_available(66220), "eviction took the preview pack with it"
    assert c.preview_frame(66220, 0) == b"\xff\xd8frame-zero"


def test_a_pack_written_to_the_old_place_is_moved_rather_than_refetched(tmp_path):
    """Packs run 3-14 MB and come off the device. Anything already on disk is
    moved into the durable store on first use."""
    async def never(_path):  # pragma: no cover - guard
        raise AssertionError("no session should start")

    c = TranscodeCache(session_starter=never, root=tmp_path, budget_bytes=10**9)
    legacy = c.dir_for(66220) / "preview.bif"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_bytes(_bif([(0, b"\xff\xd8old-frame")]))

    assert c.preview_frame(66220, 0) == b"\xff\xd8old-frame"
    assert not legacy.exists(), "the pack was copied rather than moved"
    assert store.preview_path(66220).is_file()


def test_forgetting_the_recording_drops_its_preview_pack(tmp_path):
    """The one thing that may remove it."""
    async def never(_path):  # pragma: no cover - guard
        raise AssertionError("no session should start")

    c = TranscodeCache(session_starter=never, root=tmp_path, budget_bytes=10**9)
    c.bif_path(66220).write_bytes(_bif([(0, b"\xff\xd8frame")]))

    store.forget_recording(66220)

    assert not store.preview_path(66220).exists()


# ---------------------------------------------------------------------------
# Forgetting the assets of recordings the device no longer has
# ---------------------------------------------------------------------------

def _asset(object_id: int) -> None:
    """A recording with both durable assets on disk."""
    store.store_cover(object_id, JPEG, CDN)
    store.preview_path(object_id).write_bytes(b"\x89BIF\r\n\x1a\n" + b"\x00" * 56)


def test_a_recording_deleted_in_the_tablo_app_stops_costing_disk():
    """`forget_recording` is called from exactly one place - deleting through
    our own UI - so anything deleted on the device itself leaked for ever.

    Measured on a real library 2026-09-19: 22 `recording_art` rows against 20
    recordings, and an orphaned preview pack. This leaks in ordinary use.
    """
    _asset(66220)
    _asset(86323)

    gone = store.prune_recording_assets([{"object_id": 66220}])

    assert gone == [86323]
    assert store.cover_bytes(66220) == JPEG
    assert not store.preview_path(86323).exists()
    assert store.recording_art(86323) is None


def test_a_truncated_listing_never_sweeps_the_store(monkeypatch):
    """The guard that matters. A short listing is indistinguishable from a
    shrunken library in here, and sweeping on one would delete nearly
    everything - so the caller decides, and only once it has checked what it
    fetched against the device's own count."""
    from app.routes import recordings as rec

    _asset(66220)
    _asset(86323)
    _listing(monkeypatch, [DEVICE_GAME])
    # The device says it holds twenty; we fetched one. That is a truncated
    # read, not a library of one.
    monkeypatch.setattr(rec.state, "recordings_total", 20)

    body = client.get("/api/recordings").json()

    assert body["returned"] == 1
    assert store.cover_bytes(86323) == JPEG, "a truncated listing swept the store"
    assert store.preview_path(86323).exists()


def test_a_complete_listing_does_sweep(monkeypatch):
    """The other half: with the device's own count matched, absence is real."""
    from app.routes import recordings as rec

    _asset(66220)
    _asset(86323)
    _listing(monkeypatch, [DEVICE_GAME])
    monkeypatch.setattr(rec.state, "recordings_total", 1)

    client.get("/api/recordings")

    assert store.cover_bytes(66220) is not None, "the live recording lost its art"
    assert not store.preview_path(86323).exists()


def test_an_offline_copy_keeps_its_assets_even_though_the_tablo_deleted_it():
    """A kept recording is the longest-lived thing here and the whole reason
    these stores exist. It is in the listing because `/recordings` merges
    orphans in, and it is checked against the pinned index as well - "safe by
    construction" should not be the only thing between a viewer and the
    artwork of something they deliberately kept."""
    _asset(66220)
    store.write_recording({"object_id": 66220, "path": "/recordings/x/66220",
                           "source_duration": 100, "pinned": True})

    gone = store.prune_recording_assets([{"object_id": 999}])

    assert 66220 not in gone
    assert store.cover_bytes(66220) == JPEG


def test_an_empty_library_is_a_real_state():
    """Everything deleted is a thing that happens, and the sweep has to act on
    it rather than treat it as a truncated read."""
    _asset(66220)

    assert store.prune_recording_assets([]) == [66220]
    assert store.cover_bytes(66220) is None


def test_a_stranger_in_the_artwork_directory_is_left_alone():
    """Anything not named after an object id is not ours to delete."""
    store.artwork_dir().joinpath("notes.txt").write_text("hello")
    _asset(66220)

    store.prune_recording_assets([])

    assert store.artwork_dir().joinpath("notes.txt").exists()


def test_storage_reports_what_the_app_actually_occupies(tmp_path):
    """Both durable stores live outside the cache root, so `total_bytes` cannot
    see them and the figure under-reported real disk."""
    async def never(_path):  # pragma: no cover - guard
        raise AssertionError("no session should start")

    c = TranscodeCache(session_starter=never, root=tmp_path, budget_bytes=10**9)
    _asset(66220)

    s = c.storage()

    assert s["artwork_bytes"] == len(JPEG)
    assert s["preview_bytes"] == 64
    assert s["disk_bytes"] == s["total_bytes"] + len(JPEG) + 64


# ---------------------------------------------------------------------------
# Recordings the device has no pack for at all
# ---------------------------------------------------------------------------

def test_a_device_with_no_pack_is_asked_once_not_once_per_frame(tmp_path):
    """Not every recording has thumbnails. A damaged one never gets a snap grid
    built - measured on object 74776, which the device reports as `clean:
    false`, `size: 0`, `has_snap_grid: false` and hands out a watch session with
    both bif urls null.

    A pointer crossing the strip asks for a frame every few pixels, and each of
    those used to open its own device watch session to discover the same null
    url: forty device round-trips in ten seconds, for nothing.
    """
    asked: list[str] = []

    async def starter(path):
        asked.append(path)
        return {"bif_url_hd": None, "bif_url_sd": None}

    c = TranscodeCache(session_starter=starter, root=tmp_path, budget_bytes=10**9)

    assert asyncio.run(c.fetch_bif(66220, "/recordings/sports/events/66220")) is False
    assert asyncio.run(c.fetch_bif(66220, "/recordings/sports/events/66220")) is False

    assert asked == ["/recordings/sports/events/66220"], "asked the device twice"
    assert c.preview_missing(66220) is True


def test_a_pack_published_later_is_still_picked_up(tmp_path, monkeypatch):
    """The refusal is remembered, not final. The device publishes a pack within
    about five minutes of a recording ending, so a "no" only holds for a while.
    """
    offer: dict = {"bif_url_hd": None}

    async def starter(_path):
        return dict(offer)

    monkeypatch.setattr(
        "app.transcode_cache._http_get",
        lambda _url: _bif([(0, b"\xff\xd8late-frame")]),
    )

    c = TranscodeCache(session_starter=starter, root=tmp_path, budget_bytes=10**9)
    assert asyncio.run(c.fetch_bif(66220, "/recordings/x/66220")) is False

    offer["bif_url_hd"] = "http://device/bif"
    # Still inside the window: the device is not asked again.
    assert asyncio.run(c.fetch_bif(66220, "/recordings/x/66220")) is False

    # Aged out, which is what the window does on its own.
    c._bif_refused.clear()

    assert asyncio.run(c.fetch_bif(66220, "/recordings/x/66220")) is True
    assert c.preview_frame(66220, 0) == b"\xff\xd8late-frame"
    assert c.preview_missing(66220) is False


def _scrubbing_a_recording_with_no_pack(tmp_path, monkeypatch) -> list[str]:
    """The preview route, against a device that offers no thumbnails."""
    from app.routes import recordings as rec

    asked: list[str] = []

    async def starter(path):
        asked.append(path)
        return {"bif_url_hd": None, "bif_url_sd": None}

    async def resolve(object_id):
        return f"/recordings/sports/events/{object_id}", 4116

    c = TranscodeCache(session_starter=starter, root=tmp_path, budget_bytes=10**9)
    monkeypatch.setattr(rec, "cache", c)
    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "resolve_recording", resolve)
    return asked


def test_scrubbing_a_recording_with_no_thumbnails_asks_the_device_once(
    tmp_path, monkeypatch,
):
    asked = _scrubbing_a_recording_with_no_pack(tmp_path, monkeypatch)

    for t in (10, 20, 30, 40):
        assert client.get(f"/api/recordings/74776/preview?t={t}").status_code == 404

    assert asked == ["/recordings/sports/events/74776"]


def test_status_says_there_is_no_preview_to_ask_for(tmp_path, monkeypatch):
    """The player cannot read a 404 off an <img>, so the answer it polls for
    anyway has to carry it. Without this the strip keeps requesting a frame per
    hover position for the whole of a recording that has none."""
    _scrubbing_a_recording_with_no_pack(tmp_path, monkeypatch)

    assert client.get("/api/recordings/74776/status").json()["preview"] == "unknown"
    client.get("/api/recordings/74776/preview?t=10")

    assert client.get("/api/recordings/74776/status").json()["preview"] == "absent"


# ---------------------------------------------------------------------------
# What a recording is about - the Library's content filter
# ---------------------------------------------------------------------------

def test_a_recording_says_whether_it_is_an_episode_a_game_or_a_film():
    """Read off the recording's own path, which every listed recording has.

    `series_path`/`sport_path` cannot answer it: a film carries neither, and
    neither does anything whose show record has aged off the device.
    """
    kind = AppState._recording_kind
    assert kind("/recordings/series/episodes/86040") == "episode"
    assert kind("/recordings/sports/events/66220") == "sport"
    assert kind("/recordings/movies/episodes/71002") == "movie"


def test_an_unrecognised_path_names_no_kind():
    """Better an unfiltered card than one filed under a guess."""
    kind = AppState._recording_kind
    assert kind(None) is None
    assert kind("") is None
    assert kind("/guide/series/episodes/1") is None
    assert kind("/recordings") is None


def test_a_recording_carries_the_same_word_for_ota_the_guide_does():
    """The device says `source` on the channel where the guide mirror says
    `kind`, and the Broadcast/Streaming filters read one field on both pages."""
    out = AppState._recording_fields({
        **DEVICE_RECORDING,
        "airing_details": {
            **DEVICE_RECORDING["airing_details"],
            "channel": {"channel": {
                "call_sign": "KTMFABC", "channel_identifier": "S34654_008_01",
                "major": 23, "minor": 1, "source": "ota",
            }},
        },
    })
    assert out["channel"]["kind"] == "ota"


def _library_of(monkeypatch, recordings: list[dict], shows: dict) -> list[str]:
    """A device serving these recordings, and these show records by path."""
    from app.routes import recordings as rec
    asked: list[str] = []

    async def get_recordings(limit=200):
        return [AppState._recording_fields(r) for r in recordings]

    async def request_device(_method, path):
        asked.append(path)
        if path not in shows:
            raise KeyError(path)
        return shows[path]

    monkeypatch.setattr(type(rec.state), "is_authenticated", property(lambda _s: True))
    monkeypatch.setattr(rec.state, "get_recordings", get_recordings)
    monkeypatch.setattr(rec.state, "request_device", request_device)
    return asked


def test_a_card_carries_the_genres_of_the_show_it_belongs_to(monkeypatch):
    """A recording holds none of its own - they live on the show record its
    `sport_path` points at, which is why the Library could not filter on them
    until the listing went and got them."""
    asked = _library_of(
        monkeypatch,
        [dict(DEVICE_GAME, object_id=oid, path=f"/recordings/sports/events/{oid}")
         for oid in (66220, 66221)],
        {"/recordings/sports/63558": DEVICE_SPORT},
    )

    body = client.get("/api/recordings").json()

    assert [r["genres"] for r in body["recordings"]] == [["Football"]] * 2
    # One read for the sport both games share - and the same one the artwork
    # wants, rather than one per card and one per consumer.
    assert asked == ["/recordings/sports/63558"]


def test_a_settled_library_asks_the_device_for_no_genres_at_all(monkeypatch):
    """Genres do not change, so a show is read once and remembered. Without the
    cache every listing would re-read every show on the device."""
    asked = _library_of(
        monkeypatch, [DEVICE_GAME], {"/recordings/sports/63558": DEVICE_SPORT},
    )

    client.get("/api/recordings")
    client.get("/api/recordings")

    assert asked == ["/recordings/sports/63558"]
    assert client.get("/api/recordings").json()["recordings"][0]["genres"] == ["Football"]


def test_a_show_the_device_will_not_serve_is_asked_again_next_listing(monkeypatch):
    """"Could not ask" must not be written down as "has no genres": that answer
    is kept permanently, and a device briefly unreachable would file every show
    under nothing for good."""
    asked = _library_of(monkeypatch, [DEVICE_GAME], {})

    first = client.get("/api/recordings").json()["recordings"][0]

    assert first["genres"] == []
    assert asked == ["/recordings/sports/63558"]

    client.get("/api/recordings")
    assert asked == ["/recordings/sports/63558"] * 2


def test_a_show_that_really_has_no_genres_is_only_asked_once(monkeypatch):
    """The other half of the rule above: an empty answer is still an answer."""
    asked = _library_of(
        monkeypatch, [DEVICE_GAME],
        {"/recordings/sports/63558": {"sport": {
            "title": "NFL Football",
            # Carried so the artwork settles on the first listing too - without
            # a cover the art resolver keeps asking, and this test is about the
            # genres rather than about that.
            "cover_image": {"image_id": 38765, "has_title": True},
        }}},
    )

    client.get("/api/recordings")
    client.get("/api/recordings")

    assert asked == ["/recordings/sports/63558"]


def test_a_film_needs_no_show_record_to_be_filed_as_one(monkeypatch):
    """It has neither `series_path` nor `sport_path`, and needs neither: the
    Movies filter reads `kind`, which the path already says."""
    film = {
        "object_id": 71002,
        "path": "/recordings/movies/episodes/71002",
        "airing_details": {
            "datetime": "2026-09-21T02:30Z", "duration": 7200,
            "show_title": "Knives Out",
            "channel": {"channel": {
                "call_sign": "MVSGLD", "channel_identifier": "S34654_008_07",
                "major": 8, "minor": 7, "source": "ota",
            }},
        },
        "video_details": {"state": "finished", "duration": 7215, "height": 480},
        "user_info": {},
    }
    asked = _library_of(monkeypatch, [film], {})

    card = client.get("/api/recordings").json()["recordings"][0]

    assert card["kind"] == "movie"
    assert card["genres"] == []
    assert asked == []
