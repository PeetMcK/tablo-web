"""Search index, ranking and guide retention."""

import time

from app import db, store


def test_schema_is_at_version_two():
    row = db.query_one("PRAGMA user_version")
    assert row[0] == 2


def test_index_tables_exist():
    names = {
        r["name"]
        for r in db.query(
            "SELECT name FROM sqlite_master WHERE type IN ('table','trigger')"
        )
    }
    assert {"guide_sync", "search_doc", "search_fts"} <= names


def test_fts_follows_a_delete():
    """External-content FTS5 goes stale without triggers.

    Verified before writing this: deleting the row with no trigger left it
    matching. The triggers are load-bearing, not tidiness.
    """
    with db.write() as conn:
        conn.execute(
            "INSERT INTO search_doc(kind, ref, title, subtitle, body, channel, "
            "                       start_epoch, duration, target) "
            "VALUES ('airing', 'a|1', 'Broncos at Chiefs', '', 'football', "
            "        '8.1 CBS', 100, 3600, '{}')",
        )
    assert db.query("SELECT 1 FROM search_fts WHERE search_fts MATCH 'broncos'")

    with db.write() as conn:
        conn.execute("DELETE FROM search_doc WHERE ref = 'a|1'")
    assert not db.query("SELECT 1 FROM search_fts WHERE search_fts MATCH 'broncos'")


def _ch(ident="ch1", **kw):
    base = {
        "identifier": ident, "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "CBS", "display_name": "KPAX", "logo_url": None,
        "kind": "ota", "airings": [],
    }
    base.update(kw)
    return base


def test_saving_the_guide_indexes_channels_and_airings():
    now = time.time()
    store.save_guide([_ch(airings=[{
        "title": "Survivor", "subtitle": "Finale", "description": "Last castaway",
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 3600)),
        "duration": 3600, "genres": ["reality"], "kind": "episode",
    }])], now=now)

    kinds = {r["kind"]: r for r in db.query("SELECT kind, title, channel FROM search_doc")}
    assert kinds["channel"]["title"] == "KPAX"
    assert kinds["airing"]["title"] == "Survivor"
    assert kinds["airing"]["channel"] == "8.1 CBS"


def test_reindexing_the_same_airing_does_not_duplicate_it():
    now = time.time()
    air = {
        "title": "Survivor", "subtitle": "", "description": "",
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 3600)),
        "duration": 3600, "genres": [], "kind": "episode",
    }
    store.save_guide([_ch(airings=[air])], now=now)
    store.save_guide([_ch(airings=[air])], now=now)

    rows = db.query("SELECT 1 FROM search_doc WHERE kind = 'airing'")
    assert len(rows) == 1


def test_pruning_an_airing_removes_it_from_the_index():
    now = time.time()
    store.save_guide([_ch(airings=[{
        "title": "Ancient", "subtitle": "", "description": "",
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 32 * 86400)),
        "duration": 3600, "genres": [], "kind": "episode",
    }])], now=now)
    store.prune_guide(now=now)

    assert not db.query("SELECT 1 FROM search_doc WHERE title = 'Ancient'")
    assert not db.query("SELECT 1 FROM search_fts WHERE search_fts MATCH 'ancient'")
