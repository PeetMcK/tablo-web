"""Search index, ranking and guide retention."""

from app import db


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
