# SQLite Persistence

**Date:** 2026-09-15
**Status:** Approved, implementing
**Supersedes:** the browser-side guide cache added earlier the same day

---

## Problem

Five unrelated mechanisms persist state, and two of them produced reported bugs.

| State | Where it lives | Consequence |
|---|---|---|
| Tablo credentials | `/data/config.json`, plaintext password, mode 0644 | Password recoverable by anything that can read the volume |
| Recording cache metadata | one `meta.json` per recording (1816 files) | `pinned_ids()` reads every file on disk; no way to query |
| Guide enrichment | process memory, 1 hour TTL | A restart forces a cold rebuild of hundreds of airing records |
| Resume positions | browser `localStorage` | Per-browser; lost when site data is cleared |
| Guide snapshot | browser IndexedDB | Duplicates state the server should own |

None of it is a database. The cost of that shows up as: a security exposure, an
O(files) scan on a hot path, a slow path after every restart, and state that
does not follow the user between browsers.

## Approach

One SQLite file at `/data/tablo.db` in WAL mode, reached through the
`_run_sync` thread-executor pattern already used for `tablo_api` calls.

SQLite is more than a single-user app strictly needs. It is chosen anyway
because the alternative is not "something simpler" — it is the five mechanisms
above, which is what simple has already decayed into.

### What deliberately stays on the filesystem

**Window readiness markers** (`w00042/.done`) and the encoded segments
themselves. Windows complete out of order and concurrently; a marker file is an
atomic, lock-free completion signal, and moving it into a shared row would
require taking a write lock on every window completion. The existing comment in
`window_ready` already documents this reasoning, and it still holds.

The database holds *metadata about* recordings. The bytes stay on disk.

### Why not the alternatives

- **Keep JSON, fix it in place.** Fixes the file mode but nothing else: the
  disk scan, the restart cost, and the browser-local resume all remain.
- **A document store or embedded KV.** Another dependency for a worse query
  story; the relationships here (channel → airings) are relational.
- **Postgres.** Wrong scale entirely for a single-user local app.

---

## Credentials

### Finding

Tablo's cloud login returns only:

```
fields: ['access_token', 'is_verified', 'token_type']
access_token: 40 chars, opaque — not a JWT
```

**No refresh token. No `expires_in`. No expiry claim.** The sole way to obtain a
fresh `access_token` is to re-POST email and password.

`tablo_api` uses the password exactly once, in `discover()`. Every subsequent
device call authenticates with `lighthouse_token` + `account_token` + an
HMAC-MD5 signature.

### Consequence

The requirement is that the app never asks the user to sign in again. Since
there is no refresh path, unattended re-authentication requires the password.
**The password cannot be eliminated — only protected.** This is stated plainly
because the opposite is the kind of claim that quietly fails later.

### Design

Store both, and reach for the password as rarely as possible:

- `access_token`, `lighthouse_token`, `client_id`, device identity — stored
  as-is. These serve every normal request.
- `password` — encrypted at rest, read only when a device call returns 401 and
  `discover()` must run again.

Encryption uses Fernet (`cryptography`), with the key resolved in order:

1. `TABLO_SECRET_KEY` environment variable — for Docker secrets or a key kept
   off the box entirely.
2. `/data/.secret_key`, mode 0600, generated on first run.

**What this defends against:** database copies, backups, a volume snapshot, an
accidental commit, and any future API response that leaks a row.

**What it does not defend against:** an attacker with root on the host, who
gets both the database and the key. Framing this as "encrypted, therefore
safe" would be theater. The honest gain is that the secret is no longer sitting
in cleartext in a world-readable file.

The database file and key file are both created 0600. No route ever returns the
password field; `/api/auth/status` continues to return the email only.

---

## Schema

`PRAGMA user_version` carries the schema version. Migrations are forward-only
and run at startup inside a transaction.

```sql
-- v1

CREATE TABLE setting (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE credential (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),  -- single account
    email               TEXT NOT NULL,
    password_encrypted  BLOB,          -- Fernet; NULL once a refresh path exists
    account_token       TEXT,
    client_id           TEXT,
    updated_at          TEXT NOT NULL
);

CREATE TABLE device (
    sid               TEXT PRIMARY KEY,
    name              TEXT,
    local_url         TEXT,
    lighthouse_token  TEXT,
    active            INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL
);

CREATE TABLE recording (
    object_id        INTEGER PRIMARY KEY,
    path             TEXT NOT NULL,
    source_duration  INTEGER NOT NULL DEFAULT 0,
    pinned           INTEGER NOT NULL DEFAULT 0,
    paused           INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    info             TEXT,            -- JSON library snapshot, for offline-only copies
    created_at       TEXT NOT NULL,
    last_access      TEXT NOT NULL
);
CREATE INDEX recording_pinned    ON recording(pinned) WHERE pinned = 1;
CREATE INDEX recording_access    ON recording(last_access);

CREATE TABLE guide_channel (
    identifier    TEXT PRIMARY KEY,
    call_sign     TEXT,
    major         INTEGER,
    minor         INTEGER,
    network       TEXT,
    display_name  TEXT,
    logo_url      TEXT,
    kind          TEXT,
    position      INTEGER NOT NULL DEFAULT 0,   -- preserves device row order
    updated_at    TEXT NOT NULL
);

CREATE TABLE guide_airing (
    channel_id  TEXT NOT NULL REFERENCES guide_channel(identifier) ON DELETE CASCADE,
    start       TEXT NOT NULL,
    duration    INTEGER NOT NULL DEFAULT 0,
    end_epoch   INTEGER NOT NULL,     -- derived; makes pruning and range scans cheap
    title       TEXT,
    subtitle    TEXT,
    description TEXT,
    genres      TEXT,                 -- JSON array
    kind        TEXT,
    PRIMARY KEY (channel_id, start)
);
CREATE INDEX guide_airing_end ON guide_airing(end_epoch);

CREATE TABLE resume (
    kind        TEXT NOT NULL,        -- 'live' | 'recording'
    ref         TEXT NOT NULL,
    position    REAL NOT NULL,
    duration    REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (kind, ref)
);
```

`recording` mirrors `CacheMeta` field for field, so `read_meta`/`write_meta`
keep their signatures and every caller is unaffected.

`guide_airing.end_epoch` is stored rather than computed because pruning ended
airings runs on every guide read, and `start + duration` cannot use an index.

---

## Guide retention

Measured: 54 channels, 976 airings, 37 hours of schedule, 255 KB — about
267 bytes per airing, or 6.9 KB per hour of guide covered.

At that size there is no reason to expire on age. What actually limits a cached
guide is that the grid renders forward from the current hour, so an airing that
has ended can never be displayed again. Retention is therefore:

- Keep guide rows indefinitely.
- Delete airings where `end_epoch < now` on each write (one indexed DELETE).
- Re-consult the device on `GUIDE_CACHE_TTL` (default 3600s), serving the
  stored guide immediately meanwhile.

A restart no longer causes a cold rebuild, which is the actual user-visible win.

---

## Migration

Each table imports its existing representation on first startup, guarded by
whether the table is empty. **The old files are left in place**, not deleted —
one release of overlap means a rollback does not lose state.

| Table | Imported from |
|---|---|
| `credential`, `device` | `/data/config.json` |
| `recording` | every `*/meta.json` under the cache root |
| `guide_channel`, `guide_airing` | nothing; populated by the next guide fetch |
| `resume` | nothing; the client pushes its localStorage entries once (see below) |

Resume positions cannot be read server-side, so the client POSTs its existing
`tablo:resume` map once on first load after the upgrade, then clears the key.
A one-shot migration endpoint accepts it; entries already in the table win, so
a replay is harmless.

---

## Behavior changes

Two, both worth stating because they reverse earlier decisions in this project:

1. **Resume positions become server-side**, and therefore shared across
   browsers. An earlier decision deliberately put them in localStorage to keep
   the URL stable; that reasoning was about the URL, not about the storage, and
   still holds — the URL keeps carrying identity only.
2. **The browser IndexedDB guide cache is removed.** It was added hours earlier
   to stop a refresh blanking the guide. With the server holding the guide
   across restarts the round trip is ~11 ms warm, so the client copy is
   redundant duplication rather than a second line of defense.

---

## Verification

1. **Migration is lossless.** With a populated `/data`, start fresh and assert
   the credential row, every `meta.json`, and the pinned set all survive; the
   library listing is byte-identical before and after.
2. **Migration is idempotent.** Restart twice; no duplicate rows, no reimport.
3. **The password is never cleartext on disk.** `grep` the database file for
   the known password and find nothing; confirm the DB and key are 0600.
4. **Auth survives a restart without re-login.** Restart the container and
   assert `/api/auth/status` reports authenticated with no login call.
5. **Guide survives a restart.** Restart and assert the first guide request is
   served from the database without contacting the device.
6. **Ended airings are pruned**, and a guide whose airings have all ended
   triggers a device refetch rather than rendering an empty grid.
7. **Concurrency.** WAL plus a busy timeout under a prefetch fill writing
   `last_access` while the library is listed; no `database is locked`.

## Risks

| Risk | Handling |
|---|---|
| Migration corrupts or drops state | Old JSON is retained, not deleted; migration is guarded on an empty table and idempotent |
| `database is locked` under concurrent encoding | WAL mode, `busy_timeout=5000`, short transactions, all writes through the executor |
| New `cryptography` dependency | Widely available wheel; used only for credential encryption |
| Encryption gives false confidence | Limits documented above and in the module docstring, not just in this spec |
| Key file lost | Password becomes unreadable; the app falls back to the login screen rather than failing to start |

## Out of scope

- Multi-user accounts or any authentication for the app itself. The app still
  has no auth and must stay bound to loopback; that is a separate concern and
  unchanged by this work.
- Moving encoded segments or window markers into the database.
- Full-text search over the guide.
