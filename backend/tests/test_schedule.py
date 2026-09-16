"""Recording management: the device write path and the routes over it."""

import asyncio

from app.state import AppState


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
