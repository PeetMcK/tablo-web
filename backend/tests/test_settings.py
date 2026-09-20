"""Settings routes: auth gate, read tolerance, allow-listed writes, no-ops."""

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.state import state as app_state

client = TestClient(app)


@pytest.fixture
def authed(monkeypatch):
    monkeypatch.setattr(type(app_state), "is_authenticated",
                        property(lambda self: True))


# --- Auth gate -------------------------------------------------------------

def test_reads_require_auth():
    for path in ["/api/settings/overview", "/api/settings/info",
                 "/api/settings/harddrives", "/api/settings/location",
                 "/api/settings/guide-status", "/api/settings/channels"]:
        assert client.get(path).status_code == 401, path


def test_writes_require_auth():
    assert client.patch("/api/settings/info", json={"led": "on"}).status_code == 401
    assert client.patch("/api/settings/name", json={"name": "x"}).status_code == 401
    assert client.post("/api/settings/channels/scan").status_code == 401
    assert client.post("/api/settings/guide/update").status_code == 401
    assert client.patch("/api/settings/location",
                        json={"postal_code": "97201"}).status_code == 401


# --- Reads -----------------------------------------------------------------

def test_overview_null_slice_on_failure(authed, monkeypatch):
    async def fake(method, path, body=""):
        if "harddrives" in path:
            raise RuntimeError("boom")
        return {"path": path}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/settings/overview")
    assert r.status_code == 200
    body = r.json()
    assert body["harddrives"] is None
    assert body["server"] == {"path": "/server/info"}
    assert body["settings"] == {"path": "/settings/info"}


def test_info_read_uses_plain_path(authed, monkeypatch):
    # The device signs the path without its query string, so /settings/info is
    # requested plain (the ?allowAudioTranscode variant 401s). See the route.
    seen = {}

    async def fake(method, path, body=""):
        seen["path"] = path
        return {"led": "dim"}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/settings/info")
    assert r.status_code == 200
    assert seen["path"] == "/settings/info"


# --- Writes: /settings/info allow-list -------------------------------------

def test_info_patch_rejects_unknown_key(authed, monkeypatch):
    called = {}

    async def fake_patch(path, payload):
        called["hit"] = True
        return 200, {}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/info", json={"bogus": 1})
    assert r.status_code == 400
    assert "hit" not in called


def test_info_patch_rejects_multiple_keys(authed, monkeypatch):
    async def fake_patch(path, payload):
        return 200, {}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/info", json={"led": "on", "audio": "aac"})
    assert r.status_code == 400


def test_info_patch_forwards_one_key(authed, monkeypatch):
    seen = {}

    async def fake_patch(path, payload):
        seen["path"], seen["payload"] = path, payload
        return 200, {"led": "dim"}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/info", json={"led": "dim"})
    assert r.status_code == 200
    assert seen == {"path": "/settings/info", "payload": {"led": "dim"}}
    assert r.json() == {"led": "dim"}


def test_led_bad_value_rejected(authed, monkeypatch):
    async def fake_patch(path, payload):
        return 200, {}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    assert client.patch("/api/settings/info",
                        json={"led": "blinky"}).status_code == 400


def test_bool_key_rejects_non_bool(authed, monkeypatch):
    async def fake_patch(path, payload):
        return 200, {}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    assert client.patch("/api/settings/info",
                        json={"enable_amplifier": "yes"}).status_code == 400


def test_audio_toggle_accepts_aac(authed, monkeypatch):
    seen = {}

    async def fake_patch(path, payload):
        seen["payload"] = payload
        return 200, {"audio": "aac"}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/info", json={"audio": "aac"})
    assert r.status_code == 200 and seen["payload"] == {"audio": "aac"}


def test_device_refusal_surfaces_its_words(authed, monkeypatch):
    async def fake_patch(path, payload):
        return 400, {"error": {"description": "amplifier is not present"}}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/info", json={"enable_amplifier": True})
    assert r.status_code == 400
    assert r.json()["detail"] == "amplifier is not present"


# --- Writes: rename --------------------------------------------------------

def test_rename_forwards(authed, monkeypatch):
    seen = {}

    async def fake_patch(path, payload):
        seen["path"], seen["payload"] = path, payload
        return 200, {"name": "Den"}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/name", json={"name": "Den"})
    assert r.status_code == 200
    assert seen["path"] == "/server/info" and seen["payload"] == {"name": "Den"}


def test_rename_rejects_empty(authed, monkeypatch):
    called = {}

    async def fake_patch(path, payload):
        called["hit"] = True
        return 200, {}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/name", json={"name": "   "})
    assert r.status_code == 400 and "hit" not in called


# --- Channels --------------------------------------------------------------

def test_channels_lineup_flattens_discovered(authed, monkeypatch):
    async def fake(method, path, body=""):
        if path == "/channels/info":
            return {"committed_scan": "/channels/scans/77"}
        if path == "/channels/scans/77/discovered":
            return ["/channels/scans/discovered/1", "/channels/scans/discovered/2"]
        if path == "/channels/scans/discovered/1":
            return {"selected": True, "signal_state": "good",
                    "channel": {"call_sign": "KSPS", "channel_identifier": "S1",
                                "resolution": "hd_1080"}}
        if path == "/channels/scans/discovered/2":
            return {"selected": False, "channel": {"call_sign": "KREM"}}
        return {}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/settings/channels")
    assert r.status_code == 200
    body = r.json()
    assert body["scan_id"] == "77"
    assert body["channels"][0]["call_sign"] == "KSPS"
    assert body["channels"][0]["selected"] is True
    assert body["channels"][1]["selected"] is False


def test_channels_lineup_no_committed_scan(authed, monkeypatch):
    async def fake(method, path, body=""):
        return {"committed_scan": None}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/settings/channels")
    assert r.json() == {"scan_id": None, "channels": []}


def test_scan_start(authed, monkeypatch):
    async def fake(method, path, body=""):
        assert method == "POST" and path == "/channels/scans"
        return {"object_id": "68", "progress": 0.001, "completed": False}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.post("/api/settings/channels/scan")
    assert r.json() == {"scan_id": "68", "progress": 0.001, "completed": False}


def test_scan_status(authed, monkeypatch):
    async def fake(method, path, body=""):
        return {"progress": 0.93, "completed": False}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/settings/channels/scan/68")
    assert r.json() == {"progress": 0.93, "completed": False}


def test_commit_forwards_the_array(authed, monkeypatch):
    seen = {}

    async def fake_request(method, path, body=""):
        seen["method"], seen["path"], seen["body"] = method, path, body
        return {}
    monkeypatch.setattr(app_state, "request_device", fake_request)
    paths = ["/channels/scans/discovered/1", "/channels/scans/discovered/2"]
    r = client.post("/api/settings/channels/commit",
                    json={"scan_id": "77", "paths": paths})
    assert r.status_code == 200
    assert seen["method"] == "POST"
    assert seen["path"] == "/channels/scans/77/commit"
    assert json.loads(seen["body"]) == paths
    assert r.json() == {"ok": True, "count": 2}


# --- No-op writes ----------------------------------------------------------

def test_guide_update_triggers_a_refresh(authed, monkeypatch):
    seen = {}

    async def fake(method, path, body=""):
        seen["method"], seen["path"] = method, path
        return {}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.post("/api/settings/guide/update")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "noop": False}
    assert seen == {"method": "POST", "path": "/server/guide/refresh"}


def test_noop_location_set(authed, monkeypatch):
    async def fake(*a, **k):
        raise AssertionError("must not touch device")
    monkeypatch.setattr(app_state, "patch_device", fake)
    r = client.patch("/api/settings/location", json={"postal_code": "97201"})
    assert r.status_code == 200 and r.json()["noop"] is True
