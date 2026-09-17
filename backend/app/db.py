"""SQLite persistence.

Everything the app needs to remember across restarts lives here: credentials,
the recording cache index, the guide, and resume positions. Before this it was
spread across ``config.json``, one ``meta.json`` per recording, process memory,
and two different browser stores - which is how a plaintext password, an
O(files) scan on a hot path, and a cold rebuild after every restart all ended up
coexisting.

What deliberately stays on the filesystem: the encoded segments and the
per-window ``.done`` markers. Windows complete out of order and concurrently, so
a marker file is an atomic, lock-free completion signal; routing that through a
write transaction would serialise every window completion for nothing. The
database holds metadata *about* recordings, never the media.

Connections are thread-local because every call arrives on a thread-pool worker
(see ``state._run_sync``). WAL mode lets readers run while a write is in flight,
and ``busy_timeout`` covers the brief exclusive moments.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("TABLO_DB_PATH", "/data/tablo.db"))

SCHEMA_VERSION = 4

_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS setting (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    email               TEXT NOT NULL,
    password_encrypted  BLOB,
    account_token       TEXT,
    client_id           TEXT,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device (
    sid               TEXT PRIMARY KEY,
    name              TEXT,
    local_url         TEXT,
    lighthouse_token  TEXT,
    active            INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recording (
    object_id        INTEGER PRIMARY KEY,
    path             TEXT NOT NULL,
    source_duration  INTEGER NOT NULL DEFAULT 0,
    pinned           INTEGER NOT NULL DEFAULT 0,
    paused           INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    info             TEXT,
    created_at       TEXT NOT NULL,
    last_access      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recording_pinned ON recording(pinned) WHERE pinned = 1;
CREATE INDEX IF NOT EXISTS recording_access ON recording(last_access);

CREATE TABLE IF NOT EXISTS guide_channel (
    identifier    TEXT PRIMARY KEY,
    call_sign     TEXT,
    major         INTEGER,
    minor         INTEGER,
    network       TEXT,
    display_name  TEXT,
    logo_url      TEXT,
    kind          TEXT,
    position      INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guide_airing (
    channel_id  TEXT NOT NULL REFERENCES guide_channel(identifier) ON DELETE CASCADE,
    start       TEXT NOT NULL,
    duration    INTEGER NOT NULL DEFAULT 0,
    end_epoch   INTEGER NOT NULL,
    title       TEXT,
    subtitle    TEXT,
    description TEXT,
    genres      TEXT,
    kind        TEXT,
    PRIMARY KEY (channel_id, start)
);
CREATE INDEX IF NOT EXISTS guide_airing_end ON guide_airing(end_epoch);

CREATE TABLE IF NOT EXISTS resume (
    kind        TEXT NOT NULL,
    ref         TEXT NOT NULL,
    position    REAL NOT NULL,
    duration    REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (kind, ref)
);
"""


# Version 2 adds the search index and the guide sync log.
#
# `search_fts` is an external-content FTS5 table over `search_doc`: the text
# lives once, in `search_doc`, and FTS keeps only its index. That means FTS has
# no way to notice a write on its own, so the triggers below are mandatory - a
# delete with no trigger leaves the row still matching, which shows up as
# results for things that no longer exist.
_SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS guide_sync (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    airings_seen  INTEGER NOT NULL DEFAULT 0,
    ok            INTEGER NOT NULL DEFAULT 0,
    error         TEXT
);

CREATE TABLE IF NOT EXISTS search_doc (
    kind         TEXT NOT NULL,
    ref          TEXT NOT NULL,
    title        TEXT,
    subtitle     TEXT,
    body         TEXT,
    channel      TEXT,
    start_epoch  INTEGER,
    duration     INTEGER NOT NULL DEFAULT 0,
    target       TEXT NOT NULL,
    PRIMARY KEY (kind, ref)
);
CREATE INDEX IF NOT EXISTS search_doc_start ON search_doc(start_epoch);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, subtitle, body, channel,
    content='search_doc',
    content_rowid='rowid',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS search_doc_ai AFTER INSERT ON search_doc BEGIN
    INSERT INTO search_fts(rowid, title, subtitle, body, channel)
    VALUES (new.rowid, new.title, new.subtitle, new.body, new.channel);
END;

CREATE TRIGGER IF NOT EXISTS search_doc_ad AFTER DELETE ON search_doc BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, subtitle, body, channel)
    VALUES ('delete', old.rowid, old.title, old.subtitle, old.body, old.channel);
END;

CREATE TRIGGER IF NOT EXISTS search_doc_au AFTER UPDATE ON search_doc BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, subtitle, body, channel)
    VALUES ('delete', old.rowid, old.title, old.subtitle, old.body, old.channel);
    INSERT INTO search_fts(rowid, title, subtitle, body, channel)
    VALUES (new.rowid, new.title, new.subtitle, new.body, new.channel);
END;
"""


# Version 3 adds the show-information fields.
#
# The airing columns are all nullable: existing rows stay valid and fill in as
# syncs run, so no backfill step is needed. `series_path` is deliberately NOT a
# foreign key - airings are captured before their series is fetched, and a
# constraint would make the capture order matter.
_SCHEMA_V3 = """
ALTER TABLE guide_airing ADD COLUMN episode_title TEXT;
ALTER TABLE guide_airing ADD COLUMN season_number INTEGER;
ALTER TABLE guide_airing ADD COLUMN episode_number INTEGER;
ALTER TABLE guide_airing ADD COLUMN orig_air_date TEXT;
ALTER TABLE guide_airing ADD COLUMN series_path TEXT;
ALTER TABLE guide_airing ADD COLUMN airing_path TEXT;
ALTER TABLE guide_airing ADD COLUMN schedule_state TEXT;
ALTER TABLE guide_airing ADD COLUMN schedule_qualifier TEXT;
ALTER TABLE guide_airing ADD COLUMN skip_reason TEXT;

CREATE TABLE IF NOT EXISTS guide_series (
    path                TEXT PRIMARY KEY,
    identifier          TEXT,
    title               TEXT,
    description         TEXT,
    genres              TEXT,
    rating              TEXT,
    orig_air_date       TEXT,
    episode_runtime     INTEGER,
    cast                TEXT,
    cover_image_id      INTEGER,
    thumbnail_image_id  INTEGER,
    background_image_id INTEGER,
    schedule_rule       TEXT,
    keep_rule           TEXT,
    keep_count          INTEGER,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guide_airing_series ON guide_airing(series_path);
"""


# Version 4 gives an airing its own artwork.
#
# A URL, not an image id, because this is for the airings that have no series
# record to hang a `cover_image_id` on - the OTT/FAST channels, which exist
# only in the cloud (see docs/tablo-api.md). The cloud hands back absolute CDN
# URLs rather than device image ids, and the browser already loads channel
# logos from that same host, so storing the URL keeps the artwork path free of
# any server-side fetch.
_SCHEMA_V4 = """
ALTER TABLE guide_airing ADD COLUMN image_url TEXT;
"""


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------

def _configure(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row
    # WAL so a library listing is not blocked by a prefetch writing last_access.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # Covers the brief exclusive moments WAL does not: checkpoints and schema
    # changes. Without it a concurrent write raises rather than waiting.
    conn.execute("PRAGMA busy_timeout=5000")


def connection() -> sqlite3.Connection:
    """The calling thread's connection, opening and initialising on first use."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    first = not DB_PATH.exists()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    _configure(conn)
    if first:
        # The file may hold credentials, so never let it be created world-readable.
        try:
            DB_PATH.chmod(0o600)
        except OSError:
            pass
    _local.conn = conn
    _migrate(conn)
    return conn


@contextmanager
def write() -> Iterator[sqlite3.Connection]:
    """A write transaction, committed on success and rolled back on error."""
    conn = connection()
    with conn:
        yield conn


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return connection().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    return connection().execute(sql, params).fetchone()


def execute(sql: str, params: tuple = ()) -> None:
    with write() as conn:
        conn.execute(sql, params)


# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------

def _migrate(conn: sqlite3.Connection) -> None:
    """Bring the schema forward. Forward-only, and safe to run on every open."""
    global _initialized
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version >= SCHEMA_VERSION:
        _initialized = True
        return

    with _init_lock:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version >= SCHEMA_VERSION:
            return
        with conn:
            if version < 1:
                conn.executescript(_SCHEMA_V1)
            if version < 2:
                conn.executescript(_SCHEMA_V2)
            if version < 3:
                conn.executescript(_SCHEMA_V3)
            if version < 4:
                conn.executescript(_SCHEMA_V4)
            conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        print(f"[db] schema at version {SCHEMA_VERSION} ({DB_PATH})", flush=True)
        _initialized = True


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def get_setting(key: str, default: str | None = None) -> str | None:
    row = query_one("SELECT value FROM setting WHERE key = ?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    execute(
        "INSERT INTO setting(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def json_setting(key: str, default=None):
    raw = get_setting(key)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except ValueError:
        return default


def reset_for_tests(path: Path | None = None) -> None:
    """Point the module at a different database and drop cached connections.

    Tests need isolation per case, and the thread-local connection would
    otherwise outlive the tmp_path it was opened against.
    """
    global DB_PATH, _initialized
    close()
    if path is not None:
        DB_PATH = path
    _initialized = False


def close() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None
