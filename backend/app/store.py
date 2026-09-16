"""Typed accessors over the database.

Route and state code talks to these rather than to SQL, so the storage layout
can change without touching callers. Everything here is blocking; async callers
go through ``state._run_sync``.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import crypto, db


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Credentials and devices
# ---------------------------------------------------------------------------

def save_credentials(email: str, password: str | None) -> None:
    """Store the account, encrypting the password if one was supplied.

    ``password=None`` updates the email without touching a password already
    stored, so a token refresh does not have to re-supply it.
    """
    existing = db.query_one("SELECT password_encrypted FROM credential WHERE id = 1")
    blob = crypto.encrypt(password) if password is not None else (
        existing["password_encrypted"] if existing else None
    )
    db.execute(
        "INSERT INTO credential(id, email, password_encrypted, updated_at) "
        "VALUES (1, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "  email = excluded.email, "
        "  password_encrypted = excluded.password_encrypted, "
        "  updated_at = excluded.updated_at",
        (email, blob, _now()),
    )


def load_credentials() -> tuple[str, str] | None:
    """The stored account as ``(email, password)``, or None if unusable.

    An unreadable password - key rotated or lost - reads as no credentials at
    all, which surfaces as the login screen rather than a crash at startup.
    """
    row = db.query_one("SELECT email, password_encrypted FROM credential WHERE id = 1")
    if not row or not row["email"]:
        return None
    password = crypto.decrypt(row["password_encrypted"])
    if password is None:
        return None
    return row["email"], password


def clear_credentials() -> None:
    db.execute("DELETE FROM credential", ())
    db.execute("DELETE FROM device", ())


def save_devices(devices: list, active_sid: str | None) -> None:
    """Persist discovered devices and which one is selected."""
    with db.write() as conn:
        for d in devices:
            conn.execute(
                "INSERT INTO device(sid, name, local_url, lighthouse_token, active, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(sid) DO UPDATE SET "
                "  name = excluded.name, "
                "  local_url = excluded.local_url, "
                "  lighthouse_token = excluded.lighthouse_token, "
                "  active = excluded.active, "
                "  updated_at = excluded.updated_at",
                (
                    d.sid,
                    getattr(d, "name", None),
                    getattr(d, "local_url", None),
                    getattr(d, "lighthouse_token", None),
                    1 if active_sid and d.sid == active_sid else 0,
                    _now(),
                ),
            )
        first = devices[0] if devices else None
        token = getattr(first, "account_token", None) if first else None
        client_id = getattr(first, "client_id", None) if first else None
        if token or client_id:
            conn.execute(
                "UPDATE credential SET account_token = ?, client_id = ? WHERE id = 1",
                (token, client_id),
            )


def load_devices() -> tuple[list[dict], str | None]:
    rows = db.query("SELECT * FROM device ORDER BY name")
    active = next((r["sid"] for r in rows if r["active"]), None)
    cred = db.query_one("SELECT account_token, client_id FROM credential WHERE id = 1")
    out = []
    for r in rows:
        out.append({
            "sid": r["sid"],
            "name": r["name"],
            "local_url": r["local_url"],
            "lighthouse_token": r["lighthouse_token"],
            "account_token": cred["account_token"] if cred else None,
            "client_id": cred["client_id"] if cred else None,
        })
    return out, active


def set_active_device(sid: str) -> None:
    with db.write() as conn:
        conn.execute("UPDATE device SET active = 0", ())
        conn.execute("UPDATE device SET active = 1 WHERE sid = ?", (sid,))


# ---------------------------------------------------------------------------
# Migration from the pre-database layout
# ---------------------------------------------------------------------------

def migrate_config(config_path: Path) -> bool:
    """Import ``config.json`` once, if the credential table is still empty.

    The file is deliberately left in place. One release of overlap means
    rolling back does not lose the account.
    """
    if db.query_one("SELECT 1 FROM credential WHERE id = 1"):
        return False
    if not config_path.exists():
        return False
    try:
        cfg = json.loads(config_path.read_text())
    except (OSError, ValueError):
        return False
    email, password = cfg.get("email"), cfg.get("password")
    if not email or not password:
        return False
    save_credentials(email, password)
    # Retained for one release so a rollback keeps the account - but it still
    # holds the password in cleartext, and it was created world-readable. The
    # database supersedes it; this only narrows the window until it is deleted.
    try:
        config_path.chmod(0o600)
    except OSError:
        pass
    print(f"[db] imported credentials from {config_path} "
          f"(retained at 0600; safe to delete once the database is trusted)", flush=True)
    return True


# ---------------------------------------------------------------------------
# Recording cache index
# ---------------------------------------------------------------------------

def read_recording(object_id: int) -> dict | None:
    row = db.query_one("SELECT * FROM recording WHERE object_id = ?", (object_id,))
    if not row:
        return None
    return {
        "object_id": row["object_id"],
        "path": row["path"],
        "source_duration": row["source_duration"],
        "created_at": row["created_at"],
        "last_access": row["last_access"],
        "error": row["error"],
        "pinned": bool(row["pinned"]),
        "info": json.loads(row["info"]) if row["info"] else None,
        "paused": bool(row["paused"]),
    }


def write_recording(meta: dict) -> None:
    db.execute(
        "INSERT INTO recording(object_id, path, source_duration, pinned, paused, "
        "                      error, info, created_at, last_access) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(object_id) DO UPDATE SET "
        "  path = excluded.path, "
        "  source_duration = excluded.source_duration, "
        "  pinned = excluded.pinned, "
        "  paused = excluded.paused, "
        "  error = excluded.error, "
        "  info = excluded.info, "
        "  last_access = excluded.last_access",
        (
            int(meta["object_id"]),
            meta["path"],
            int(meta.get("source_duration") or 0),
            1 if meta.get("pinned") else 0,
            1 if meta.get("paused") else 0,
            meta.get("error"),
            json.dumps(meta["info"]) if meta.get("info") else None,
            meta.get("created_at") or _now(),
            meta.get("last_access") or _now(),
        ),
    )


def delete_recording(object_id: int) -> None:
    db.execute("DELETE FROM recording WHERE object_id = ?", (object_id,))


def pinned_recording_ids() -> list[int]:
    """Pinned recordings, straight off a partial index.

    The previous implementation opened and parsed every ``meta.json`` under the
    cache root on each call, which is on the path of every library listing.
    """
    return [r["object_id"] for r in db.query(
        "SELECT object_id FROM recording WHERE pinned = 1 ORDER BY object_id"
    )]


def all_recording_ids() -> list[int]:
    return [r["object_id"] for r in db.query("SELECT object_id FROM recording")]


def eviction_candidates() -> list[int]:
    """Unpinned recordings, least recently accessed first."""
    return [r["object_id"] for r in db.query(
        "SELECT object_id FROM recording WHERE pinned = 0 ORDER BY last_access"
    )]


def migrate_recordings(cache_root: Path) -> int:
    """Import every ``meta.json`` under the cache root, once.

    Guarded on an empty table and on each row's absence, so a restart mid-import
    resumes rather than duplicating. The JSON files are left where they are.
    """
    if not cache_root.exists():
        return 0
    if db.query_one("SELECT 1 FROM recording LIMIT 1"):
        return 0

    imported = 0
    for d in sorted(cache_root.iterdir()):
        if not d.is_dir():
            continue
        meta_file = d / "meta.json"
        if not meta_file.exists():
            continue
        try:
            meta = json.loads(meta_file.read_text())
        except (OSError, ValueError):
            continue
        if not meta.get("object_id") or not meta.get("path"):
            continue
        write_recording(meta)
        imported += 1
    if imported:
        print(f"[db] imported {imported} recording(s) from meta.json (files retained)",
              flush=True)
    return imported


# ---------------------------------------------------------------------------
# Guide
# ---------------------------------------------------------------------------

# How long an airing is kept after it ends.
#
# A constant with an env override rather than a stored setting - it becomes a
# real setting when there is a screen to put it on. Generous on purpose: at
# ~267 bytes an airing this is roughly 7 MB, so keeping too much costs nothing
# and keeping too little cannot be undone, because the device's guide is
# forward-looking and history is only ever captured as it happens.
GUIDE_RETENTION_DAYS = int(os.environ.get("TABLO_GUIDE_RETENTION_DAYS", "31"))


def _end_epoch(start: str | None, duration) -> int:
    if not start:
        return 0
    try:
        ts = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
    except ValueError:
        return 0
    return int(ts.timestamp() + (int(duration or 0)))


def _start_epoch(start: str | None) -> int:
    """The airing's start as a Unix epoch. `_end_epoch` with no duration."""
    return _end_epoch(start, 0)


# ---------------------------------------------------------------------------
# Search index
# ---------------------------------------------------------------------------

def channel_label(ch: dict) -> str:
    """How a station is written on screen, e.g. "8.1 CBS"."""
    major, minor = ch.get("major"), ch.get("minor")
    number = f"{major}.{minor}" if major else ""
    name = ch.get("network") or ch.get("call_sign") or ""
    return " ".join(p for p in (number, name) if p)


def index_channel(conn, ch: dict) -> None:
    """Put a channel in the search index.

    Takes an open connection so it joins the caller's transaction: the index
    and the row it describes must land together or not at all.

    An explicit `ON CONFLICT ... DO UPDATE`, not `INSERT OR REPLACE`: REPLACE
    conflict resolution only fires SQLite's delete triggers when
    `PRAGMA recursive_triggers` is on, which it is not here (and would have to
    be set on every thread-local connection to help). With it off, `search_fts`
    never sees the old row deleted - the new terms are added beside the old
    ones instead of replacing them, so a search index grows stale and unbounded
    while `search_doc` itself looks correct. The `ON CONFLICT DO UPDATE` form
    fires an `UPDATE`, which `search_doc_au` (added in Task 1) already handles.
    """
    ident = str(ch.get("identifier"))
    conn.execute(
        "INSERT INTO search_doc(kind, ref, title, subtitle, body, "
        "    channel, start_epoch, duration, target) "
        "VALUES ('channel', ?, ?, ?, ?, ?, NULL, 0, ?) "
        "ON CONFLICT(kind, ref) DO UPDATE SET "
        "  title=excluded.title, subtitle=excluded.subtitle, body=excluded.body, "
        "  channel=excluded.channel, start_epoch=excluded.start_epoch, "
        "  duration=excluded.duration, target=excluded.target",
        (
            ident,
            ch.get("display_name") or ch.get("call_sign"),
            channel_label(ch),
            " ".join(str(p) for p in (ch.get("network"), ch.get("call_sign")) if p),
            channel_label(ch),
            json.dumps({"tab": "live", "watch": ident}),
        ),
    )


def index_airing(conn, channel_id: str, label: str, air: dict) -> None:
    """Put one airing in the search index, keyed the same way as guide_airing.

    Uses `ON CONFLICT DO UPDATE`, not `INSERT OR REPLACE` - see the note on
    `index_channel` for why the latter silently corrupts `search_fts` here.

    The target carries `channel_id` as well as `at` because opening an airing
    needs both halves of the `guide_airing` key - the show sheet is fetched by
    (channel, start). `ref` happens to concatenate exactly those two, but
    splitting it client-side would make this function's key format part of the
    API, so the target states them outright.
    """
    genres = air.get("genres") or []
    body = " ".join(
        str(p) for p in (air.get("description"), *genres, label) if p
    )
    conn.execute(
        "INSERT INTO search_doc(kind, ref, title, subtitle, body, "
        "    channel, start_epoch, duration, target) "
        "VALUES ('airing', ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(kind, ref) DO UPDATE SET "
        "  title=excluded.title, subtitle=excluded.subtitle, body=excluded.body, "
        "  channel=excluded.channel, start_epoch=excluded.start_epoch, "
        "  duration=excluded.duration, target=excluded.target",
        (
            f"{channel_id}|{air.get('start')}",
            air.get("title"),
            air.get("subtitle") or "",
            body,
            label,
            _start_epoch(air.get("start")),
            int(air.get("duration") or 0),
            json.dumps({
                "tab": "grid",
                "at": air.get("start"),
                "channel_id": channel_id,
            }),
        ),
    )


def index_recordings(items: list[dict], *, prune: bool = False) -> None:
    """Index the library from a device listing.

    Called on every listing rather than on a write, because the device holds
    the library and we only mirror the handful we have transcoded. Cheap: an
    upsert per recording, and there are rarely more than a few dozen.

    Uses `ON CONFLICT DO UPDATE`, not `INSERT OR REPLACE` - see the note on
    `index_channel` for why the latter silently corrupts `search_fts` here.
    This is the writer that reindexes most often (every listing), so it is
    the one where that bug would bite hardest.

    `prune=True` says the caller is holding the whole library, so anything
    indexed and absent from it has been deleted on the device and is dropped
    from the index. Only the caller can know that: a truncated listing looks
    identical to a shrunken library from in here, and pruning on one would
    delete most of the index. `/recordings` compares what it fetched against
    the device's own count - see there.

    An empty complete listing is a real state (everything deleted), so the
    early return is only safe when there is nothing to prune against.
    """
    if not items and not prune:
        return
    with db.write() as conn:
        for rec in items:
            ch = rec.get("channel") or {}
            label = " ".join(
                str(p) for p in (ch.get("number"), ch.get("network") or ch.get("call_sign")) if p
            )
            conn.execute(
                "INSERT INTO search_doc(kind, ref, title, subtitle, body, "
                "    channel, start_epoch, duration, target) "
                "VALUES ('recording', ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(kind, ref) DO UPDATE SET "
                "  title=excluded.title, subtitle=excluded.subtitle, body=excluded.body, "
                "  channel=excluded.channel, start_epoch=excluded.start_epoch, "
                "  duration=excluded.duration, target=excluded.target",
                (
                    str(rec.get("object_id")),
                    rec.get("title"),
                    rec.get("subtitle") or "",
                    " ".join(str(p) for p in (rec.get("description"), label) if p),
                    label,
                    _start_epoch(rec.get("start")),
                    int(rec.get("duration") or 0),
                    json.dumps({"tab": "library", "watch": int(rec.get("object_id"))}),
                ),
            )

        if prune:
            # A deleted recording left in the index is worse than a missing
            # one: it is offered, clicked, and fails.
            refs = [str(r.get("object_id")) for r in items]
            if refs:
                marks = ",".join("?" * len(refs))
                conn.execute(
                    "DELETE FROM search_doc WHERE kind = 'recording' "
                    f"AND ref NOT IN ({marks})",
                    refs,
                )
            else:
                conn.execute("DELETE FROM search_doc WHERE kind = 'recording'")


def save_guide(
    rows: list[dict],
    now: float | None = None,
    *,
    record_sync: bool = True,
) -> None:
    """Merge the guide into the mirror, keeping everything already stored.

    Append-only by design. This used to issue `DELETE FROM guide_channel`,
    and `guide_airing` references it `ON DELETE CASCADE`, so every save
    destroyed every airing and rebuilt only what the device currently lists.
    Combined with a skip for airings that had already ended, nothing that had
    aired survived anywhere.

    That is unrecoverable rather than merely lossy: the device's
    `/guide/airings` is forward-looking, so once a programme airs it falls off
    and no later request can bring it back. The mirror is therefore a record of
    what aired, not a snapshot of what the device holds, and the device
    dropping an airing is never a reason to delete our copy. Only
    `prune_guide` removes anything, and only by age.

    Every channel touched in this call is stamped with the same `updated_at`
    (computed once, not per row - per-row timestamps could differ and would
    break the comparison below), and that stamp is recorded as
    `guide_synced_at`. `load_guide` uses it to show only the channels seen in
    the latest sync, without deleting the ones the device stopped listing -
    see `load_guide` for why.

    `record_sync=False` writes the rows without claiming a sync happened, for
    the startup backfill: it re-indexes what is already on disk, and stamping
    that as a fresh sync would report month-old listings as just-fetched for
    as long as the next sync took to arrive. It reuses the stamp already
    stored so the channels it writes still match `guide_synced_at`, which is
    what `load_guide` filters on.
    """
    del now  # retained for signature compatibility; pruning is prune_guide's job
    stamp = _now()
    if not record_sync:
        stamp = db.get_setting("guide_synced_at") or stamp
    with db.write() as conn:
        for position, ch in enumerate(rows):
            conn.execute(
                "INSERT INTO guide_channel(identifier, call_sign, major, minor, "
                "                          network, display_name, logo_url, kind, "
                "                          position, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(identifier) DO UPDATE SET "
                "  call_sign=excluded.call_sign, major=excluded.major, "
                "  minor=excluded.minor, network=excluded.network, "
                "  display_name=excluded.display_name, logo_url=excluded.logo_url, "
                "  kind=excluded.kind, position=excluded.position, "
                "  updated_at=excluded.updated_at",
                (
                    str(ch.get("identifier")), ch.get("call_sign"), ch.get("major"),
                    ch.get("minor"), ch.get("network"), ch.get("display_name"),
                    ch.get("logo_url"), ch.get("kind"), position, stamp,
                ),
            )
            index_channel(conn, ch)
            label = channel_label(ch)
            for air in ch.get("airings") or []:
                end = _end_epoch(air.get("start"), air.get("duration"))
                conn.execute(
                    "INSERT OR REPLACE INTO guide_airing(channel_id, start, duration, "
                    "    end_epoch, title, subtitle, description, genres, kind, "
                    "    episode_title, season_number, episode_number, orig_air_date, "
                    "    series_path, airing_path, schedule_state, schedule_qualifier, "
                    "    skip_reason, image_url) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(ch.get("identifier")), air.get("start"),
                        int(air.get("duration") or 0), end, air.get("title"),
                        air.get("subtitle"), air.get("description"),
                        json.dumps(air.get("genres") or []), air.get("kind"),
                        air.get("episode_title"), air.get("season_number"),
                        air.get("episode_number"), air.get("orig_air_date"),
                        air.get("series_path"), air.get("airing_path"),
                        air.get("schedule_state"), air.get("schedule_qualifier"),
                        air.get("skip_reason"), air.get("image_url"),
                    ),
                )
                index_airing(conn, str(ch.get("identifier")), label, air)
    if record_sync:
        db.set_setting("guide_updated_at", stamp)
        db.set_setting("guide_synced_at", stamp)


def prune_guide(now: float | None = None) -> int:
    """Drop airings that ended more than GUIDE_RETENTION_DAYS ago.

    The only thing that removes guide rows. Age is the sole criterion - an
    airing missing from the device is kept, because that is the normal state of
    everything in the past.
    """
    cutoff = int(now if now is not None else datetime.now(timezone.utc).timestamp())
    cutoff -= GUIDE_RETENTION_DAYS * 86_400
    with db.write() as conn:
        conn.execute(
            "DELETE FROM search_doc WHERE kind = 'airing' AND ref IN ("
            "  SELECT channel_id || '|' || start FROM guide_airing WHERE end_epoch < ?)",
            (cutoff,),
        )
        cur = conn.execute("DELETE FROM guide_airing WHERE end_epoch < ?", (cutoff,))
        return cur.rowcount


def _airing_row(a) -> dict:
    """A stored airing as the guide and the player both expect it."""
    return {
        "start": a["start"],
        "duration": a["duration"],
        "title": a["title"],
        "subtitle": a["subtitle"],
        "description": a["description"],
        "genres": json.loads(a["genres"]) if a["genres"] else [],
        "kind": a["kind"],
        # Read back so a re-save (backfill_index re-writes what load_guide
        # returned) does not blank the columns it just read.
        "episode_title": a["episode_title"],
        "season_number": a["season_number"],
        "episode_number": a["episode_number"],
        "orig_air_date": a["orig_air_date"],
        "series_path": a["series_path"],
        "airing_path": a["airing_path"],
        "schedule_state": a["schedule_state"],
        "schedule_qualifier": a["schedule_qualifier"],
        "skip_reason": a["skip_reason"],
        "image_url": a["image_url"],
    }


def channel_airings(
    identifier: str, now: float | None = None, limit: int = 32
) -> list[dict]:
    """What is on this channel now and next, oldest first.

    Answers the live player's question: it draws its scrubber over the airing
    being watched, and re-scales to the following one when that ends. Airings
    that have already finished are left out - the DVR window holds none of
    them, so there is nothing the player could show for one.

    Capped, because the mirror is append-only and holds every future airing the
    device has ever listed - the better part of a fortnight per channel, each
    carrying a full description. The player fetches this while opening a
    stream and reads two of them, so shipping the whole schedule would put a
    sizeable payload in front of a tuner handshake.
    """
    cutoff = int(now if now is not None else datetime.now(timezone.utc).timestamp())
    return [
        _airing_row(a)
        for a in db.query(
            "SELECT * FROM guide_airing WHERE channel_id = ? AND end_epoch >= ? "
            "ORDER BY start LIMIT ?",
            (str(identifier), cutoff, limit),
        )
    ]


def load_guide(now: float | None = None) -> list[dict]:
    """The channels seen in the latest sync, excluding airings that have ended.

    `guide_channel` rows are upserted and never deleted - a channel carries
    its airing history through the `ON DELETE CASCADE` on `guide_airing`, so
    removing a row the device stopped listing would destroy exactly the
    history this store exists to protect (see `save_guide`). To still make a
    dropped channel disappear from the grid, every channel written in a sync
    is stamped with that sync's `updated_at`, recorded as `guide_synced_at`;
    only channels carrying the latest stamp are returned here. A stale
    channel's row and airings stay on disk - available to the search index -
    they just stop appearing in this list. A channel that IS in the latest
    sync but has no airings inside the read window still comes back with an
    empty `airings` list, exactly as before.
    """
    cutoff = int(now if now is not None else datetime.now(timezone.utc).timestamp())
    synced_at = db.get_setting("guide_synced_at")
    if not synced_at:
        return []
    channels = db.query(
        "SELECT * FROM guide_channel WHERE updated_at = ? ORDER BY position",
        (synced_at,),
    )
    if not channels:
        return []

    by_channel: dict[str, list[dict]] = {}
    for a in db.query(
        "SELECT * FROM guide_airing WHERE end_epoch >= ? ORDER BY start", (cutoff,)
    ):
        by_channel.setdefault(a["channel_id"], []).append(_airing_row(a))

    return [{
        "identifier": c["identifier"],
        "call_sign": c["call_sign"],
        "major": c["major"],
        "minor": c["minor"],
        "network": c["network"],
        "display_name": c["display_name"],
        "logo_url": c["logo_url"],
        "kind": c["kind"],
        "airings": by_channel.get(c["identifier"], []),
    } for c in channels]


# ---------------------------------------------------------------------------
# Series
# ---------------------------------------------------------------------------
#
# `cast` is quoted everywhere below: CAST is a SQL keyword, and while SQLite
# happens to accept it bare in these positions, a bare keyword as a column name
# is the kind of thing that works until one statement is rephrased.

def save_series(rows: list[dict]) -> None:
    """Upsert series records. Never deletes - same reasoning as guide_channel."""
    stamp = _now()
    with db.write() as conn:
        for s in rows:
            conn.execute(
                "INSERT INTO guide_series(path, identifier, title, description, "
                "    genres, rating, orig_air_date, episode_runtime, \"cast\", "
                "    cover_image_id, thumbnail_image_id, background_image_id, "
                "    schedule_rule, keep_rule, keep_count, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET "
                "  identifier=excluded.identifier, title=excluded.title, "
                "  description=excluded.description, genres=excluded.genres, "
                "  rating=excluded.rating, orig_air_date=excluded.orig_air_date, "
                "  episode_runtime=excluded.episode_runtime, "
                "  \"cast\"=excluded.\"cast\", "
                "  cover_image_id=excluded.cover_image_id, "
                "  thumbnail_image_id=excluded.thumbnail_image_id, "
                "  background_image_id=excluded.background_image_id, "
                "  schedule_rule=excluded.schedule_rule, "
                "  keep_rule=excluded.keep_rule, keep_count=excluded.keep_count, "
                "  updated_at=excluded.updated_at",
                (
                    s.get("path"), s.get("identifier"), s.get("title"),
                    s.get("description"), json.dumps(s.get("genres") or []),
                    s.get("rating"), s.get("orig_air_date"),
                    s.get("episode_runtime"), json.dumps(s.get("cast") or []),
                    s.get("cover_image_id"), s.get("thumbnail_image_id"),
                    s.get("background_image_id"), s.get("schedule_rule"),
                    s.get("keep_rule"), s.get("keep_count"), stamp,
                ),
            )


def load_series(path: str) -> dict | None:
    row = db.query_one("SELECT * FROM guide_series WHERE path = ?", (path,))
    if row is None:
        return None
    out = dict(row)
    out["genres"] = json.loads(out["genres"] or "[]")
    out["cast"] = json.loads(out["cast"] or "[]")
    return out


def series_needing_refresh(paths: list[str], max_age_days: int = 30) -> list[str]:
    """Which of `paths` we have never fetched, or fetched too long ago.

    Ratings and artwork effectively never change, so a long window keeps every
    sync after the first down to only what is new.
    """
    if not paths:
        return []
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=max_age_days)
    ).isoformat(timespec="seconds")
    known = {
        r["path"] for r in db.query(
            "SELECT path FROM guide_series WHERE updated_at >= ?", (cutoff,)
        )
    }
    return [p for p in paths if p not in known]


def airing_series_paths() -> list[str]:
    """Distinct series paths seen in the mirror, for the sync to fill in."""
    return [
        r["series_path"] for r in db.query(
            "SELECT DISTINCT series_path FROM guide_airing "
            "WHERE series_path IS NOT NULL"
        )
    ]


def imminent_cover_ids(hours: int = 12, now: float | None = None) -> list[int]:
    """Cover image ids for programmes on air within the next `hours`.

    The prefetch window - a few dozen images, against the ~3,190 the full
    guide covers. Everything outside it is fetched when a sheet asks.

    "On air within the window" means still running and already started by the
    end of it, so a programme half-way through right now counts. There is no
    start column; `end_epoch - duration` is the start, which is exactly how
    `_end_epoch` built it.
    """
    at = int(now if now is not None else datetime.now(timezone.utc).timestamp())
    rows = db.query(
        "SELECT DISTINCT s.cover_image_id AS id "
        "FROM guide_airing a JOIN guide_series s ON s.path = a.series_path "
        "WHERE s.cover_image_id IS NOT NULL "
        "  AND a.end_epoch >= ? AND a.end_epoch - a.duration <= ? "
        "ORDER BY s.cover_image_id",
        (at, at + hours * 3600),
    )
    return [r["id"] for r in rows]


# The device's `schedule.state` is an open enumeration - `/server/capabilities`
# advertises features whose states we have never seen. Naming the values that
# mean "not recording" and treating everything else as recording fails safe: an
# unseen state shows a REC badge that can be turned off, rather than hiding a
# recording that is actually scheduled.
_NOT_RECORDING = {None, "none", "skipped"}


def _is_scheduled(state: str | None) -> bool:
    return state not in _NOT_RECORDING


def airing_detail(channel: str, start: str, now: float | None = None) -> dict | None:
    """Everything the show sheet renders, from the mirror alone.

    `airing_now` is computed here rather than in the browser: the client's
    clock can differ from the one the guide was built against, and a sheet
    offering to tune to a programme that finished is worse than one that does
    not offer at all.
    """
    air = db.query_one(
        "SELECT * FROM guide_airing WHERE channel_id = ? AND start = ?",
        (channel, start),
    )
    if air is None:
        return None
    ch = db.query_one(
        "SELECT * FROM guide_channel WHERE identifier = ?", (channel,)
    )
    series = load_series(air["series_path"]) if air["series_path"] else None

    at = now if now is not None else datetime.now(timezone.utc).timestamp()
    start_epoch = _start_epoch(air["start"])
    end_epoch = air["end_epoch"]

    # The airing's own artwork wins: it is about this episode, where a series
    # cover is about the whole run. It is also the only artwork an OTT airing
    # has - those carry no series record at all, so without this every FAST
    # sheet renders hero-less.
    cover = (series or {}).get("cover_image_id")
    image_url = air["image_url"] or (f"/api/channels/image/{cover}" if cover else None)
    return {
        "title": air["title"],
        "episode_title": air["episode_title"],
        "season_number": air["season_number"],
        "episode_number": air["episode_number"],
        "description": air["description"] or (series or {}).get("description"),
        "start": air["start"],
        "duration": air["duration"],
        "orig_air_date": air["orig_air_date"],
        "genres": json.loads(air["genres"] or "[]") or (series or {}).get("genres") or [],
        "rating": (series or {}).get("rating"),
        "image_url": image_url,
        "airing_now": start_epoch <= at < end_epoch,
        # Recording state. `schedulable` is decided here rather than left to the
        # client to infer from a path, because the path never leaves the backend
        # - see routes/schedule.py.
        "schedulable": air["airing_path"] is not None,
        "scheduled": _is_scheduled(air["schedule_state"]),
        # Not the inverse of `airing_now`: that is also false for everything
        # upcoming, which is the main thing anyone records.
        "past": end_epoch <= at,
        "schedule_state": air["schedule_state"],
        "skip_reason": air["skip_reason"],
        "series": (
            {"path": air["series_path"],
             "schedule_rule": (series or {}).get("schedule_rule")}
            if air["series_path"] else None
        ),
        "channel": {
            "identifier": channel,
            "call_sign": ch["call_sign"] if ch else None,
            "major": ch["major"] if ch else None,
            "minor": ch["minor"] if ch else None,
            "network": ch["network"] if ch else None,
            "logo_url": ch["logo_url"] if ch else None,
            "kind": ch["kind"] if ch else None,
        },
    }


def airing_handles(channel: str, start: str) -> dict | None:
    """The device paths for one airing, or None if the mirror has no such row.

    These stay server-side. The browser addresses an airing by (channel, start)
    - `guide_airing`'s primary key, which the sheet already holds - and the
    PATCH target is looked up here.
    """
    row = db.query_one(
        "SELECT airing_path, series_path FROM guide_airing "
        "WHERE channel_id = ? AND start = ?",
        (str(channel), start),
    )
    if row is None:
        return None
    return {"airing_path": row["airing_path"], "series_path": row["series_path"]}


def update_airing_schedule(channel: str, start: str, air: dict) -> None:
    """Write one airing's schedule fields back from a device response.

    A targeted UPDATE rather than the `save_guide` upsert: the response being
    written through is a single airing record, and the row also holds guide
    text and artwork that a whole-row replace would blank.

    The two paths are COALESCEd because a caller may pass only schedule fields,
    and losing `airing_path` would make the row unschedulable from then on.
    """
    db.execute(
        "UPDATE guide_airing SET "
        "  schedule_state = ?, schedule_qualifier = ?, skip_reason = ?, "
        "  airing_path = COALESCE(?, airing_path), "
        "  series_path = COALESCE(?, series_path) "
        "WHERE channel_id = ? AND start = ?",
        (
            air.get("schedule_state"), air.get("schedule_qualifier"),
            air.get("skip_reason"), air.get("airing_path"),
            air.get("series_path"), str(channel), start,
        ),
    )


def series_future_airings(
    series_path: str, now: float | None = None, limit: int = 200
) -> list[dict]:
    """Airings of this series still to come, as (channel, start, airing_path).

    What a series-rule write has to re-read: one rule change flips
    `schedule.state` on every future episode, and the background sync is hours
    away. Past airings are excluded - their state can no longer change - and so
    are rows with no `airing_path`, which the device has nothing to say about.
    """
    cutoff = int(now if now is not None else datetime.now(timezone.utc).timestamp())
    return [
        {"channel": r["channel_id"], "start": r["start"],
         "airing_path": r["airing_path"]}
        for r in db.query(
            "SELECT channel_id, start, airing_path FROM guide_airing "
            "WHERE series_path = ? AND airing_path IS NOT NULL AND end_epoch >= ? "
            "ORDER BY start LIMIT ?",
            (series_path, cutoff, limit),
        )
    ]


def guide_age_seconds(now: datetime | None = None) -> float | None:
    """Seconds since the guide was last written, or None if never."""
    raw = db.get_setting("guide_updated_at")
    if not raw:
        return None
    try:
        written = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return ((now or datetime.now(timezone.utc)) - written).total_seconds()


# ---------------------------------------------------------------------------
# Resume positions
# ---------------------------------------------------------------------------

# Matches the client's previous localStorage rules, kept so behavior does not
# change as the store moves server-side.
MIN_RESUME = 30.0
END_MARGIN = 60.0


def save_resume(kind: str, ref: str, position: float, duration: float) -> None:
    """Record where playback reached, or forget it near either end.

    Below the opening threshold there is nothing worth resuming, and near the
    end counts as watched - resuming there drops you on the credits.
    """
    if position < MIN_RESUME or (duration > 0 and position > duration - END_MARGIN):
        db.execute("DELETE FROM resume WHERE kind = ? AND ref = ?", (kind, ref))
        return
    db.execute(
        "INSERT INTO resume(kind, ref, position, duration, updated_at) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(kind, ref) DO UPDATE SET "
        "  position = excluded.position, "
        "  duration = excluded.duration, "
        "  updated_at = excluded.updated_at",
        (kind, ref, float(position), float(duration), _now()),
    )


def load_resume(kind: str, ref: str) -> float:
    row = db.query_one(
        "SELECT position FROM resume WHERE kind = ? AND ref = ?", (kind, ref)
    )
    return float(row["position"]) if row else 0.0


def all_resume() -> dict[str, float]:
    return {
        f"{r['kind']}:{r['ref']}": float(r["position"])
        for r in db.query("SELECT kind, ref, position FROM resume")
    }


def import_resume(entries: dict[str, float]) -> int:
    """Take the client's old localStorage map, once.

    Anything already stored wins, so a replay of the same payload is harmless.
    """
    imported = 0
    for key, position in entries.items():
        kind, _, ref = key.partition(":")
        if kind not in ("live", "recording") or not ref:
            continue
        if db.query_one("SELECT 1 FROM resume WHERE kind = ? AND ref = ?", (kind, ref)):
            continue
        db.execute(
            "INSERT INTO resume(kind, ref, position, duration, updated_at) "
            "VALUES (?, ?, ?, 0, ?)",
            (kind, ref, float(position), _now()),
        )
        imported += 1
    return imported
