"""The guide mirror is a record of what aired, not a snapshot of the device."""

import time

from app import db, store


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
