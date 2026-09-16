"""Recording management: the device write path and the routes over it."""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app import db, store
from app.main import app
from app.routes import schedule as schedule_routes
from app.state import AppState
from app.state import state as app_state

client = TestClient(app)


@pytest.fixture
def authed(monkeypatch):
    monkeypatch.setattr(type(app_state), "is_authenticated",
                        property(lambda self: True))


def _device_airing(state_value):
    """A device airing record, as PATCH returns it."""
    return {
        "path": "/guide/series/episodes/67388",
        "series_path": "/guide/series/6472",
        "episode": {"title": "Rags to Riches", "number": 10,
                    "season_number": 12, "orig_air_date": None},
        "airing_details": {"datetime": "2026-09-16T08:00Z", "duration": 3600,
                           "channel_path": "/guide/channels/1", "genres": [],
                           "show_title": "Finding Your Roots"},
        "schedule": {"state": state_value, "qualifier": "single",
                     "skip_reason": None},
    }


def _guide(now, **over):
    """One channel with one airing, the shape save_guide expects."""
    airing = {
        "title": "Finding Your Roots", "subtitle": None, "description": None,
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 3600)),
        "duration": 3600, "genres": [], "kind": "episode",
        "episode_title": "Rags to Riches", "season_number": 12,
        "episode_number": 10, "orig_air_date": None,
        "series_path": "/guide/series/6472",
        "airing_path": "/guide/series/episodes/67388",
        "schedule_state": "none", "schedule_qualifier": "none",
        "skip_reason": "none", "image_url": None,
    }
    airing.update(over)
    return [{
        "identifier": "ch1", "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "PBS", "display_name": "KPAX", "logo_url": None,
        "kind": "ota", "airings": [airing],
    }], airing["start"]


class _Resp:
    def __init__(self, status, payload, text="{}"):
        self.status_code = status
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def test_patch_device_returns_the_status_and_the_body():
    """A 400 is an answer, not an exception - its body says what was wrong."""
    state = AppState()
    state.active_device = type("D", (), {"local_url": "http://tablo:8887"})()
    sent = {}

    async def fake_request(method, url, content=None, headers=None, **kw):
        sent.update(method=method, url=url, content=content, headers=headers)
        return _Resp(400, {"error": {"code": "invalid_patch_document",
                                     "description": "Invalid value for 'rule' parameter",
                                     "details": {"rule": "ZZZ"}}})

    state._http.request = fake_request

    status, data = asyncio.run(state.patch_device("/guide/series/6472",
                                                  {"schedule": {"rule": "ZZZ"}}))

    assert status == 400
    assert data["error"]["description"] == "Invalid value for 'rule' parameter"
    assert sent["method"] == "PATCH"
    assert sent["url"] == "http://tablo:8887/guide/series/6472"
    # The signature covers the body, so what was signed must be what was sent.
    assert sent["content"] == b'{"schedule":{"rule":"ZZZ"}}'
    assert sent["headers"]["Authorization"].startswith("tablo:")


def test_patch_device_tolerates_a_body_that_is_not_json():
    state = AppState()
    state.active_device = type("D", (), {"local_url": "http://tablo:8887"})()

    async def fake_request(*a, **kw):
        return _Resp(502, None, text="<html>gateway</html>")

    state._http.request = fake_request

    status, data = asyncio.run(state.patch_device("/guide/series/1", {"a": 1}))
    assert (status, data) == (502, {})


def test_airing_handles_returns_the_device_paths():
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    got = store.airing_handles("ch1", start)
    assert got == {"airing_path": "/guide/series/episodes/67388",
                   "series_path": "/guide/series/6472"}


def test_airing_handles_is_none_for_an_airing_we_do_not_have():
    assert store.airing_handles("ch1", "2026-01-01T00:00:00Z") is None


def test_update_airing_schedule_writes_only_the_schedule_columns():
    """The PATCH response is the whole record, but the row also holds guide
    text that the write must not disturb."""
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    store.update_airing_schedule("ch1", start, {
        "schedule_state": "scheduled", "schedule_qualifier": "single",
        "skip_reason": None, "airing_path": "/guide/series/episodes/67388",
        "series_path": "/guide/series/6472",
    })

    row = db.query_one(
        "SELECT schedule_state, title, episode_title FROM guide_airing "
        "WHERE channel_id = ? AND start = ?", ("ch1", start))
    assert row["schedule_state"] == "scheduled"
    assert row["title"] == "Finding Your Roots"
    assert row["episode_title"] == "Rags to Riches"


def test_update_airing_schedule_keeps_the_paths_when_the_write_omits_them():
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    store.update_airing_schedule("ch1", start, {"schedule_state": "scheduled"})

    assert store.airing_handles("ch1", start)["airing_path"] == \
        "/guide/series/episodes/67388"


def test_series_future_airings_skips_the_past_and_the_unschedulable():
    now = time.time()
    past = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 7200))
    cloud = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 7200))
    rows, start = _guide(now)
    rows[0]["airings"] += [
        {**rows[0]["airings"][0], "start": past},
        {**rows[0]["airings"][0], "start": cloud, "airing_path": None},
    ]
    store.save_guide(rows, now=now)

    got = store.series_future_airings("/guide/series/6472", now=now)
    assert [r["start"] for r in got] == [start]
    assert got[0]["channel"] == "ch1"
    assert got[0]["airing_path"] == "/guide/series/episodes/67388"


def test_airing_detail_says_whether_it_can_be_recorded():
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)
    store.save_series([{
        "path": "/guide/series/6472", "identifier": "X",
        "title": "Finding Your Roots", "description": None, "genres": [],
        "rating": "tvpg", "orig_air_date": None, "episode_runtime": 3600,
        "cast": [], "cover_image_id": None, "thumbnail_image_id": None,
        "background_image_id": None, "schedule_rule": "new",
        "keep_rule": "none", "keep_count": None,
    }])

    d = store.airing_detail("ch1", start, now=now)
    assert d["schedulable"] is True
    assert d["scheduled"] is False          # schedule_state is "none"
    assert d["schedule_state"] == "none"
    assert d["past"] is False               # _guide() puts it an hour out
    assert d["series"] == {"path": "/guide/series/6472", "schedule_rule": "new"}


def test_an_airing_that_has_finished_is_past():
    """Distinct from `airing_now`, which is also false for everything upcoming
    - and upcoming is what people record."""
    now = time.time()
    rows, _ = _guide(now)
    ended = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 7200))
    rows[0]["airings"][0]["start"] = ended
    store.save_guide(rows, now=now)

    d = store.airing_detail("ch1", ended, now=now)
    assert d["past"] is True
    assert d["airing_now"] is False


def test_a_cloud_only_airing_is_not_schedulable():
    """OTT/FAST airings exist only in the cloud, which carries no device path,
    no schedule block and no series_path - nothing can record them."""
    now = time.time()
    rows, start = _guide(now, airing_path=None, series_path=None,
                         schedule_state=None, schedule_qualifier=None,
                         skip_reason=None)
    store.save_guide(rows, now=now)

    d = store.airing_detail("ch1", start, now=now)
    assert d["schedulable"] is False
    assert d["scheduled"] is False
    assert d["series"] is None


def test_any_state_but_none_or_skipped_counts_as_recording():
    """schedule.state is an open enumeration - name the values that mean *not*
    recording and treat the rest as recording, so an unseen one is not read as
    'this is not being recorded' when it is."""
    now = time.time()
    rows, start = _guide(now, schedule_state="conflict")
    store.save_guide(rows, now=now)

    assert store.airing_detail("ch1", start, now=now)["scheduled"] is True


def test_scheduling_an_airing_patches_the_device_and_the_mirror(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)
    sent = {}

    async def fake_patch(path, payload):
        sent.update(path=path, payload=payload)
        return 200, _device_airing("scheduled")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})

    assert resp.status_code == 200
    assert sent == {"path": "/guide/series/episodes/67388",
                    "payload": {"scheduled": True}}
    assert resp.json()["scheduled"] is True
    assert store.airing_detail("ch1", start, now=now)["schedule_state"] == "scheduled"


def test_an_unknown_airing_is_a_404(authed):
    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": "2026-01-01T00:00:00Z",
                            "scheduled": True})
    assert resp.status_code == 404


def test_a_cloud_airing_is_refused_without_touching_the_device(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now, airing_path=None)
    store.save_guide(rows, now=now)

    async def fake_patch(path, payload):
        raise AssertionError("the device must not be asked")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})
    assert resp.status_code == 409
    assert "cloud" in resp.json()["detail"].lower()


def test_a_device_refusal_is_reported_in_the_devices_own_words(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    async def fake_patch(path, payload):
        return 400, {"error": {"code": "invalid_patch_document",
                               "description": "Invalid parameter value",
                               "details": {"scheduled": None}}}

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid parameter value"


def test_an_unreachable_device_is_a_502(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    async def fake_patch(path, payload):
        raise OSError("connection refused")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})
    assert resp.status_code == 502


def test_scheduling_requires_auth():
    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": "x", "scheduled": True})
    assert resp.status_code == 401
