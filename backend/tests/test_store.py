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


def test_ended_airings_are_pruned_on_write():
    now = datetime.now(timezone.utc)
    store.save_guide(_guide(now))
    titles = [a["title"] for a in store.load_guide()[0]["airings"]]
    assert titles == ["Upcoming"]


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


def test_saving_the_guide_replaces_rather_than_accumulates():
    now = _iso(datetime.now(timezone.utc) + timedelta(hours=1))
    store.save_guide([{"identifier": "ch1", "airings": [{"start": now, "duration": 60}]}])
    store.save_guide([{"identifier": "ch2", "airings": [{"start": now, "duration": 60}]}])
    assert [r["identifier"] for r in store.load_guide()] == ["ch2"]


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
