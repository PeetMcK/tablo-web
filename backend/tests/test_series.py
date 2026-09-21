"""Recordings-series routes: the DVR management surface.

Auth gates, the composed series index (guide rules joined to recorded shows),
series detail (meta + settings + episode list), allow-listed settings writes
(rule/keep/padding, 999 retry), and bulk delete. Device stubbed the same way
test_settings.py does it — monkeypatch the signed helpers on `app_state`.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.state import state as app_state

client = TestClient(app)


@pytest.fixture
def authed(monkeypatch):
    monkeypatch.setattr(type(app_state), "is_authenticated",
                        property(lambda self: True))


def _dispatch(monkeypatch, table):
    """Stub request_device to answer by exact path from `table`."""
    async def fake(method, path, body=""):
        if path in table:
            return table[path]
        raise AssertionError(f"unexpected device read: {method} {path}")
    monkeypatch.setattr(app_state, "request_device", fake)


# --- Auth gate -------------------------------------------------------------

def test_series_reads_require_auth():
    for path in ["/api/recordings/series", "/api/recordings/upcoming",
                 "/api/recordings/conflicts"]:
        assert client.get(path).status_code == 401


# --- Upcoming / Conflicts passthrough --------------------------------------

def test_upcoming_passes_through(authed, monkeypatch):
    seen = {}

    async def fake(method, path, body=""):
        seen["path"] = path
        return [{"identifier": "LH-x-S1_008_06-T1789923600",
                 "schedule": {"state": "scheduled", "skip_reason": "none"}}]

    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/upcoming")
    assert r.status_code == 200
    assert seen["path"] == "/guide/airings?state=requested&lh"
    assert r.json()[0]["identifier"].startswith("LH-")


def test_series_index_merges_rule_and_counts(authed, monkeypatch):
    _dispatch(monkeypatch, {
        "/guide/shows?state=requested&lh": [
            {"identifier": "C1_SHOW_X",
             "schedule": {"rule": "all",
                          "offsets": {"start": 0, "end": 0, "source": "none"}},
             "keep": {"rule": "count", "count": 5},
             "recordings_path": "/recordings/series/1"},
        ],
        "/recordings/shows": ["/recordings/series/1", "/recordings/sports/2"],
        "/recordings/series/1": {
            "object_id": 1, "path": "/recordings/series/1",
            "series": {"title": "A", "genres": [], "description": "",
                       "cover_image": {"image_id": 11}},
            "show_counts": {"airing_count": 4, "unwatched_count": 3,
                            "protected_count": 0, "failed_count": 2},
            "keep": {"rule": "none", "count": None},
            "guide_path": "/guide/series/9"},
        "/recordings/sports/2": {
            "object_id": 2, "path": "/recordings/sports/2",
            "sport": {"title": "B", "cover_image": {"image_id": 22}},
            "show_counts": {"airing_count": 1, "unwatched_count": 0,
                            "protected_count": 1},
            "keep": {"rule": "all", "count": None},
            "guide_path": "/guide/sports/8"},
    })
    r = client.get("/api/recordings/series")
    assert r.status_code == 200
    items = {s["recordings_path"]: s for s in r.json()["series"]}
    assert len(items) == 2

    a = items["/recordings/series/1"]
    assert a["rule"] == "all"            # from the guide join, not meta
    assert a["keep"]["count"] == 5       # guide entry keep wins
    assert a["unwatched_count"] == 3
    assert a["kind"] == "series"
    assert a["identifier"] == "C1_SHOW_X"
    assert a["cover_image_id"] == 11
    assert a["failed_count"] == 2

    b = items["/recordings/sports/2"]
    assert b["rule"] == "none"           # no active rule → none
    assert b["identifier"] is None       # not settable without a guide handle
    assert b["kind"] == "sports"
    assert b["protected_count"] == 1
    assert b["title"] == "B"             # sports title lives under `sport`


def test_series_detail_composes_episodes_and_settings(authed, monkeypatch):
    _dispatch(monkeypatch, {
        "/recordings/series/1": {
            "object_id": 1, "path": "/recordings/series/1",
            "series": {"title": "A", "genres": ["Talk"], "description": "d",
                       "cover_image": {"image_id": 11}},
            "show_counts": {"airing_count": 1, "unwatched_count": 1},
            "keep": {"rule": "none", "count": None},
            "guide_path": "/guide/series/9"},
        "/recordings/series/1/episodes": ["/recordings/series/episodes/100"],
        "/batch": {
            "/recordings/series/episodes/100": {
                "object_id": 100,
                "airing_details": {"datetime": "2026-01-01T00:00Z",
                                   "duration": 1800},
                "episode": {"title": "Ep", "number": 3, "season_number": 2,
                            "orig_air_date": "2025-12-31"},
                "video_details": {"size": 12345, "state": "finished",
                                  "duration": 2115},
                "snapshot_image": {"image_id": 77},
                "user_info": {"position": 10, "watched": False,
                              "protected": True}}},
        "/guide/shows?state=requested&lh": [
            {"identifier": "C1_SHOW_X",
             "schedule": {"rule": "new",
                          "offsets": {"start": -300, "end": 600,
                                      "source": "show"}},
             "keep": {"rule": "count", "count": 3},
             "recordings_path": "/recordings/series/1"}],
    })
    r = client.get("/api/recordings/series/detail",
                   params={"recordings_path": "/recordings/series/1"})
    assert r.status_code == 200
    body = r.json()
    assert body["meta"]["title"] == "A"
    assert body["settings"]["identifier"] == "C1_SHOW_X"
    assert body["settings"]["rule"] == "new"
    assert body["settings"]["offsets"]["start"] == -300
    assert body["settings"]["keep"]["count"] == 3

    ep = body["episodes"][0]
    assert ep["object_id"] == 100
    assert ep["duration"] == 2115          # video_details, NOT the 1800 slot
    assert ep["protected"] is True
    assert ep["position"] == 10
    assert ep["watched"] is False
    assert ep["size"] == 12345
    assert ep["season_number"] == 2
    assert ep["episode_number"] == 3
    assert ep["is_recording"] is False
    assert ep["snapshot_image"] == 77


def test_series_detail_survives_an_unresolvable_episode(authed, monkeypatch):
    """One stale path must not take the whole detail page down.

    `POST /batch` answers with the key present and the value `null` for a path
    it cannot resolve - an episode deleted between the `/episodes` listing and
    the batch, which bulk-delete makes routine.
    """
    _dispatch(monkeypatch, {
        "/recordings/series/1": {
            "object_id": 1, "path": "/recordings/series/1",
            "series": {"title": "A", "genres": [], "description": "d"},
            "show_counts": {"airing_count": 2, "unwatched_count": 1},
            "keep": {"rule": "none", "count": None}},
        "/recordings/series/1/episodes": [
            "/recordings/series/episodes/100",
            "/recordings/series/episodes/101"],
        "/batch": {
            "/recordings/series/episodes/100": {
                "object_id": 100,
                "airing_details": {"datetime": "2026-01-01T00:00Z",
                                   "duration": 1800},
                "episode": {"title": "Ep", "number": 1, "season_number": 1},
                "video_details": {"size": 1, "state": "finished",
                                  "duration": 1800},
                "user_info": {"position": 0, "watched": False}},
            "/recordings/series/episodes/101": None,
        },
        "/guide/shows?state=requested&lh": [],
    })
    r = client.get("/api/recordings/series/detail",
                   params={"recordings_path": "/recordings/series/1"})
    assert r.status_code == 200
    assert [e["object_id"] for e in r.json()["episodes"]] == [100]


def test_series_detail_carries_guide_path(authed, monkeypatch):
    _dispatch(monkeypatch, {
        "/recordings/series/1": {
            "object_id": 1, "path": "/recordings/series/1",
            "series": {"title": "A"}, "show_counts": {},
            "keep": {"rule": "none", "count": None},
            "guide_path": "/guide/series/9"},
        "/recordings/series/1/episodes": [],
        "/guide/shows?state=requested&lh": [],
    })
    r = client.get("/api/recordings/series/detail",
                   params={"recordings_path": "/recordings/series/1"})
    assert r.status_code == 200
    assert r.json()["meta"]["guide_path"] == "/guide/series/9"


def test_series_airings_resolves_titled_rows(authed, monkeypatch):
    def ep(oid, title, state):
        return {
            "object_id": oid,
            "episode": {"title": title, "number": 1, "season_number": 1},
            "airing_details": {
                "datetime": "2026-09-20T20:00Z", "duration": 1800,
                "show_title": "A",
                "channel": {"channel": {"call_sign": "KUFM",
                                        "major": 11, "minor": 5}}},
            "schedule": {"state": state, "skip_reason": "none"}}

    async def fake(method, path, body=""):
        # Plain /episodes (batch-able paths), NOT the &lh handle variant.
        if path == "/guide/series/9/episodes":
            return ["/guide/series/episodes/500", "/guide/series/episodes/501"]
        if path == "/batch":
            return {
                "/guide/series/episodes/500": ep(500, "Pilot", "scheduled"),
                "/guide/series/episodes/501": ep(501, "Old One", "none"),
            }
        raise AssertionError(f"unexpected {method} {path}")
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/series/airings",
                   params={"guide_path": "/guide/series/9", "state": "requested"})
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1                 # the "none"-state episode is filtered out
    row = rows[0]
    assert row["title"] == "Pilot"
    assert row["channel"] == "KUFM"
    assert row["state"] == "scheduled"
    assert row["datetime"] == "2026-09-20T20:00Z"


def test_series_airings_skips_an_unresolvable_path(authed, monkeypatch):
    """Same `null` from `/batch`, on the airings side of the same response."""
    async def fake(method, path, body=""):
        if path == "/guide/series/9/episodes":
            return ["/guide/series/episodes/500", "/guide/series/episodes/501"]
        if path == "/batch":
            return {
                "/guide/series/episodes/500": {
                    "object_id": 500,
                    "episode": {"title": "Pilot", "number": 1,
                                "season_number": 1},
                    "airing_details": {
                        "datetime": "2026-09-20T20:00Z", "duration": 1800,
                        "show_title": "A",
                        "channel": {"channel": {"call_sign": "KUFM",
                                                "major": 11, "minor": 5}}},
                    "schedule": {"state": "scheduled", "skip_reason": "none"}},
                "/guide/series/episodes/501": None,
            }
        raise AssertionError(f"unexpected {method} {path}")
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/series/airings",
                   params={"guide_path": "/guide/series/9",
                           "state": "requested"})
    assert r.status_code == 200
    assert [row["title"] for row in r.json()] == ["Pilot"]


def test_series_airings_rejects_foreign_guide_path(authed, monkeypatch):
    async def fake(method, path, body=""):
        raise AssertionError("must not reach the device")
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/series/airings",
                   params={"guide_path": "/server/info", "state": "requested"})
    assert r.status_code == 400


def test_series_detail_404_when_the_series_is_gone(authed, monkeypatch):
    # A deleted (or stale) recordings_path: the device answers 404, which must
    # surface as 404 — not "the Tablo could not be reached".
    async def fake(method, path, body=""):
        req = httpx.Request(method, "http://tablo:8887" + path.split("?", 1)[0])
        raise httpx.HTTPStatusError(
            "not found", request=req, response=httpx.Response(404, request=req))
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/series/detail",
                   params={"recordings_path": "/recordings/series/94868"})
    assert r.status_code == 404


def test_series_detail_502_on_transport_error(authed, monkeypatch):
    # A genuine connection failure stays 502 — a not-found must not swallow a
    # real outage into a 404.
    async def fake(method, path, body=""):
        raise RuntimeError("connection reset")
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/series/detail",
                   params={"recordings_path": "/recordings/series/1"})
    assert r.status_code == 502


def test_series_detail_rejects_foreign_path(authed, monkeypatch):
    async def fake(method, path, body=""):
        raise AssertionError("must not reach the device for a foreign path")
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/series/detail",
                   params={"recordings_path": "/server/info"})
    assert r.status_code == 400


def _capture_patch(monkeypatch, script=None):
    """Stub patch_device, recording (path, payload); return a calls list.

    `script` is an optional list of (status, data) to return in order; default
    is always (200, {"ok": True}).
    """
    calls = []
    seq = list(script or [])

    async def fake_patch(path, payload):
        calls.append((path, payload))
        if seq:
            return seq.pop(0)
        return (200, {"ok": True})

    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    return calls


def test_settings_rule_maps_to_schedule_rule(authed, monkeypatch):
    calls = _capture_patch(monkeypatch)
    r = client.patch("/api/recordings/series/settings",
                     json={"identifier": "C1_SHOW_X", "guide_path": "/guide/series/9", "rule": "new"})
    assert r.status_code == 200
    assert calls == [("/guide/series/9", {"schedule": {"rule": "new"}})]


def test_settings_keep_count(authed, monkeypatch):
    calls = _capture_patch(monkeypatch)
    r = client.patch("/api/recordings/series/settings",
                     json={"identifier": "C1_SHOW_X", "guide_path": "/guide/series/9",
                           "keep": {"rule": "count", "count": 5}})
    assert r.status_code == 200
    assert calls == [("/guide/series/9",
                      {"keep": {"rule": "count", "count": 5}})]


def test_settings_padding_seconds(authed, monkeypatch):
    calls = _capture_patch(monkeypatch)
    r = client.patch("/api/recordings/series/settings",
                     json={"identifier": "C1_SHOW_X", "guide_path": "/guide/series/9",
                           "offsets": {"start": -300, "end": 1800}})
    assert r.status_code == 200
    assert calls == [("/guide/series/9",
                      {"schedule": {"offsets": {"source": "show",
                                                "start": -300, "end": 1800}}})]


def test_settings_padding_defaults_to_source_none(authed, monkeypatch):
    calls = _capture_patch(monkeypatch)
    client.patch("/api/recordings/series/settings",
                 json={"identifier": "C1", "guide_path": "/guide/series/9", "offsets": {"start": 0, "end": 0}})
    assert calls[0][1]["schedule"]["offsets"]["source"] == "none"


def test_settings_rejects_unknown_key(authed, monkeypatch):
    _capture_patch(monkeypatch)
    r = client.patch("/api/recordings/series/settings",
                     json={"identifier": "C1", "guide_path": "/guide/series/9", "bogus": 1})
    assert r.status_code == 422


def test_settings_retries_once_on_999(authed, monkeypatch):
    calls = _capture_patch(monkeypatch, script=[(999, {}), (200, {"ok": True})])
    r = client.patch("/api/recordings/series/settings",
                     json={"identifier": "C1", "guide_path": "/guide/series/9", "rule": "all"})
    assert r.status_code == 200
    assert len(calls) == 2


def test_settings_without_identifier_still_writes(authed, monkeypatch):
    # A series turned off has no identifier but is re-ruled by guide_path.
    calls = _capture_patch(monkeypatch)
    r = client.patch("/api/recordings/series/settings",
                     json={"guide_path": "/guide/series/9", "rule": "all"})
    assert r.status_code == 200
    assert calls == [("/guide/series/9", {"schedule": {"rule": "all"}})]


def test_settings_rejects_non_guide_path(authed, monkeypatch):
    calls = _capture_patch(monkeypatch)
    r = client.patch("/api/recordings/series/settings",
                     json={"identifier": "C1", "guide_path": "/server/info",
                           "rule": "all"})
    assert r.status_code == 400
    assert calls == []   # never reaches the device


def test_bulk_delete_forwards_filter(authed, monkeypatch):
    import json as _json
    calls = []

    async def fake_raw(method, path, body="", follow_redirects=False):
        calls.append((method, path, body))
        return type("R", (), {"status_code": 200})()

    monkeypatch.setattr(app_state, "_request_device_raw", fake_raw)
    r = client.post("/api/recordings/series/bulk-delete",
                    json={"recordings_path": "/recordings/series/1",
                          "filter": "watched"})
    assert r.status_code == 200
    assert calls == [("POST", "/recordings/series/1/delete",
                      _json.dumps({"filter": "watched"}))]


def test_bulk_delete_rejects_bad_filter(authed):
    r = client.post("/api/recordings/series/bulk-delete",
                    json={"recordings_path": "/recordings/series/1",
                          "filter": "everything"})
    assert r.status_code == 422


def test_bulk_delete_rejects_foreign_path(authed, monkeypatch):
    async def fake_raw(method, path, body="", follow_redirects=False):
        raise AssertionError("must not reach the device for a foreign path")
    monkeypatch.setattr(app_state, "_request_device_raw", fake_raw)
    r = client.post("/api/recordings/series/bulk-delete",
                    json={"recordings_path": "/server/info",
                          "filter": "watched"})
    assert r.status_code == 400


def test_conflicts_passes_through(authed, monkeypatch):
    seen = {}

    async def fake(method, path, body=""):
        seen["path"] = path
        return []

    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/conflicts")
    assert r.status_code == 200
    assert seen["path"] == "/guide/airings?state=conflicted&lh"
    assert r.json() == []
