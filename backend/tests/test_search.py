"""Search index, ranking and guide retention."""

import json
import time

from app import db, store
from app import search as search_mod


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


def test_reindexing_does_not_leave_the_old_title_in_the_index():
    """INSERT OR REPLACE does not fire the delete trigger, so a replaced row
    left its terms in FTS forever while the new terms were added beside them.
    Counting search_doc rows cannot see this; only FTS can.
    """
    now = time.time()
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 3600))
    store.save_guide([_ch(airings=[{
        "title": "Broncos at Chiefs", "subtitle": "", "description": "",
        "start": start, "duration": 3600, "genres": [], "kind": "episode",
    }])], now=now)
    store.save_guide([_ch(airings=[{
        "title": "Seahawks at Rams", "subtitle": "", "description": "",
        "start": start, "duration": 3600, "genres": [], "kind": "episode",
    }])], now=now)

    assert not db.query("SELECT 1 FROM search_fts WHERE search_fts MATCH 'broncos'")
    assert db.query("SELECT 1 FROM search_fts WHERE search_fts MATCH 'seahawks'")


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


def test_recordings_are_indexed_from_a_listing():
    """The device is the source of truth for the library, not our table.

    `recording` holds cache bookkeeping for the few we have transcoded, with
    the title buried in an `info` blob - so the index is fed from the listing.
    """
    store.index_recordings([{
        "object_id": 80888,
        "title": "NFL Football",
        "subtitle": "Denver Broncos at Kansas City Chiefs",
        "description": "AFC West matchup at Arrowhead Stadium.",
        "start": "2026-09-15T00:15:00Z",
        "duration": 12615,
        "channel": {"call_sign": "KTMFABC", "network": "ABC", "number": "23.1"},
    }])

    row = db.query_one("SELECT * FROM search_doc WHERE kind = 'recording'")
    assert row["title"] == "NFL Football"
    assert row["channel"] == "23.1 ABC"
    assert json.loads(row["target"]) == {"tab": "library", "watch": 80888}


def test_relisting_does_not_duplicate_a_recording():
    item = {"object_id": 1, "title": "A", "subtitle": "", "description": "",
            "start": "2026-09-15T00:15:00Z", "duration": 60, "channel": None}
    store.index_recordings([item])
    store.index_recordings([item])
    assert len(db.query("SELECT 1 FROM search_doc WHERE kind = 'recording'")) == 1


def test_reindexing_a_recording_does_not_leave_the_old_title_in_fts():
    """Regression test for the INSERT OR REPLACE bug: reindexing the same
    object_id under a new title must not leave the old title still matching
    in `search_fts`, and must make the new title findable. Asserted on FTS
    contents rather than `search_doc` row counts, since a row-count check
    passes even when the index is corrupt - which is how the bug survived
    its first review.
    """
    store.index_recordings([{
        "object_id": 80888,
        "title": "Broncos at Chiefs",
        "subtitle": "", "description": "",
        "start": "2026-09-15T00:15:00Z", "duration": 3600,
        "channel": {"call_sign": "KTMFABC", "network": "ABC", "number": "23.1"},
    }])
    store.index_recordings([{
        "object_id": 80888,
        "title": "Seahawks at Cardinals",
        "subtitle": "", "description": "",
        "start": "2026-09-15T00:15:00Z", "duration": 3600,
        "channel": {"call_sign": "KTMFABC", "network": "ABC", "number": "23.1"},
    }])

    assert not db.query("SELECT 1 FROM search_fts WHERE search_fts MATCH 'broncos'")
    assert db.query("SELECT 1 FROM search_fts WHERE search_fts MATCH 'seahawks'")


def _doc(kind, ref, title, body="", channel="8.1 CBS", start=0):
    with db.write() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO search_doc(kind, ref, title, subtitle, body, "
            "    channel, start_epoch, duration, target) "
            "VALUES (?, ?, ?, '', ?, ?, ?, 3600, '{}')",
            (kind, ref, title, body, channel, start),
        )


def test_a_title_match_outranks_a_description_match():
    """Every surface truncates, so which results appear IS the feature."""
    _doc("airing", "a|1", "Broncos at Chiefs", body="afc west")
    _doc("airing", "a|2", "Cooking Show", body="filmed at the broncos ranch")
    for i in range(50):
        _doc("airing", f"f|{i}", f"Filler {i}", body="unrelated")

    items = search_mod.search("broncos", limit=5)["groups"][0]["items"]
    assert [i["title"] for i in items] == ["Broncos at Chiefs", "Cooking Show"]


def test_a_short_query_returns_empty_groups_rather_than_an_error():
    """Surfaces call on every keystroke; one character must not be a 400."""
    out = search_mod.search("b")
    assert out["groups"] == []
    assert out["query"] == "b"


def test_kinds_filters_the_result():
    _doc("airing", "a|1", "Survivor")
    _doc("recording", "1", "Survivor")
    out = search_mod.search("survivor", kinds=["recording"])
    assert [g["kind"] for g in out["groups"]] == ["recording"]


def test_total_counts_beyond_the_limit():
    for i in range(12):
        _doc("airing", f"a|{i}", f"Survivor {i}")
    group = search_mod.search("survivor", limit=3)["groups"][0]
    assert len(group["items"]) == 3
    assert group["total"] == 12


def test_groups_are_ordered_recording_then_airing_then_channel():
    _doc("channel", "c1", "Survivor Channel")
    _doc("airing", "a|1", "Survivor")
    _doc("recording", "1", "Survivor")
    out = search_mod.search("survivor")
    assert [g["kind"] for g in out["groups"]] == ["recording", "airing", "channel"]


def test_a_prefix_matches_a_partial_word():
    _doc("airing", "a|1", "Broncos at Chiefs")
    assert search_mod.search("bronc")["groups"][0]["items"][0]["title"] == "Broncos at Chiefs"


def test_punctuation_in_a_query_does_not_break_fts():
    """FTS5 MATCH has its own syntax; a bare apostrophe or quote is a syntax error."""
    _doc("airing", "a|1", "Rick Steves' Europe")
    out = search_mod.search('steves"')
    assert out["groups"]


def test_a_past_airing_says_whether_it_was_recorded():
    """Searching backwards is about whether you missed something."""
    aired = 1_760_000_000
    _doc("airing", "ch1|x", "Broncos at Chiefs", start=aired)
    with db.write() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO search_doc(kind, ref, title, subtitle, body, "
            "    channel, start_epoch, duration, target) "
            "VALUES ('recording', '80888', 'Broncos at Chiefs', '', '', "
            "        '8.1 CBS', ?, 3600, '{}')",
            (aired + 60,),        # a recording starts a touch late
        )

    item = search_mod.search("broncos", kinds=["airing"])["groups"][0]["items"][0]
    assert item["recorded"] == {"object_id": 80888}


def test_a_different_showing_of_the_same_title_is_not_claimed_as_recorded():
    """Repeats share a title; only a near-simultaneous start is the same showing."""
    aired = 1_760_000_000
    _doc("airing", "ch1|y", "Broncos at Chiefs", start=aired)
    with db.write() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO search_doc(kind, ref, title, subtitle, body, "
            "    channel, start_epoch, duration, target) "
            "VALUES ('recording', '999', 'Broncos at Chiefs', '', '', "
            "        '8.1 CBS', ?, 3600, '{}')",
            (aired + 1800,),      # half an hour off: a different showing
        )

    item = search_mod.search("broncos", kinds=["airing"])["groups"][0]["items"][0]
    assert item["recorded"] is None


def test_an_upcoming_airing_is_not_cross_referenced():
    import time
    _doc("airing", "ch1|z", "Future Game", start=int(time.time()) + 86_400)
    item = search_mod.search("future", kinds=["airing"])["groups"][0]["items"][0]
    assert item["recorded"] is None
