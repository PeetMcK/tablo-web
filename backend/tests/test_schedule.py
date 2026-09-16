"""Recording management: the device write path and the routes over it."""

import asyncio
import time

from app import db, store
from app.state import AppState


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
