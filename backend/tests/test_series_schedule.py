"""Ruled-series resolution, the union merge that surfaces scheduled-but-never-
recorded series, and the state-marked schedule feed.

The device is stubbed with a fake `state` whose `request_device` answers by
(method, path), special-casing `POST /batch` over a path->object table.
"""
import json

import pytest
from fastapi import HTTPException

from app.routes import series as S


class FakeState:
    def __init__(self, responses, active_sid="sidA", batch_limit=None):
        self.responses = responses            # {(method, path): value, "objs": {...}}
        self.active_sid = active_sid
        self.is_authenticated = True
        self.batch_limit = batch_limit        # mimic the device's 50-path cap
        self.calls = []

    async def request_device(self, method, path, body=""):
        self.calls.append((method, path, body))
        if path == "/batch":
            paths = json.loads(body)
            if self.batch_limit is not None and len(paths) > self.batch_limit:
                raise RuntimeError("batch too large")   # device 400s
            return {p: self.responses.get("objs", {}).get(p) for p in paths}
        return self.responses.get((method, path))


CATALOG = ["/guide/series/1", "/guide/series/2", "/guide/series/3"]
OBJS = {
    "/guide/series/1": {"identifier": "IDA",
                        "series": {"title": "Alpha", "cover_image": {"image_id": 11}},
                        "recordings_path": None, "show_counts": {"scheduled_count": 2}},
    "/guide/series/2": {"identifier": "IDB",
                        "series": {"title": "Beta", "cover_image": {"image_id": 22}},
                        "recordings_path": "/recordings/series/9", "show_counts": {}},
    "/guide/series/3": {"identifier": "IDC", "sport": {"title": "Gamma"},
                        "recordings_path": None},
}
RULED = [
    {"identifier": "IDA",
     "schedule": {"rule": "new", "offsets": {"start": 0, "end": 0, "source": "none"}},
     "keep": {"rule": "none", "count": None}, "recordings_path": None},
    {"identifier": "IDB", "schedule": {"rule": "all"},
     "keep": {"rule": "count", "count": 3}, "recordings_path": "/recordings/series/9"},
]
EPISODES_1 = ["/guide/series/1/episodes/100", "/guide/series/1/episodes/101"]
AIR_OBJS = {
    "/guide/series/1/episodes/100": {
        "object_id": 100, "episode": {"title": "E1"},
        "airing_details": {"datetime": "2026-09-22T00:00Z", "duration": 1800,
                           "channel": {"channel": {"call_sign": "ABC",
                                                   "major": 7, "minor": 1}}},
        "schedule": {"state": "scheduled", "skip_reason": "none"}},
    "/guide/series/1/episodes/101": {
        "object_id": 101, "episode": {"title": "E2"},
        "airing_details": {"datetime": "2026-09-21T22:00Z", "duration": 1800,
                           "channel": {"channel": {"call_sign": "ABC",
                                                   "major": 7, "minor": 1}}},
        "schedule": {"state": "skipped", "skip_reason": "not_new"}},
}


@pytest.fixture(autouse=True)
def _clear_cache():
    S._RULED_CATALOG_CACHE.clear()
    yield
    S._RULED_CATALOG_CACHE.clear()


# --- catalog index ---------------------------------------------------------

@pytest.mark.asyncio
async def test_catalog_index_maps_identifier_to_object(monkeypatch):
    fake = FakeState({("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)
    idx = await S._ruled_catalog_index({"IDA", "IDC"})
    assert idx["IDA"]["series"]["title"] == "Alpha"
    assert idx["IDC"]["sport"]["title"] == "Gamma"
    assert idx["IDA"]["path"] == "/guide/series/1"   # batch key injected


@pytest.mark.asyncio
async def test_catalog_index_caches_within_ttl(monkeypatch):
    fake = FakeState({("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)
    await S._ruled_catalog_index({"IDA"})
    await S._ruled_catalog_index({"IDA"})
    n = sum(1 for c in fake.calls if c[1] == "/guide/shows")
    assert n == 1   # second call served from cache


# --- resolve_ruled ---------------------------------------------------------

@pytest.mark.asyncio
async def test_resolve_ruled_joins_catalog(monkeypatch):
    fake = FakeState({("GET", "/guide/shows?state=requested&lh"): RULED,
                      ("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)
    out = {r["identifier"]: r for r in await S.resolve_ruled()}
    assert out["IDA"]["title"] == "Alpha"
    assert out["IDA"]["guide_path"] == "/guide/series/1"
    assert out["IDA"]["recordings_path"] is None
    assert out["IDA"]["rule"] == "new"
    assert out["IDA"]["cover_image_id"] == 11
    assert out["IDB"]["recordings_path"] == "/recordings/series/9"
    assert out["IDB"]["keep"] == {"rule": "count", "count": 3}


# --- /series union merge ---------------------------------------------------

@pytest.mark.asyncio
async def test_series_union_includes_unrecorded_ruled(monkeypatch):
    fake = FakeState({
        ("GET", "/guide/shows?state=requested&lh"): RULED,
        ("GET", "/guide/shows"): CATALOG,
        ("GET", "/recordings/shows"): ["/recordings/series/9"],
        ("GET", "/recordings/series/9"): {
            "series": {"title": "Beta", "cover_image": {"image_id": 22}},
            "show_counts": {"airing_count": 5, "unwatched_count": 1,
                            "protected_count": 0, "failed_count": 0}},
        "objs": OBJS,
    })
    monkeypatch.setattr(S, "state", fake)
    cards = {c["title"]: c for c in await S._compose_series_index()}
    # scheduled-but-never-recorded series now present:
    assert cards["Alpha"]["recordings_path"] is None
    assert cards["Alpha"]["rule"] == "new"
    assert cards["Alpha"]["episode_count"] == 0
    assert cards["Alpha"]["guide_path"] == "/guide/series/1"
    assert cards["Alpha"]["scheduled_count"] == 2
    # recorded ruled series keeps its disk data, not double-listed:
    assert cards["Beta"]["recordings_path"] == "/recordings/series/9"
    assert cards["Beta"]["episode_count"] == 5


# --- /schedule feed --------------------------------------------------------

@pytest.mark.asyncio
async def test_schedule_flat_sorted_with_states(monkeypatch):
    fake = FakeState({
        ("GET", "/guide/shows?state=requested&lh"): [RULED[0]],   # IDA -> Alpha
        ("GET", "/guide/shows"): CATALOG,
        ("GET", "/guide/series/1/episodes"): EPISODES_1,
        "objs": {**OBJS, **AIR_OBJS},
    })
    monkeypatch.setattr(S, "state", fake)
    rows = await S._compose_schedule()
    assert [r["state"] for r in rows] == ["skipped", "scheduled"]   # time-sorted
    assert rows[0]["skip_reason"] == "not_new"
    assert rows[0]["series_title"] == "Alpha"
    assert rows[0]["channel"] == "ABC"
    assert rows[0]["series_cover_image_id"] == 11


@pytest.mark.asyncio
async def test_schedule_skips_series_with_failed_episodes(monkeypatch):
    fake = FakeState({
        ("GET", "/guide/shows?state=requested&lh"): [RULED[0]],
        ("GET", "/guide/shows"): CATALOG,
        # no /guide/series/1/episodes entry -> _try returns None -> [] rows
        "objs": OBJS,
    })
    monkeypatch.setattr(S, "state", fake)
    rows = await S._compose_schedule()
    assert rows == []


# --- series_airings all-states + guide-path detail -------------------------

@pytest.mark.asyncio
async def test_series_airings_all_returns_every_state(monkeypatch):
    fake = FakeState({("GET", "/guide/series/1/episodes"): EPISODES_1,
                      "objs": AIR_OBJS})
    monkeypatch.setattr(S, "state", fake)
    rows = await S.series_airings(guide_path="/guide/series/1", airing_state="all")
    assert {r["state"] for r in rows} == {"scheduled", "skipped"}


@pytest.mark.asyncio
async def test_series_airings_requested_filters(monkeypatch):
    fake = FakeState({("GET", "/guide/series/1/episodes"): EPISODES_1,
                      "objs": AIR_OBJS})
    monkeypatch.setattr(S, "state", fake)
    rows = await S.series_airings(guide_path="/guide/series/1",
                                  airing_state="requested")
    assert [r["state"] for r in rows] == ["scheduled"]


@pytest.mark.asyncio
async def test_series_airings_chunks_over_the_batch_limit(monkeypatch):
    # 60 upcoming episodes: a single /batch would exceed the device's 50-path
    # cap and 502. Chunked, all 60 resolve.
    paths = [f"/guide/series/1/episodes/{i}" for i in range(60)]
    objs = {
        p: {"object_id": i, "episode": {"title": f"E{i}"},
            "airing_details": {"datetime": f"2026-09-{(i % 27) + 1:02d}T00:00Z"},
            "schedule": {"state": "scheduled", "skip_reason": "none"}}
        for i, p in enumerate(paths)
    }
    fake = FakeState({("GET", "/guide/series/1/episodes"): paths, "objs": objs},
                     batch_limit=50)
    monkeypatch.setattr(S, "state", fake)
    rows = await S.series_airings(guide_path="/guide/series/1", airing_state="all")
    assert len(rows) == 60
    batch_calls = [c for c in fake.calls if c[1] == "/batch"]
    assert len(batch_calls) >= 2   # actually chunked, not one oversized call


@pytest.mark.asyncio
async def test_series_channels_distinct_sorted(monkeypatch):
    eps = ["/guide/series/1/episodes/1", "/guide/series/1/episodes/2",
           "/guide/series/1/episodes/3"]
    def ch(path, cs, maj, minor):
        return {"airing_details": {"channel": {"path": path,
                "channel": {"call_sign": cs, "major": maj, "minor": minor}}}}
    fake = FakeState({
        ("GET", "/guide/series/1/episodes"): eps,
        "objs": {
            eps[0]: ch("/guide/channels/9", "PBS", 11, 1),
            eps[1]: ch("/guide/channels/5", "KSPS", 7, 1),
            eps[2]: ch("/guide/channels/5", "KSPS", 7, 1),   # dup -> collapsed
        },
    })
    monkeypatch.setattr(S, "state", fake)
    out = await S.series_channels(guide_path="/guide/series/1")
    assert [o["path"] for o in out] == ["/guide/channels/5", "/guide/channels/9"]
    assert out[0]["call_sign"] == "KSPS" and out[0]["number"] == "7.1"


@pytest.mark.asyncio
async def test_recording_now_paths(monkeypatch):
    ev = "/recordings/series/episodes/500"
    fake = FakeState({
        ("GET", "/recordings/airings"): [ev, "/recordings/series/episodes/501"],
        "objs": {
            ev: {"video_details": {"state": "recording"},
                 "series_path": "/recordings/series/9"},
            "/recordings/series/episodes/501": {
                "video_details": {"state": "finished"},
                "series_path": "/recordings/series/8"},
        },
    })
    monkeypatch.setattr(S, "state", fake)
    assert await S._recording_now_paths() == {"/recordings/series/9"}


@pytest.mark.asyncio
async def test_series_detail_sports_lists_events_not_episodes(monkeypatch):
    # A sport has no `{path}/episodes` (device 404s it); its games are events
    # found via /recordings/airings filtered on sport_path. Must not 404.
    ev = "/recordings/sports/events/74778"
    other = "/recordings/sports/events/999"
    fake = FakeState({
        ("GET", "/recordings/sports/63558"): {
            "sport": {"title": "NFL Football"},
            "show_counts": {"airing_count": 1}, "guide_path": "/guide/sports/1"},
        ("GET", "/recordings/airings"): [ev, other],
        ("GET", "/guide/shows?state=requested&lh"): [],
        "objs": {
            ev: {"object_id": 74778, "event": {"title": "Colts at Chiefs"},
                 "airing_details": {"datetime": "2026-09-21T00:00Z"},
                 "video_details": {"duration": 9000}, "user_info": {},
                 "sport_path": "/recordings/sports/63558"},
            other: {"object_id": 999, "event": {"title": "Other Game"},
                    "sport_path": "/recordings/sports/OTHER"},
        },
    })
    monkeypatch.setattr(S, "state", fake)
    d = await S.series_detail(recordings_path="/recordings/sports/63558",
                              guide_path=None)
    assert d["meta"]["title"] == "NFL Football"
    assert [e["title"] for e in d["episodes"]] == ["Colts at Chiefs"]


@pytest.mark.asyncio
async def test_series_detail_by_guide_path_no_recordings(monkeypatch):
    fake = FakeState({("GET", "/guide/shows?state=requested&lh"): RULED,
                      ("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)
    d = await S.series_detail(recordings_path=None, guide_path="/guide/series/1")
    assert d["meta"]["title"] == "Alpha"
    assert d["settings"]["rule"] == "new"
    assert d["settings"]["identifier"] == "IDA"
    assert d["episodes"] == []


@pytest.mark.asyncio
async def test_series_detail_for_a_series_nobody_records(monkeypatch):
    """A show with no rule and nothing recorded is most of the guide.

    Opening one from the Guide or from Live has only its guide path to go on,
    and the ruled set — which is what a scheduled-but-unrecorded series is
    found in — does not contain it. Answering 404 there left every ordinary
    show in the guide with a sheet that never opened.
    """
    fake = FakeState({
        ("GET", "/guide/shows?state=requested&lh"): RULED,
        ("GET", "/guide/shows"): CATALOG,
        ("GET", "/guide/series/77"): {
            "identifier": "IDZ",
            "series": {"title": "Nature", "description": "Wildlife films.",
                       "genres": ["Documentary"],
                       "cover_image": {"image_id": 77}},
            "show_counts": {"scheduled_count": 4},
        },
        "objs": OBJS,
    })
    monkeypatch.setattr(S, "state", fake)

    d = await S.series_detail(recordings_path=None, guide_path="/guide/series/77")

    assert d["meta"]["title"] == "Nature"
    assert d["meta"]["description"] == "Wildlife films."
    assert d["meta"]["genres"] == ["Documentary"]
    assert d["meta"]["cover_image_id"] == 77
    assert d["meta"]["kind"] == "series"
    # Nothing is scheduled for it, and the sheet's controls have to say so
    # rather than inherit some other series' rule.
    assert d["settings"]["rule"] == "none"
    assert d["settings"]["identifier"] == "IDZ"
    assert d["settings"]["keep"] == {"rule": "none", "count": None}
    assert d["episodes"] == []


@pytest.mark.asyncio
async def test_a_guide_path_the_device_does_not_know_is_a_404(monkeypatch):
    fake = FakeState({("GET", "/guide/shows?state=requested&lh"): RULED,
                      ("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)

    with pytest.raises(HTTPException) as caught:
        await S.series_detail(recordings_path=None, guide_path="/guide/series/404")

    assert caught.value.status_code == 404
