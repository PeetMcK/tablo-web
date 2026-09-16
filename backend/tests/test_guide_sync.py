"""The guide mirror is a record of what aired, not a snapshot of the device."""

import asyncio
import sqlite3
import time

import pytest

from app import db, guide_sync, store


def _channel(ident: str, airings: list[dict]) -> dict:
    return {
        "identifier": ident, "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "CBS", "display_name": "KPAX", "logo_url": None,
        "kind": "ota", "airings": airings,
    }


def _airing(title: str, start_epoch: int, duration: int = 3600) -> dict:
    return {
        "title": title, "subtitle": "", "description": "",
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start_epoch)),
        "duration": duration, "genres": [], "kind": "episode",
    }


def test_episode_fields_round_trip():
    """The sheet needs these; the grid ignores them."""
    now = time.time()
    air = _airing("Finding Your Roots", int(now + 3600))
    air.update({
        "episode_title": "Rags to Riches",
        "season_number": 12,
        "episode_number": 10,
        "orig_air_date": "2026-09-16",
        "series_path": "/guide/series/6472",
        "airing_path": "/guide/series/episodes/67388",
        "schedule_state": "none",
        "schedule_qualifier": "none",
        "skip_reason": "none",
    })
    store.save_guide([_channel("ch1", [air])], now=now)

    got = store.load_guide(now=now)[0]["airings"][0]
    assert got["episode_title"] == "Rags to Riches"
    assert got["season_number"] == 12
    assert got["episode_number"] == 10
    assert got["airing_path"] == "/guide/series/episodes/67388"
    assert got["series_path"] == "/guide/series/6472"


def test_an_airing_without_episode_fields_still_saves():
    """Most airings have no episode data; nulls must not break the write."""
    now = time.time()
    store.save_guide([_channel("ch1", [_airing("Bare", int(now + 3600))])], now=now)
    got = store.load_guide(now=now)[0]["airings"][0]
    assert got["episode_title"] is None
    assert got["season_number"] is None


def test_a_later_sync_does_not_wipe_earlier_airings():
    """`DELETE FROM guide_channel` cascaded to guide_airing and erased history.

    The device guide is forward-looking - once a programme airs it falls off,
    and no later request recovers it. A sync that drops what it no longer sees
    destroys the only copy there will ever be.
    """
    now = time.time()
    yesterday = int(now - 86_400)

    store.save_guide([_channel("ch1", [_airing("Survivor", yesterday)])], now=now)
    store.save_guide([_channel("ch1", [_airing("Tomorrow", int(now + 3600))])], now=now)

    titles = {r["title"] for r in db.query("SELECT title FROM guide_airing")}
    assert "Survivor" in titles      # still here despite the device forgetting it
    assert "Tomorrow" in titles


def test_an_ended_airing_is_written_rather_than_skipped():
    now = time.time()
    store.save_guide([_channel("ch1", [_airing("Finished", int(now - 7200))])], now=now)
    assert db.query("SELECT 1 FROM guide_airing WHERE title = 'Finished'")


def test_retention_prunes_only_beyond_the_window():
    now = time.time()
    day = 86_400
    store.save_guide([_channel("ch1", [
        _airing("Recent", int(now - 30 * day)),
        _airing("Ancient", int(now - 32 * day)),
    ])], now=now)

    removed = store.prune_guide(now=now)

    titles = {r["title"] for r in db.query("SELECT title FROM guide_airing")}
    assert "Recent" in titles
    assert "Ancient" not in titles
    assert removed == 1


def test_the_grid_still_sees_only_the_future():
    """History is searchable; the grid must not render finished airings."""
    now = time.time()
    store.save_guide([_channel("ch1", [
        _airing("Over", int(now - 7200)),
        _airing("Coming", int(now + 3600)),
    ])], now=now)

    grid = store.load_guide(now=now)
    shown = {a["title"] for ch in grid for a in ch["airings"]}
    assert shown == {"Coming"}


def test_a_channel_dropped_from_the_latest_sync_disappears_from_the_grid():
    """No delete happens - the row is just no longer the freshest sync.

    guide_channel rows are upserted, never deleted, because a channel carries
    its airing history through the CASCADE on guide_airing. A channel the
    device stops listing must still vanish from the grid (the old, correct,
    now-broken-by-append-only behaviour) - that comes from load_guide
    filtering to the latest sync's stamp, not from removing the row.
    """
    now = time.time()
    store.save_guide([
        _channel("ch1", [_airing("Keeps", int(now + 3600))]),
        _channel("ch2", [_airing("Gone", int(now + 3600))]),
    ], now=now)
    store.save_guide([_channel("ch1", [_airing("Keeps", int(now + 3600))])], now=now)

    idents = {c["identifier"] for c in store.load_guide(now=now)}
    assert idents == {"ch1"}

    # ch2 itself was never deleted - only excluded from the grid read.
    assert db.query("SELECT 1 FROM guide_channel WHERE identifier = 'ch2'")
    assert db.query("SELECT 1 FROM guide_airing WHERE title = 'Gone'")


def test_a_current_channel_with_nothing_in_the_window_still_shows_an_empty_row():
    """Distinguish 'dropped by the device' from 'nothing airing right now'.

    Both look like an empty-ish result, but only the first should make the
    channel disappear. A channel still in the latest sync keeps its row even
    when every one of its airings falls outside the read window.
    """
    now = time.time()
    store.save_guide([_channel("ch1", [_airing("Over", int(now - 7200))])], now=now)

    grid = store.load_guide(now=now)
    assert [c["identifier"] for c in grid] == ["ch1"]
    assert grid[0]["airings"] == []


def test_a_sync_records_its_coverage():
    async def fetch():
        return [_channel("ch1", [_airing("Survivor", int(time.time() + 3600))])]

    seen = asyncio.run(guide_sync.sync_once(fetch))

    assert seen == 1
    row = db.query_one("SELECT * FROM guide_sync ORDER BY id DESC LIMIT 1")
    assert row["ok"] == 1
    assert row["airings_seen"] == 1
    assert row["finished_at"]


def test_a_failed_sync_is_recorded_and_does_not_raise():
    """A stale mirror still serves search; returning nothing would be worse."""
    async def fetch():
        raise RuntimeError("device unreachable")

    seen = asyncio.run(guide_sync.sync_once(fetch))

    assert seen == 0
    row = db.query_one("SELECT * FROM guide_sync ORDER BY id DESC LIMIT 1")
    assert row["ok"] == 0
    assert "unreachable" in row["error"]


def test_a_failed_sync_does_not_delete_history():
    now = time.time()
    store.save_guide([_channel("ch1", [_airing("Kept", int(now - 3600))])], now=now)

    async def fetch():
        raise RuntimeError("device unreachable")

    asyncio.run(guide_sync.sync_once(fetch))
    assert db.query("SELECT 1 FROM guide_airing WHERE title = 'Kept'")


def test_sync_once_does_not_double_write_the_guide(monkeypatch):
    """`fetch` (state.get_grid_guide in production) already persists the rows;
    sync_once must not save them again - that would double an ~8455-row write
    and double the FTS trigger firing on every cycle."""
    calls = []
    monkeypatch.setattr(store, "save_guide", lambda *a, **k: calls.append((a, k)))

    async def fetch():
        return [_channel("ch1", [_airing("Survivor", int(time.time() + 3600))])]

    seen = asyncio.run(guide_sync.sync_once(fetch))

    assert seen == 1
    assert calls == []


def test_sync_once_survives_a_failure_starting_the_run(monkeypatch):
    """The opening INSERT that allocates `run_id` can itself fail (disk full,
    lock contention). That must not escape sync_once's 'never raises'
    contract just because it happens before the main try block."""
    def boom_write():
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(db, "write", boom_write)

    async def fetch():
        return [_channel("ch1", [_airing("Survivor", int(time.time() + 3600))])]

    seen = asyncio.run(guide_sync.sync_once(fetch))

    assert seen == 0


def test_sync_once_survives_even_when_recording_the_outcome_fails(monkeypatch):
    """Critical: the guide_sync UPDATE (recording success OR failure) can
    itself fail. A test that only covers fetch() failing does not exercise
    this - here fetch succeeds, and it is *recording that* which breaks, and
    then recording the resulting failure breaks too. Neither may escape."""
    def boom_execute(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(db, "execute", boom_execute)

    async def fetch():
        return [_channel("ch1", [_airing("Survivor", int(time.time() + 3600))])]

    seen = asyncio.run(guide_sync.sync_once(fetch))

    assert seen == 0


def test_run_forever_survives_a_sync_once_that_raises(monkeypatch):
    """Belt and braces: even though sync_once is documented never to raise,
    run_forever must not let one unlucky exception silently kill background
    syncing for the rest of the process's life.

    `StopTest` is deliberately a `BaseException`, not an `Exception` - the
    broad `except Exception` guard around the `sync_once` call must NOT
    swallow it, since that would (a) prove the guard is too broad and (b)
    hang this test in an infinite loop. It is raised from the sleep call,
    which sits outside that guard, once the loop has proven it survived the
    first exception and reached a second iteration.
    """
    calls = {"n": 0}

    class StopTest(BaseException):
        pass

    async def boom(fetch):
        calls["n"] += 1
        raise RuntimeError("boom")

    async def fake_sleep(_seconds):
        raise StopTest()

    monkeypatch.setattr(guide_sync, "sync_once", boom)
    monkeypatch.setattr(guide_sync.asyncio, "sleep", fake_sleep)

    async def fetch():
        return []

    with pytest.raises(StopTest):
        asyncio.run(guide_sync.run_forever(fetch))

    # The loop reached the sleep call at all only because the RuntimeError
    # from sync_once was caught rather than propagating out of run_forever.
    assert calls["n"] == 1


def test_backfill_index_reindexes_what_is_already_stored():
    """Migration creates empty index tables; this is what makes search work
    before the first sync completes, rather than looking like a broken
    feature until then."""
    now = time.time()
    store.save_guide([_channel("ch1", [_airing("Survivor", int(now + 3600))])], now=now)
    db.execute("DELETE FROM search_doc")
    assert not db.query("SELECT 1 FROM search_doc WHERE kind = 'airing'")

    indexed = asyncio.run(guide_sync.backfill_index())

    assert indexed == 1
    assert db.query("SELECT 1 FROM search_doc WHERE kind = 'airing'")


def test_one_channel_airings_start_at_what_is_on_now():
    """The live player asks "what is on this channel, and what is next".

    Everything that has already ended is behind the viewer - the DVR window
    holds none of it - so the list starts with whatever covers the current
    moment and runs forward.
    """
    now = time.time()
    store.save_guide([_channel("ch1", [
        _airing("Over", int(now - 7200)),
        _airing("On now", int(now - 900)),
        _airing("Up next", int(now + 2700)),
    ]), _channel("ch2", [_airing("Elsewhere", int(now - 900))])], now=now)

    airings = store.channel_airings("ch1", now=now)

    assert [a["title"] for a in airings] == ["On now", "Up next"]


def test_one_channel_airings_carry_what_the_player_renders():
    now = time.time()
    store.save_guide(
        [_channel("ch1", [_airing("On now", int(now - 900), duration=1800)])],
        now=now,
    )

    (airing,) = store.channel_airings("ch1", now=now)

    assert airing["title"] == "On now"
    assert airing["duration"] == 1800
    assert airing["start"]
    assert airing["genres"] == []


def test_an_unknown_channel_has_no_airings():
    assert store.channel_airings("nobody", now=time.time()) == []
