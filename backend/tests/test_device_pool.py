"""The device pool recovers from a link that dropped underneath it.

The Tablo is reached over Tailscale. When that link goes away the pooled
keep-alive connections are dead but still handed out, so every device call sits
until its timeout and then fails with an ``httpx.ReadTimeout`` whose ``str()``
is the empty string - which the routes format as ``f"Device error: {e}"`` and so
reached the viewer as ``Device error: `` and nothing else. Database-backed
routes kept answering in two milliseconds throughout, which is the giveaway and
is how it was found.

Restarting the backend cleared it every time. All restarting did was build a new
pool, which is what these tests are about.
"""

import asyncio

import httpx
import pytest
from tablo_api.models import TabloDevice

from app.state import AppState, DeviceUnreachable


class FakeResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return {"ok": True}


class FakeClient:
    """Fails its first ``fail_times`` requests at the transport, then answers."""

    def __init__(self, fail_times: int = 0, **_kwargs):
        self.fail_times = fail_times
        self.requests = 0
        self.closed = False

    async def request(self, *_args, **_kwargs):
        self.requests += 1
        # A real request yields to the loop before it can fail, and that is what
        # lets a dozen callers all be in flight on the same dead pool at once.
        # Without this the coroutines run to completion one at a time, the first
        # failure resets the pool before the second is ever attempted, and the
        # concurrency test below passes whether or not the guard exists.
        await asyncio.sleep(0)
        if self.requests <= self.fail_times:
            # Empty message deliberately: that is the exception as it actually
            # arrives, and the reason a dropped link was unreadable from the UI.
            raise httpx.ReadTimeout("")
        return FakeResponse()

    async def aclose(self):
        self.closed = True


@pytest.fixture
def app_state(monkeypatch):
    state = AppState()
    state.active_device = TabloDevice(
        sid="SID_TEST",
        name="Tablo",
        local_url="http://127.0.0.1:8885",
        lighthouse_token="lh",
        account_token="acct",
        client_id="client",
    )
    # `_request_device_raw` imports TabloAuth inside the function, so the class
    # attribute is what it reaches. Signing is not what is under test here.
    monkeypatch.setattr(
        "tablo_api.TabloAuth.make_device_auth",
        staticmethod(lambda *a, **k: ("auth", "date")),
    )
    return state


def test_a_dead_pool_is_replaced_and_the_call_retried(app_state, monkeypatch):
    first = FakeClient(fail_times=1)
    second = FakeClient(fail_times=0)
    app_state._device_http = first
    monkeypatch.setattr("app.state.httpx.AsyncClient", lambda **kw: second)

    result = asyncio.run(app_state.request_device("GET", "/server/info"))

    assert result == {"ok": True}
    assert first.closed, "the dead pool must be closed, not merely dropped"
    assert second.requests == 1, "the retry goes out on the new pool"


def test_a_second_failure_says_what_failed(app_state, monkeypatch):
    app_state._device_http = FakeClient(fail_times=2)
    monkeypatch.setattr(
        "app.state.httpx.AsyncClient", lambda **kw: FakeClient(fail_times=2)
    )

    with pytest.raises(DeviceUnreachable) as excinfo:
        asyncio.run(app_state.request_device("GET", "/server/info"))

    # The whole point. ``str(httpx.ReadTimeout(""))`` is the empty string, so
    # the viewer's entire error message was ``Device error: ``.
    message = str(excinfo.value)
    assert message.strip(), "the message must not be empty"
    assert "/server/info" in message
    assert "GET" in message
    assert "ReadTimeout" in message


def test_concurrent_failures_rebuild_the_pool_once(app_state, monkeypatch):
    # A guide build fails a dozen calls at once when the link drops. Without the
    # generation guard each one swaps in a pool of its own and the retries
    # scatter across a dozen fresh connections.
    app_state._device_http = FakeClient(fail_times=12)
    replacements = [FakeClient(fail_times=0) for _ in range(12)]
    handed_out = iter(replacements)
    monkeypatch.setattr(
        "app.state.httpx.AsyncClient", lambda **kw: next(handed_out)
    )

    async def run():
        return await asyncio.gather(
            *(app_state.request_device("GET", f"/p{i}") for i in range(12))
        )

    assert asyncio.run(run()) == [{"ok": True}] * 12

    used = [c for c in replacements if c.requests > 0]
    assert len(used) == 1, f"retries went out on {len(used)} pools, expected one"


def test_a_healthy_call_never_touches_the_pool(app_state, monkeypatch):
    # The reset is for a link that dropped, not a cost paid on every request.
    client = FakeClient(fail_times=0)
    app_state._device_http = client
    monkeypatch.setattr(
        "app.state.httpx.AsyncClient",
        lambda **kw: pytest.fail("built a new pool for a call that succeeded"),
    )

    asyncio.run(app_state.request_device("GET", "/server/info"))

    assert client.requests == 1
    assert not client.closed


def test_the_cloud_client_is_left_alone(app_state, monkeypatch):
    # Separate clients on purpose: closing a shared pool to fix a device problem
    # would abort in-flight cloud requests, and the observed failure was
    # device-only - cloud and database routes answered in milliseconds
    # throughout.
    cloud = app_state._http
    app_state._device_http = FakeClient(fail_times=1)
    monkeypatch.setattr(
        "app.state.httpx.AsyncClient", lambda **kw: FakeClient(fail_times=0)
    )

    asyncio.run(app_state.request_device("GET", "/server/info"))

    assert app_state._http is cloud
    assert not cloud.is_closed
