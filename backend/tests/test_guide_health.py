"""A failed guide build must not be mistaken for a thin schedule.

The grid once went blank for an hour with nothing in any log. A build had lost
almost all of its device calls, each one swallowed; every row fell through to
the cloud fallback and came out holding a single currently-airing programme.
That was written to the database, passed the freshness check that only rejects a
guide with no airings at all, and was served from cache until those programmes
ended - after which the grid drew nothing and kept drawing nothing.

These cover the two halves of that: a build that loses its data raises instead
of returning, and a stored guide is judged by how far it reaches rather than by
whether it has any airings left.
"""

import asyncio
import time

import pytest

from app import store
from app.state import AppState, GuideFetchIncomplete


def _airing(start_epoch: int, duration: int = 3600) -> dict:
    return {
        "title": "Survivor", "subtitle": "", "description": "",
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start_epoch)),
        "duration": duration, "genres": [], "kind": "episode",
    }


def _rows(airings: list[dict]) -> list[dict]:
    return [{"identifier": "ch1", "airings": airings}]


# --------------------------------------------------------------- forward reach

def test_forward_seconds_measures_the_span_still_to_come():
    now = time.time()
    rows = _rows([_airing(int(now - 1800)), _airing(int(now + 7200))])
    assert store.guide_forward_seconds(rows, now=now) == pytest.approx(10_800, abs=2)


def test_forward_seconds_is_zero_once_everything_has_ended():
    now = time.time()
    assert store.guide_forward_seconds(_rows([_airing(int(now - 7200))]), now=now) == 0


def test_forward_seconds_ignores_unparseable_starts():
    rows = _rows([{"start": "not a date", "duration": 3600}])
    assert store.guide_forward_seconds(rows, now=time.time()) == 0


# ------------------------------------------------------------- the build guard

def _state() -> AppState:
    return AppState()


def _complete(st, channels=23, airings=1000, failed_channels=0, failed_airings=0,
              idents=True, strict=True):
    """Run the health check as a build with this much loss would."""
    st._assert_fetch_complete(
        [f"/guide/channels/{i}" for i in range(channels)],
        [f"/guide/airings/{i}" for i in range(airings)],
        {"channel": failed_channels, "airing": failed_airings},
        {"channel": "ReadTimeout: timed out", "airing": "ReadTimeout: timed out"},
        {"/guide/channels/0": "S1_007_01"} if idents else {},
        strict=strict,
    )


def test_a_healthy_build_passes():
    _complete(_state())


def test_losing_most_airings_is_a_failure_not_a_thin_schedule():
    with pytest.raises(GuideFetchIncomplete) as e:
        _complete(_state(), failed_airings=970)
    assert "970/1000 airing fetches failed" in str(e.value)
    assert "ReadTimeout" in str(e.value)  # says what actually went wrong


def test_losing_the_channel_details_is_a_failure():
    """These carry the join key, so losing them empties every row at once."""
    with pytest.raises(GuideFetchIncomplete):
        _complete(_state(), failed_channels=20)


def test_a_join_key_that_resolved_nothing_is_a_failure():
    """The exact shape of the incident: calls 'succeeded', nothing usable came back."""
    with pytest.raises(GuideFetchIncomplete) as e:
        _complete(_state(), idents=False)
    assert "fall back to its current programme" in str(e.value)


def test_a_little_loss_is_tolerated():
    """The device drops the odd request under transcode load; that is survivable."""
    _complete(_state(), failed_airings=100)


def test_an_empty_line_up_is_not_a_failure():
    """No channels at all is a real answer, and dividing by it is not."""
    _complete(_state(), channels=0, airings=0, idents=False)


# ------------------------------------------------- the build, end to end

class _FakeDevice:
    """Enough of a device for _build_grid_enrichment to think it has one."""


async def _run_build(monkeypatch, *, airing_fails: bool):
    """A build where the airing details all fail, or all succeed."""
    st = AppState()
    st.active_device = _FakeDevice()

    async def request_device(method, path, body=""):
        if path == "/guide/channels":
            return ["/guide/channels/1"]
        if path == "/guide/airings":
            return [f"/guide/airings/{i}" for i in range(10)]
        if path.startswith("/guide/channels/"):
            return {"path": path, "channel": {"channel_identifier": "S1_007_01", "logos": []}}
        if airing_fails:
            raise TimeoutError("device busy")
        return {"airing_details": {
            "channel_path": "/guide/channels/1", "show_title": "Survivor",
            "datetime": "2026-09-16T04:00:00Z", "duration": 3600,
        }}

    async def no_cloud():
        return {}, {}

    monkeypatch.setattr(st, "request_device", request_device)
    monkeypatch.setattr(st, "_fetch_cloud_data", no_cloud)
    return st, await st._build_grid_enrichment()


def test_a_healthy_build_is_cached(monkeypatch):
    st, (_, _idents, channel_to_airings, _) = asyncio.run(
        _run_build(monkeypatch, airing_fails=False))
    assert channel_to_airings["/guide/channels/1"]
    assert st._grid_cache is not None


def test_a_failed_build_never_reaches_the_cache(monkeypatch):
    """The hour-long blank grid was a bad build being *kept*, not a bad fetch."""
    with pytest.raises(GuideFetchIncomplete):
        asyncio.run(_run_build(monkeypatch, airing_fails=True))


def test_a_failed_listing_stops_the_build_before_it_starts(monkeypatch):
    st = AppState()
    st.active_device = _FakeDevice()

    async def request_device(method, path, body=""):
        raise TimeoutError("device busy")

    async def no_cloud():
        return {}, {}

    monkeypatch.setattr(st, "request_device", request_device)
    monkeypatch.setattr(st, "_fetch_cloud_data", no_cloud)
    with pytest.raises(GuideFetchIncomplete) as e:
        asyncio.run(st._build_grid_enrichment())
    assert "/guide/channels" in str(e.value)
    assert st._grid_cache is None


# ------------------------------------------------ the background history sync

def test_the_history_sync_keeps_what_a_degraded_run_collected():
    """`strict=False` reports the loss without throwing the work away.

    The sync exists because the device's guide is forward-looking: a period
    never captured is a permanent hole. Three quarters of a sync is worth
    keeping where none of it is not, and `save_guide` only appends, so a
    partial run cannot cost anything already stored.
    """
    _complete(_state(), failed_airings=970, strict=False)


def test_the_interactive_grid_still_refuses_the_same_run():
    with pytest.raises(GuideFetchIncomplete):
        _complete(_state(), failed_airings=970, strict=True)
