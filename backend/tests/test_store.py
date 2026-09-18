"""Tests for SQLite persistence: migration, credentials, guide, resume."""

import json
from datetime import datetime, timedelta, timezone

from app import crypto, db, store

GAME = 12615


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def test_schema_is_created_and_versioned():
    db.connection()
    assert db.query_one("PRAGMA user_version")[0] == db.SCHEMA_VERSION


def test_schema_v3_adds_episode_fields_and_series_table():
    """Show information needs per-episode fields and a series record.

    The airing columns are nullable so existing rows keep working and
    backfill happens as syncs run, rather than in a migration step.
    """
    cols = {r["name"] for r in db.query("PRAGMA table_info(guide_airing)")}
    assert {"episode_title", "season_number", "episode_number", "orig_air_date",
            "series_path", "airing_path", "schedule_state", "schedule_qualifier",
            "skip_reason"} <= cols

    series_cols = {r["name"] for r in db.query("PRAGMA table_info(guide_series)")}
    assert {"path", "identifier", "title", "description", "genres", "rating",
            "orig_air_date", "episode_runtime", "cast", "cover_image_id",
            "thumbnail_image_id", "background_image_id", "schedule_rule",
            "keep_rule", "keep_count", "updated_at"} <= series_cols

    assert db.query_one("PRAGMA user_version")["user_version"] >= 3


def test_reopening_does_not_re_run_migrations():
    store.save_credentials("a@b.com", "pw")
    db.close()
    assert store.load_credentials() == ("a@b.com", "pw")


def test_database_file_is_not_world_readable(tmp_path):
    db.connection()
    assert db.DB_PATH.exists()
    assert db.DB_PATH.stat().st_mode & 0o077 == 0


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def test_password_round_trips():
    store.save_credentials("me@example.com", "hunter2")
    assert store.load_credentials() == ("me@example.com", "hunter2")


def test_password_is_not_stored_in_cleartext():
    """The whole point of the change: the secret must not be readable on disk."""
    store.save_credentials("me@example.com", "sup3r-s3cret-pw")
    db.close()
    assert b"sup3r-s3cret-pw" not in db.DB_PATH.read_bytes()


def test_stored_password_is_recoverable_only_with_the_key(monkeypatch, tmp_path):
    store.save_credentials("me@example.com", "hunter2")
    row = db.query_one("SELECT password_encrypted FROM credential WHERE id = 1")

    # A different key must not decrypt it; losing the key reads as "no
    # credentials", which surfaces the login screen rather than crashing.
    monkeypatch.setattr(crypto, "KEY_PATH", tmp_path / "other.key")
    assert crypto.decrypt(row["password_encrypted"]) is None
    assert store.load_credentials() is None


def test_saving_without_a_password_keeps_the_existing_one():
    store.save_credentials("me@example.com", "hunter2")
    store.save_credentials("me@example.com", None)
    assert store.load_credentials() == ("me@example.com", "hunter2")


def test_clearing_removes_credentials_and_devices():
    store.save_credentials("me@example.com", "hunter2")
    store.clear_credentials()
    assert store.load_credentials() is None


class _Device:
    def __init__(self, sid, name="Tablo"):
        self.sid = sid
        self.name = name
        self.local_url = f"http://10.0.0.5:8887/{sid}"
        self.lighthouse_token = f"lh-{sid}"
        self.account_token = "acct-token"
        self.client_id = "client-uuid"


def test_devices_round_trip_with_tokens():
    """Restoring these is what lets a restart skip re-authenticating."""
    store.save_credentials("me@example.com", "hunter2")
    store.save_devices([_Device("SID_A"), _Device("SID_B")], "SID_B")

    rows, active = store.load_devices()
    assert active == "SID_B"
    assert {r["sid"] for r in rows} == {"SID_A", "SID_B"}
    assert all(r["account_token"] == "acct-token" for r in rows)
    assert all(r["client_id"] == "client-uuid" for r in rows)


def test_active_device_can_be_changed():
    store.save_credentials("me@example.com", "hunter2")
    store.save_devices([_Device("SID_A"), _Device("SID_B")], "SID_A")
    store.set_active_device("SID_B")
    _, active = store.load_devices()
    assert active == "SID_B"


# ---------------------------------------------------------------------------
# Migration from the pre-database layout
# ---------------------------------------------------------------------------

def test_config_json_is_imported_once(tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"email": "me@example.com", "password": "hunter2"}))

    assert store.migrate_config(cfg) is True
    assert store.load_credentials() == ("me@example.com", "hunter2")
    # Idempotent: a second start must not reimport or duplicate.
    assert store.migrate_config(cfg) is False


def test_config_json_is_left_in_place(tmp_path):
    """One release of overlap, so a rollback does not lose the account."""
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"email": "me@example.com", "password": "hunter2"}))
    store.migrate_config(cfg)
    assert cfg.exists()


def test_migrating_a_missing_or_partial_config_is_harmless(tmp_path):
    assert store.migrate_config(tmp_path / "absent.json") is False
    partial = tmp_path / "partial.json"
    partial.write_text(json.dumps({"email": "me@example.com"}))
    assert store.migrate_config(partial) is False


def _write_meta(root, oid, **over):
    d = root / str(oid)
    d.mkdir(parents=True, exist_ok=True)
    meta = {
        "object_id": oid,
        "path": f"/recordings/x/{oid}",
        "source_duration": GAME,
        "created_at": "2026-09-01T00:00:00Z",
        "last_access": "2026-09-02T00:00:00Z",
        "error": None,
        "pinned": False,
        "info": None,
        "paused": False,
    }
    meta.update(over)
    (d / "meta.json").write_text(json.dumps(meta))


def test_meta_json_files_are_imported(tmp_path):
    root = tmp_path / "cache"
    _write_meta(root, 80888, pinned=True, info={"title": "NFL Football"})
    _write_meta(root, 66220)

    assert store.migrate_recordings(root) == 2
    assert store.pinned_recording_ids() == [80888]

    kept = store.read_recording(80888)
    assert kept["pinned"] is True
    assert kept["info"] == {"title": "NFL Football"}
    assert kept["source_duration"] == GAME


def test_meta_json_import_is_idempotent(tmp_path):
    root = tmp_path / "cache"
    _write_meta(root, 80888)
    assert store.migrate_recordings(root) == 1
    assert store.migrate_recordings(root) == 0
    assert len(store.all_recording_ids()) == 1


def test_meta_json_import_skips_unparseable_files(tmp_path):
    root = tmp_path / "cache"
    _write_meta(root, 80888)
    bad = root / "66220"
    bad.mkdir(parents=True)
    (bad / "meta.json").write_text("{not json")
    assert store.migrate_recordings(root) == 1


# ---------------------------------------------------------------------------
# Recording index
# ---------------------------------------------------------------------------

def test_eviction_candidates_are_oldest_first_and_exclude_pinned():
    for oid, when in ((1, "2026-01-01"), (2, "2026-06-01"), (3, "2026-09-01")):
        store.write_recording({
            "object_id": oid, "path": f"/r/{oid}", "source_duration": 60,
            "created_at": when, "last_access": when,
        })
    store.write_recording({
        "object_id": 4, "path": "/r/4", "source_duration": 60, "pinned": True,
        "created_at": "2025-01-01", "last_access": "2025-01-01",
    })
    assert store.eviction_candidates() == [1, 2, 3]


def test_deleting_a_recording_removes_it_from_the_index():
    store.write_recording({"object_id": 7, "path": "/r/7", "source_duration": 60})
    store.delete_recording(7)
    assert store.read_recording(7) is None


# ---------------------------------------------------------------------------
# Guide
# ---------------------------------------------------------------------------

def _iso(dt):
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _guide(now):
    future = now + timedelta(hours=1)
    past = now - timedelta(hours=3)
    return [{
        "identifier": "ch1",
        "call_sign": "KABC",
        "major": 7, "minor": 1,
        "network": "ABC",
        "display_name": "KABC-HD",
        "logo_url": "http://logo",
        "kind": "ota",
        "airings": [
            {"start": _iso(past), "duration": 1800, "title": "Over", "genres": ["news"]},
            {"start": _iso(future), "duration": 3600, "title": "Upcoming", "genres": []},
        ],
    }]


def test_guide_round_trips():
    now = datetime.now(timezone.utc)
    store.save_guide(_guide(now))
    rows = store.load_guide()
    assert len(rows) == 1
    assert rows[0]["call_sign"] == "KABC"
    assert rows[0]["logo_url"] == "http://logo"


def test_load_guide_hides_airings_that_have_ended_without_deleting_them():
    """Hidden at read, kept on disk - the name of this test used to say the
    opposite, which is the one thing the guide mirror must never do.

    Nothing is pruned on write. The device's guide is forward-looking, so an
    aired programme falls off it permanently and our copy is the only record
    that it happened; `prune_guide` removes rows by age and nothing else
    does. What `load_guide` gives back is a view for the grid, which has no
    use for a programme that has finished.
    """
    now = datetime.now(timezone.utc)
    store.save_guide(_guide(now))

    titles = [a["title"] for a in store.load_guide()[0]["airings"]]
    assert titles == ["Upcoming"]

    # Still stored, and still findable - this is the half the old name denied.
    stored = {r["title"] for r in db.query("SELECT title FROM guide_airing")}
    assert stored == {"Over", "Upcoming"}


def test_genres_survive_the_round_trip():
    now = datetime.now(timezone.utc)
    store.save_guide([{
        "identifier": "ch1",
        "airings": [{
            "start": _iso(now + timedelta(hours=1)),
            "duration": 3600,
            "title": "Game",
            "genres": ["sports", "football"],
        }],
    }])
    assert store.load_guide()[0]["airings"][0]["genres"] == ["sports", "football"]


def test_channel_order_is_preserved():
    now = _iso(datetime.now(timezone.utc) + timedelta(hours=1))
    rows = [
        {"identifier": f"ch{i}", "airings": [{"start": now, "duration": 60}]}
        for i in (3, 1, 2)
    ]
    store.save_guide(rows)
    assert [r["identifier"] for r in store.load_guide()] == ["ch3", "ch1", "ch2"]


def test_saving_the_guide_merges_rather_than_replacing():
    """A later sync must not wipe channels the device no longer lists.

    This used to assert the opposite - that a second save replaced the first -
    because save_guide issued `DELETE FROM guide_channel`, which cascaded to
    guide_airing and destroyed every previously stored airing. The device's
    guide is forward-looking, so that delete was unrecoverable. The mirror is
    now append-only: a channel or airing missing from a later sync is kept in
    storage, not dropped.

    `load_guide()` itself only returns the channels from the *latest* sync
    (ch1 stops appearing there once a second sync omits it) - that is a
    read-time filter on `guide_synced_at`, covered in test_guide_sync.py, not
    evidence that ch1's row was deleted. This test checks the storage layer
    directly to tell the two apart.
    """
    now = _iso(datetime.now(timezone.utc) + timedelta(hours=1))
    store.save_guide([{"identifier": "ch1", "airings": [{"start": now, "duration": 60}]}])
    store.save_guide([{"identifier": "ch2", "airings": [{"start": now, "duration": 60}]}])
    idents = {r["identifier"] for r in db.query("SELECT identifier FROM guide_channel")}
    assert idents == {"ch1", "ch2"}


def test_guide_age_reflects_the_last_write():
    assert store.guide_age_seconds() is None
    store.save_guide(_guide(datetime.now(timezone.utc)))
    age = store.guide_age_seconds()
    assert age is not None and age < 5


def test_guide_load_hides_airings_that_ended_since_the_write():
    """Stored data stays put; the read is what filters by the clock."""
    now = datetime.now(timezone.utc)
    store.save_guide([{
        "identifier": "ch1",
        "airings": [{"start": _iso(now), "duration": 600, "title": "Now"}],
    }], now=now.timestamp())
    later = (now + timedelta(hours=2)).timestamp()
    assert store.load_guide(now=later)[0]["airings"] == []


# ---------------------------------------------------------------------------
# Resume
# ---------------------------------------------------------------------------

def test_resume_round_trips():
    store.save_resume("recording", "80888", 1200.0, GAME)
    assert store.load_resume("recording", "80888") == 1200.0


def test_resume_is_not_stored_at_the_very_start():
    store.save_resume("recording", "80888", 5.0, GAME)
    assert store.load_resume("recording", "80888") == 0.0


def test_resume_is_cleared_near_the_end():
    """Resuming on the credits is worse than starting over."""
    store.save_resume("recording", "80888", 1200.0, GAME)
    store.save_resume("recording", "80888", GAME - 10, GAME)
    assert store.load_resume("recording", "80888") == 0.0


def test_unknown_resume_reads_as_zero():
    assert store.load_resume("recording", "nope") == 0.0


def test_importing_client_positions():
    imported = store.import_resume({"recording:80888": 1200.0, "live:ch1": 90.0})
    assert imported == 2
    assert store.load_resume("recording", "80888") == 1200.0
    assert store.load_resume("live", "ch1") == 90.0


def test_import_does_not_clobber_existing_positions():
    """A replayed payload must not rewind someone who has watched further."""
    store.save_resume("recording", "80888", 5000.0, GAME)
    assert store.import_resume({"recording:80888": 100.0}) == 0
    assert store.load_resume("recording", "80888") == 5000.0


def test_import_skips_malformed_keys():
    assert store.import_resume({"bogus": 1.0, "": 2.0, "recording:5": 100.0}) == 1


def test_the_mirror_keeps_what_the_device_says_about_a_channel():
    """Scan type, interlacing and favourite live only on the device.

    The cloud's channel record has none of them - verified against the live
    account, where the union of every key across all 28 channels had nothing
    about resolution, scan or favourites. They were fetched per request and
    held in memory, so they did not survive a restart, and nothing noticed only
    because the Live card re-rendered them on every load. Once the card stopped
    showing the scan, that would have rotted silently.
    """
    from app import store

    store.save_guide([{
        "identifier": "ch1", "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "CBS", "display_name": "KPAX", "logo_url": None, "kind": "ota",
        "scan": "1080i", "interlaced": True, "favourite": True,
        "airings": [],
    }])

    got = store.load_guide()[0]
    assert got["scan"] == "1080i"
    assert got["interlaced"] is True
    assert got["favourite"] is True


def test_a_channel_the_device_never_described_reads_back_empty():
    """The five OTT channels are not in the device lineup at all."""
    from app import store

    store.save_guide([{
        "identifier": "ch2", "call_sign": "FAST", "major": 0, "minor": 0,
        "network": "SCRIPPS", "display_name": "Scripps", "logo_url": None,
        "kind": "ott", "airings": [],
    }])

    got = store.load_guide()[0]
    assert got["scan"] is None
    assert got["interlaced"] is False
    assert got["favourite"] is False


def test_a_later_sync_without_device_facts_does_not_erase_them():
    """Channel details are fetched separately and can be slow or absent.

    `stream_guide_data` starts the lineup fetch without awaiting it and emits
    bare stubs first, so a save can legitimately carry no scan for a channel
    that has one. Treating that as "set it to null" would blank the column on
    every cold start.
    """
    from app import store

    base = {
        "identifier": "ch3", "call_sign": "KSPS", "major": 7, "minor": 1,
        "network": "PBS", "display_name": "KSPS", "logo_url": None, "kind": "ota",
        "airings": [],
    }
    store.save_guide([{**base, "scan": "720p", "interlaced": False}])
    store.save_guide([base])          # a stub pass, carrying no device facts

    assert store.load_guide()[0]["scan"] == "720p"


# ---------------------------------------------------------------------------
# Which recording an airing produced
#
# The sheet is addressed by (channel, start) and a recording carries both, but
# nothing joined them: `search_doc` holds only a display label like "8.1 CBS",
# which two channels can share. Without the join the sheet cannot offer to
# delete the recording it is describing.
# ---------------------------------------------------------------------------

def _recorded(object_id=86353, channel="S34654_008_01", start="2026-09-18T07:00Z"):
    return {
        "object_id": object_id,
        "start": start,
        "channel": {"identifier": channel, "call_sign": "KPAX", "number": "8.1"},
    }


def test_the_recording_an_airing_produced_is_findable_by_the_airing():
    from app import store

    store.index_recording_airings([_recorded()])

    assert store.recording_for_airing("S34654_008_01", "2026-09-18T07:00Z") == 86353


def test_both_spellings_of_the_instant_find_it():
    """The device writes `07:00Z` on a recording where the guide may hold
    `07:00:00Z`, and the sheet asks with whichever the guide gave it."""
    from app import store

    store.index_recording_airings([_recorded(start="2026-09-18T07:00:00Z")])

    assert store.recording_for_airing("S34654_008_01", "2026-09-18T07:00Z") == 86353


def test_another_channel_at_the_same_moment_is_not_it():
    from app import store

    store.index_recording_airings([_recorded()])

    assert store.recording_for_airing("S99999_013_04", "2026-09-18T07:00Z") is None


def test_an_airing_that_produced_nothing_has_no_recording():
    from app import store

    assert store.recording_for_airing("S34654_008_01", "2026-09-18T07:00Z") is None


def test_a_deleted_recording_stops_being_found():
    """Deleting on the device has to clear this, or the sheet keeps offering
    to delete something that is already gone."""
    from app import store

    store.index_recording_airings([_recorded()])
    store.forget_recording(86353)

    assert store.recording_for_airing("S34654_008_01", "2026-09-18T07:00Z") is None
