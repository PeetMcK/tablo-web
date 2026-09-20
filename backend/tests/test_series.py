"""Recordings-series routes: the DVR management surface.

Auth gates, the composed series index (guide rules joined to recorded shows),
series detail (meta + settings + episode list), allow-listed settings writes
(rule/keep/padding, 999 retry), and bulk delete. Device stubbed the same way
test_settings.py does it — monkeypatch the signed helpers on `app_state`.
"""

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
                            "protected_count": 0},
            "keep": {"rule": "none", "count": None},
            "guide_path": "/guide/series/9"},
        "/recordings/sports/2": {
            "object_id": 2, "path": "/recordings/sports/2",
            "series": {"title": "B", "cover_image": {"image_id": 22}},
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

    b = items["/recordings/sports/2"]
    assert b["rule"] == "none"           # no active rule → none
    assert b["identifier"] is None       # not settable without a guide handle
    assert b["kind"] == "sports"
    assert b["protected_count"] == 1


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
