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
