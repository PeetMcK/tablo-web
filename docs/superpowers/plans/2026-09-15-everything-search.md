# Everything Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One search box that finds live channels, guide airings and recordings, served from SQLite and rendered through a topbar dropdown, a Cmd-K palette and a results page.

**Architecture:** A single ranked FTS5 index (`search_doc` + `search_fts`) fed by one writer per source. The guide mirror becomes append-only so history survives, pruned only by age. One `/api/search` endpoint; one `useSearch` hook; three thin presentational surfaces.

**Tech Stack:** Python 3.14, FastAPI, SQLite (FTS5, WAL), pytest. React 19, TypeScript, react-query, Tailwind, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-15-everything-search-design.md`

## Global Constraints

- **The guide mirror is append-only.** Rows are removed by age alone. The device no longer listing an airing is never a reason to delete it. This is the single rule most likely to be undone by a later well-meaning change.
- **Retention is 31 days after an airing ends.** Module constant `GUIDE_RETENTION_DAYS = 31`, env override `TABLO_GUIDE_RETENTION_DAYS`. Not a stored setting.
- **Sync interval:** `TABLO_GUIDE_SYNC_HOURS`, default `6`. Sync also runs once at startup, always.
- **`bm25()` returns negative numbers; more negative is a better match.** Order ascending. Weights: title `10.0`, subtitle `5.0`, body `1.0`, channel `2.0`.
- **`search_fts` is an external-content FTS5 table and goes stale without triggers.** Verified: deleting from `search_doc` with no trigger left the row matching. Triggers are mandatory, not tidiness.
- Backend tests run with `backend/.venv/bin/python -m pytest`. Frontend with `npx vitest run` from `frontend/`.
- `main` already fails ruff with pre-existing errors. Lint only files you touch.
- Never log or echo the Tablo password. It lives in `config.json` and the `credential` table.

---

## File Structure

**Backend**

| File | Responsibility |
|---|---|
| `app/db.py` (modify) | Schema v2 — new tables, FTS, triggers, migration step |
| `app/store.py` (modify) | `save_guide` becomes append-only; retention prune; index writers for channel/airing |
| `app/search.py` (create) | Query the index, rank, cross-reference recordings |
| `app/guide_sync.py` (create) | Background full-guide sync + coverage log |
| `app/routes/search.py` (create) | `GET /api/search` |
| `app/routes/recordings.py` (modify) | Index recordings as they are listed |
| `app/main.py` (modify) | Register router, start sync task |
| `tests/test_search.py` (create) | Index, ranking, retention, cross-reference |
| `tests/test_guide_sync.py` (create) | Append-only behaviour, coverage |

**Frontend**

| File | Responsibility |
|---|---|
| `src/api/tablo.ts` (modify) | `api.search()` + result types |
| `src/hooks/useSearch.ts` (create) | Debounced query, the only API caller |
| `src/components/SearchResultRow.tsx` (create) | One match, rendered identically everywhere |
| `src/components/SearchDropdown.tsx` (create) | Topbar results panel |
| `src/components/CommandPalette.tsx` (create) | Cmd-K modal |
| `src/components/SearchResultsView.tsx` (create) | Full results page |
| `src/components/ChannelGrid.tsx` (modify) | Host dropdown + palette; route the `search` tab |
| `src/lib/route.ts` (modify) | `search` tab and `q` |
| `src/__tests__/search.test.tsx` (create) | Hook, palette keys, shared row |

---

## Task 1: Schema v2 — index tables, FTS, triggers

**Files:**
- Modify: `backend/app/db.py:34` (`SCHEMA_VERSION`), `:49` (schema constants), `:186` (`_migrate`)
- Test: `backend/tests/test_search.py`

**Interfaces:**
- Consumes: `db.write()`, `db.query()`, `db.reset_for_tests()` (existing).
- Produces: tables `guide_sync`, `search_doc`, `search_fts`; `db.SCHEMA_VERSION == 2`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_search.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -v`
Expected: FAIL — `user_version` is 1, tables missing.

- [ ] **Step 3: Add the schema**

In `app/db.py`, change `SCHEMA_VERSION = 1` to `SCHEMA_VERSION = 2`, then add after `_SCHEMA_V1`:

```python
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
```

In `_migrate`, after the `if version < 1:` branch:

```python
            if version < 2:
                conn.executescript(_SCHEMA_V2)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole suite — the migration must not disturb anything**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: all previous tests still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/app/db.py backend/tests/test_search.py
git commit -m "feat: add the search index schema at version 2"
```

---

## Task 2: Make the guide mirror append-only

This is the regression the spec exists to fix: `save_guide` deletes from `guide_channel`, which cascades to `guide_airing` and wipes every airing on every sync.

**Files:**
- Modify: `backend/app/store.py:275-325` (`save_guide`)
- Test: `backend/tests/test_guide_sync.py`

**Interfaces:**
- Consumes: `db.write()`, `store._end_epoch(start, duration)` (existing).
- Produces: `store.GUIDE_RETENTION_DAYS: int`, `store.prune_guide(now: float | None = None) -> int` returning rows deleted. `save_guide(rows, now=None)` keeps its signature.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_guide_sync.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_guide_sync.py -v`
Expected: FAIL — `test_a_later_sync_does_not_wipe_earlier_airings` (Survivor gone), `test_an_ended_airing_is_written_rather_than_skipped`, and `prune_guide` missing.

- [ ] **Step 3: Implement**

In `app/store.py`, add near the top (after the existing imports):

```python
# How long an airing is kept after it ends.
#
# A constant with an env override rather than a stored setting - it becomes a
# real setting when there is a screen to put it on. Generous on purpose: at
# ~267 bytes an airing this is roughly 7 MB, so keeping too much costs nothing
# and keeping too little cannot be undone, because the device's guide is
# forward-looking and history is only ever captured as it happens.
GUIDE_RETENTION_DAYS = int(os.environ.get("TABLO_GUIDE_RETENTION_DAYS", "31"))
```

Add `import os` to the imports if absent.

Replace the body of `save_guide` (its docstring and the channel/airing loop) with:

```python
def save_guide(rows: list[dict], now: float | None = None) -> None:
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
    """
    del now  # retained for signature compatibility; pruning is prune_guide's job
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
                    ch.get("logo_url"), ch.get("kind"), position, _now(),
                ),
            )
            for air in ch.get("airings") or []:
                end = _end_epoch(air.get("start"), air.get("duration"))
                conn.execute(
                    "INSERT OR REPLACE INTO guide_airing(channel_id, start, duration, "
                    "    end_epoch, title, subtitle, description, genres, kind) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(ch.get("identifier")), air.get("start"),
                        int(air.get("duration") or 0), end, air.get("title"),
                        air.get("subtitle"), air.get("description"),
                        json.dumps(air.get("genres") or []), air.get("kind"),
                    ),
                )
    db.set_setting("guide_updated_at", _now())


def prune_guide(now: float | None = None) -> int:
    """Drop airings that ended more than GUIDE_RETENTION_DAYS ago.

    The only thing that removes guide rows. Age is the sole criterion - an
    airing missing from the device is kept, because that is the normal state of
    everything in the past.
    """
    cutoff = int(now if now is not None else datetime.now(timezone.utc).timestamp())
    cutoff -= GUIDE_RETENTION_DAYS * 86_400
    with db.write() as conn:
        cur = conn.execute("DELETE FROM guide_airing WHERE end_epoch < ?", (cutoff,))
        return cur.rowcount
```

`load_guide` is unchanged — the grid renders forward and must keep its `end_epoch >= cutoff` filter.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_guide_sync.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the whole suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: all pass. Guide tests in `test_recordings.py` that assumed a rebuild may need their expectations updated — if one fails, confirm it was asserting the wipe, and update it to assert retention instead.

- [ ] **Step 6: Commit**

```bash
git add backend/app/store.py backend/tests/test_guide_sync.py
git commit -m "fix: stop the guide sync from destroying everything that aired"
```

---

## Task 3: Index writers for channels and airings

**Files:**
- Modify: `backend/app/store.py` (`save_guide`, add writers)
- Test: `backend/tests/test_search.py`

**Interfaces:**
- Consumes: `db.write()`, tables from Task 1, `save_guide` from Task 2.
- Produces: `store.index_channel(conn, ch: dict) -> None`, `store.index_airing(conn, channel_id: str, channel_label: str, air: dict) -> None`. Both take an open connection so they join the caller's transaction.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_search.py`:

```python
import time

from app import store


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -v`
Expected: FAIL — `search_doc` is empty.

- [ ] **Step 3: Implement**

Add to `app/store.py`:

```python
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
    """
    ident = str(ch.get("identifier"))
    conn.execute(
        "INSERT OR REPLACE INTO search_doc(kind, ref, title, subtitle, body, "
        "    channel, start_epoch, duration, target) "
        "VALUES ('channel', ?, ?, ?, ?, ?, NULL, 0, ?)",
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
    """Put one airing in the search index, keyed the same way as guide_airing."""
    genres = air.get("genres") or []
    body = " ".join(
        str(p) for p in (air.get("description"), *genres, label) if p
    )
    conn.execute(
        "INSERT OR REPLACE INTO search_doc(kind, ref, title, subtitle, body, "
        "    channel, start_epoch, duration, target) "
        "VALUES ('airing', ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            f"{channel_id}|{air.get('start')}",
            air.get("title"),
            air.get("subtitle") or "",
            body,
            label,
            _end_epoch(air.get("start"), 0),
            int(air.get("duration") or 0),
            json.dumps({"tab": "grid", "at": air.get("start")}),
        ),
    )
```

In `save_guide`, call them inside the existing loops — `index_channel(conn, ch)` after the channel insert, and `index_airing(conn, str(ch.get("identifier")), label, air)` after each airing insert, with `label = channel_label(ch)` computed once per channel.

In `prune_guide`, delete the matching index rows in the same transaction, before the airing delete:

```python
        conn.execute(
            "DELETE FROM search_doc WHERE kind = 'airing' AND ref IN ("
            "  SELECT channel_id || '|' || start FROM guide_airing WHERE end_epoch < ?)",
            (cutoff,),
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py tests/test_guide_sync.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/store.py backend/tests/test_search.py
git commit -m "feat: index channels and airings as the guide is saved"
```

---

## Task 4: Index writer for recordings

The library is not in SQLite — the `recording` table is cache bookkeeping, and the device is listed per request. The writer runs on each listing.

**Files:**
- Modify: `backend/app/store.py` (writer), `backend/app/routes/recordings.py:45-63` (`list_recordings`)
- Test: `backend/tests/test_search.py`

**Interfaces:**
- Consumes: `db.write()`.
- Produces: `store.index_recordings(items: list[dict]) -> None` — takes the projected recording dicts the Library view already receives.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_search.py`:

```python
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
```

Add `import json` to the test file if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -k recording -v`
Expected: FAIL — `index_recordings` not defined.

- [ ] **Step 3: Implement**

Add to `app/store.py`:

```python
def index_recordings(items: list[dict]) -> None:
    """Index the library from a device listing.

    Called on every listing rather than on a write, because the device holds
    the library and we only mirror the handful we have transcoded. Cheap: a
    replace per recording, and there are rarely more than a few dozen.
    """
    if not items:
        return
    with db.write() as conn:
        for rec in items:
            ch = rec.get("channel") or {}
            label = " ".join(
                str(p) for p in (ch.get("number"), ch.get("network") or ch.get("call_sign")) if p
            )
            conn.execute(
                "INSERT OR REPLACE INTO search_doc(kind, ref, title, subtitle, body, "
                "    channel, start_epoch, duration, target) "
                "VALUES ('recording', ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(rec.get("object_id")),
                    rec.get("title"),
                    rec.get("subtitle") or "",
                    " ".join(str(p) for p in (rec.get("description"), label) if p),
                    label,
                    _end_epoch(rec.get("start"), 0),
                    int(rec.get("duration") or 0),
                    json.dumps({"tab": "library", "watch": int(rec.get("object_id"))}),
                ),
            )
```

In `app/routes/recordings.py`, inside `list_recordings`, after the items are decorated and before the return:

```python
    # Feed the search index from the listing: the device owns the library, so
    # this is the only moment we reliably see all of it.
    try:
        store.index_recordings(items)
    except Exception as e:  # noqa: BLE001 - indexing must never break the library
        print(f"[search] indexing recordings failed: {e}", flush=True)
```

Add `from .. import store` to that module's imports if absent.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/store.py backend/app/routes/recordings.py backend/tests/test_search.py
git commit -m "feat: index recordings as the library is listed"
```

---

## Task 5: Search query and ranking

**Files:**
- Create: `backend/app/search.py`
- Test: `backend/tests/test_search.py`

**Interfaces:**
- Consumes: `db.query()`, tables from Task 1.
- Produces: `search.search(q: str, limit: int = 5, kinds: list[str] | None = None) -> dict` returning `{"query", "coverage", "groups"}`. `search.KIND_ORDER: tuple[str, ...]`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_search.py`:

```python
from app import search as search_mod


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -k search_mod -v`
Expected: FAIL — module `app.search` does not exist.

- [ ] **Step 3: Implement**

Create `backend/app/search.py`:

```python
"""Ranked search across channels, guide airings and recordings.

One index, one query, one ranking. `kind` is what lets a new source join
without touching this module's callers - the API shape and every surface are
already written in terms of groups of kinds.
"""

import json
import re

from . import db

MIN_QUERY = 2

# Groups in the order a person wants them: what you already have, then what is
# coming, then where to watch it.
KIND_ORDER = ("recording", "airing", "channel")

# bm25 returns negative numbers and more negative is a better match, so results
# order ascending. Weights are title, subtitle, body, channel - a title hit
# should beat the same word buried in a description, which is most of what
# makes a five-item dropdown useful.
_RANK = "bm25(search_fts, 10.0, 5.0, 1.0, 2.0)"

_WORD = re.compile(r"[^\w]+", re.UNICODE)


def fts_query(raw: str) -> str:
    """Turn typed text into a safe FTS5 MATCH expression.

    FTS5 MATCH is a query language, not a string: quotes, hyphens and NEAR are
    all operators, so passing user text through unescaped is both a syntax
    error waiting to happen and a way to run queries nobody asked for. Every
    word is quoted, and the last gets a prefix star so results narrow as you
    type rather than appearing only on the final keystroke.
    """
    words = [w for w in _WORD.split(raw) if w]
    if not words:
        return ""
    quoted = [f'"{w}"' for w in words[:-1]]
    quoted.append(f'"{words[-1]}"*')
    return " ".join(quoted)


def coverage() -> dict:
    """How far back the guide history can be trusted.

    Without this an empty result cannot be told apart from a period the sync
    never saw - which is the exact confusion this feature exists to remove.
    """
    row = db.query_one(
        "SELECT MIN(started_at) AS since, MAX(finished_at) AS last "
        "FROM guide_sync WHERE ok = 1"
    )
    return {
        "since": row["since"] if row else None,
        "last_sync": row["last"] if row else None,
    }


def search(q: str, limit: int = 5, kinds: list[str] | None = None) -> dict:
    """Ranked matches grouped by kind.

    `limit` is per group, so one endpoint serves a three-row dropdown and a
    fifty-row results page.
    """
    q = (q or "").strip()
    limit = max(1, min(int(limit), 50))
    out = {"query": q, "coverage": coverage(), "groups": []}
    if len(q) < MIN_QUERY:
        return out

    match = fts_query(q)
    if not match:
        return out

    wanted = [k for k in KIND_ORDER if not kinds or k in kinds]
    for kind in wanted:
        total = db.query_one(
            "SELECT COUNT(*) AS n FROM search_fts "
            "JOIN search_doc d ON d.rowid = search_fts.rowid "
            "WHERE search_fts MATCH ? AND d.kind = ?",
            (match, kind),
        )["n"]
        if not total:
            continue
        rows = db.query(
            "SELECT d.kind, d.ref, d.title, d.subtitle, d.channel, "
            "       d.start_epoch, d.duration, d.target "
            "FROM search_fts JOIN search_doc d ON d.rowid = search_fts.rowid "
            f"WHERE search_fts MATCH ? AND d.kind = ? ORDER BY {_RANK}, "
            "       d.start_epoch IS NULL DESC, d.start_epoch "
            "LIMIT ?",
            (match, kind, limit),
        )
        out["groups"].append({
            "kind": kind,
            "total": total,
            "items": [_item(r) for r in rows],
        })
    return out


def _item(row) -> dict:
    return {
        "kind": row["kind"],
        "ref": row["ref"],
        "title": row["title"],
        "subtitle": row["subtitle"] or None,
        "channel": row["channel"] or None,
        "start_epoch": row["start_epoch"] or None,
        "duration": row["duration"],
        "target": json.loads(row["target"]),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/search.py backend/tests/test_search.py
git commit -m "feat: rank search results across the three sources"
```

---

## Task 6: Cross-reference past airings against recordings

**Files:**
- Modify: `backend/app/search.py`
- Test: `backend/tests/test_search.py`

**Interfaces:**
- Consumes: `search_doc` rows of kind `recording`.
- Produces: airing items gain `recorded: {"object_id": int} | None`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_search.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -k recorded -v`
Expected: FAIL — `KeyError: 'recorded'`

- [ ] **Step 3: Implement**

In `app/search.py`, add:

```python
import time

# How far a recording's start may drift from the airing's and still be the same
# showing. Recordings carry padding, so they rarely start on the minute. Wider
# than this starts matching a different repeat of the same programme, which is
# a worse answer than admitting we do not know.
MATCH_WINDOW = 300


def _recorded_for(title: str | None, start_epoch: int | None) -> dict | None:
    """The recording of this showing, if there is one."""
    if not title or not start_epoch or start_epoch > time.time():
        return None
    row = db.query_one(
        "SELECT ref FROM search_doc WHERE kind = 'recording' "
        "  AND lower(trim(title)) = lower(trim(?)) "
        "  AND abs(start_epoch - ?) <= ? "
        "ORDER BY abs(start_epoch - ?) LIMIT 1",
        (title, start_epoch, MATCH_WINDOW, start_epoch),
    )
    return {"object_id": int(row["ref"])} if row else None
```

In `_item`, add to the returned dict:

```python
        "recorded": (
            _recorded_for(row["title"], row["start_epoch"])
            if row["kind"] == "airing" else None
        ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/search.py backend/tests/test_search.py
git commit -m "feat: tell a past airing whether it was recorded"
```

---

## Task 7: The `/api/search` endpoint

**Files:**
- Create: `backend/app/routes/search.py`
- Modify: `backend/app/main.py` (import and `include_router`)
- Test: `backend/tests/test_search.py`

**Interfaces:**
- Consumes: `search.search()`, `state.is_authenticated`.
- Produces: `GET /api/search?q=&limit=&kinds=`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_search.py`:

```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_search_requires_auth():
    assert client.get("/api/search?q=broncos").status_code == 401


def test_limit_is_clamped_rather_than_rejected(monkeypatch):
    """A surface asking for too much should get a lot, not an error."""
    import app.routes.search as route
    monkeypatch.setattr(route.state, "is_authenticated", True, raising=False)
    _doc("airing", "a|1", "Survivor")
    r = client.get("/api/search?q=survivor&limit=9999")
    assert r.status_code == 200
    assert r.json()["groups"][0]["items"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -k "requires_auth or clamped" -v`
Expected: FAIL — 404, route not registered.

- [ ] **Step 3: Implement**

Create `backend/app/routes/search.py`:

```python
"""One search endpoint behind three surfaces."""

from fastapi import APIRouter, HTTPException, Query

from .. import search as search_mod
from ..state import state

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
async def search(
    q: str = Query("", description="What to look for"),
    limit: int = Query(5, description="Per kind, not overall"),
    kinds: str | None = Query(None, description="CSV filter, e.g. airing,recording"),
):
    """Ranked matches grouped by kind.

    A query shorter than two characters returns empty groups rather than 400:
    every surface calls this on each keystroke, and an error for "b" would mean
    each of them needing the same special case.
    """
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    wanted = [k.strip() for k in kinds.split(",")] if kinds else None
    try:
        return search_mod.search(q, limit=limit, kinds=wanted)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Search error: {e}")
```

In `app/main.py`, add `search` to the routes import and register it:

```python
from .routes import auth, channels, iptv, recordings, resume, search, stream
...
app.include_router(search.router)
```

Place the `include_router` beside the existing ones.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_search.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/search.py backend/app/main.py backend/tests/test_search.py
git commit -m "feat: serve search over one endpoint"
```

---

## Task 8: Background guide sync

**Files:**
- Create: `backend/app/guide_sync.py`
- Modify: `backend/app/main.py` (lifespan)
- Test: `backend/tests/test_guide_sync.py`

**Interfaces:**
- Consumes: `state._build_grid_enrichment(max_airings=15000)` via `state.get_grid_guide`, `store.save_guide`, `store.prune_guide`.
- Produces: `guide_sync.sync_once(fetch) -> int` (airings seen), `guide_sync.run_forever()`, `guide_sync.SYNC_HOURS: float`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_guide_sync.py`:

```python
import asyncio

from app import db, guide_sync


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_guide_sync.py -k sync -v`
Expected: FAIL — module `app.guide_sync` does not exist.

- [ ] **Step 3: Implement**

Create `backend/app/guide_sync.py`:

```python
"""Keep the guide mirror current, and record how far back it can be trusted.

The device's guide is forward-looking: once a programme airs it falls off, and
no later request recovers it. History is therefore only ever captured as it
happens, and any period this process was not running is a permanent hole. That
is why the sync runs on startup as well as on a timer - coming back after
downtime captures whatever is still inside the device's forward window, which
recovers everything if the gap was shorter than that window.
"""

import asyncio
import os
import traceback
from datetime import datetime, timezone

from . import db, store

SYNC_HOURS = float(os.environ.get("TABLO_GUIDE_SYNC_HOURS", "6"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def sync_once(fetch) -> int:
    """Run one sync. Returns airings seen; never raises.

    `fetch` is an awaitable returning grid rows, injected so this is testable
    without a device.
    """
    started = _now()
    with db.write() as conn:
        cur = conn.execute(
            "INSERT INTO guide_sync(started_at) VALUES (?)", (started,)
        )
        run_id = cur.lastrowid

    try:
        rows = await fetch()
        seen = sum(len(ch.get("airings") or []) for ch in rows)
        await asyncio.to_thread(store.save_guide, rows)
        removed = await asyncio.to_thread(store.prune_guide)
        db.execute(
            "UPDATE guide_sync SET finished_at = ?, airings_seen = ?, ok = 1 "
            "WHERE id = ?",
            (_now(), seen, run_id),
        )
        print(f"[guide] synced {seen} airings, pruned {removed}", flush=True)
        return seen
    except Exception as e:  # noqa: BLE001 - a failed sync must not stop the app
        db.execute(
            "UPDATE guide_sync SET finished_at = ?, ok = 0, error = ? WHERE id = ?",
            (_now(), f"{type(e).__name__}: {e}", run_id),
        )
        print(f"[guide] sync failed: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        return 0


async def run_forever(fetch) -> None:
    """Sync at startup, then every SYNC_HOURS."""
    while True:
        await sync_once(fetch)
        await asyncio.sleep(SYNC_HOURS * 3600)
```

In `app/main.py`, inside `lifespan` before `yield`:

```python
    # Guide history can only be captured going forward, so this starts at boot
    # rather than waiting for the first interval.
    async def _fetch_guide():
        return await state.get_grid_guide(max_airings=15000)

    guide_task = asyncio.create_task(guide_sync.run_forever(_fetch_guide))
```

and after `yield`:

```python
    guide_task.cancel()
```

Add `import asyncio` and `from . import guide_sync` to the imports.

`state.get_grid_guide` currently takes no arguments. Give it `max_airings: int = 1000` and pass it through to `_build_grid_enrichment`, and make it bypass the stored-guide short-circuit when `max_airings != 1000` — otherwise the sync would read back its own mirror instead of fetching.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_guide_sync.py -v`
Expected: PASS

- [ ] **Step 5: Run the whole backend suite and lint**

Run: `cd backend && .venv/bin/python -m pytest -q`
Then check the files you touched are ruff-clean relative to before.

- [ ] **Step 6: Commit**

```bash
git add backend/app/guide_sync.py backend/app/main.py backend/app/state.py backend/tests/test_guide_sync.py
git commit -m "feat: keep the guide mirror current in the background"
```

---

## Task 9: Frontend search client and hook

**Files:**
- Modify: `frontend/src/api/tablo.ts`
- Create: `frontend/src/hooks/useSearch.ts`
- Test: `frontend/src/__tests__/search.test.tsx`

**Interfaces:**
- Consumes: `api` object, react-query `useQuery`.
- Produces: types `SearchItem`, `SearchGroup`, `SearchResponse`, `SearchTarget`; `api.search(q, opts)`; `useSearch(query, opts)` returning `{ data, isFetching }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/search.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSearch } from "../hooks/useSearch";
import { api } from "../api/tablo";
import type { SearchResponse } from "../api/tablo";

const EMPTY: SearchResponse = {
  query: "", coverage: { since: null, last_sync: null }, groups: [],
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useSearch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not call the server for a query too short to mean anything", async () => {
    const spy = vi.spyOn(api, "search").mockResolvedValue(EMPTY);
    renderHook(() => useSearch("b"), { wrapper });
    await new Promise(r => setTimeout(r, 300));
    expect(spy).not.toHaveBeenCalled();
  });

  it("searches once the query is long enough", async () => {
    const spy = vi.spyOn(api, "search").mockResolvedValue({ ...EMPTY, query: "broncos" });
    const { result } = renderHook(() => useSearch("broncos"), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => expect(result.current.data?.query).toBe("broncos"));
  });

  it("debounces a query being typed", async () => {
    const spy = vi.spyOn(api, "search").mockResolvedValue(EMPTY);
    const { rerender } = renderHook(({ q }) => useSearch(q), {
      wrapper, initialProps: { q: "bro" },
    });
    rerender({ q: "bron" });
    rerender({ q: "bronc" });
    rerender({ q: "broncos" });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // Only the settled query reaches the server, not each keystroke.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("broncos", expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx`
Expected: FAIL — cannot resolve `../hooks/useSearch`.

- [ ] **Step 3: Implement**

In `src/api/tablo.ts`, add the types and the call:

```ts
export type SearchKind = "channel" | "airing" | "recording";

/** What activating a result does. Mirrors the backend's `target`. */
export interface SearchTarget {
  tab: "live" | "grid" | "library";
  /** Channel identifier or recording object_id, when the result is playable. */
  watch?: string | number;
  /** ISO start, for a guide result. */
  at?: string;
}

export interface SearchItem {
  kind: SearchKind;
  ref: string;
  title: string | null;
  subtitle: string | null;
  channel: string | null;
  start_epoch: number | null;
  duration: number;
  target: SearchTarget;
  /** For a past airing: the recording of it, if there is one. */
  recorded: { object_id: number } | null;
}

export interface SearchGroup {
  kind: SearchKind;
  /** Full match count, which may exceed `items.length`. */
  total: number;
  items: SearchItem[];
}

export interface SearchResponse {
  query: string;
  /** How far back guide history can be trusted. */
  coverage: { since: string | null; last_sync: string | null };
  groups: SearchGroup[];
}
```

and inside the `api` object:

```ts
  search: (q: string, opts?: { limit?: number; kinds?: SearchKind[] }) => {
    const p = new URLSearchParams({ q });
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.kinds?.length) p.set("kinds", opts.kinds.join(","));
    return req<SearchResponse>(`/search?${p}`);
  },
```

Note `BASE` is `/api`, so the path is `/search?...`.

Create `src/hooks/useSearch.ts`:

```ts
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SearchKind, type SearchResponse } from "../api/tablo";

/** Below this a query matches so much that the results are noise. */
export const MIN_QUERY = 2;

const DEBOUNCE_MS = 180;

/**
 * The one thing that talks to the search API.
 *
 * Three surfaces render these results - a dropdown, a palette and a page - and
 * routing them all through here is what stops them disagreeing about ordering,
 * loading state or what counts as too short to search.
 *
 * Debounced rather than fired per keystroke: the server ranks across the whole
 * index, and typing "broncos" would otherwise be seven ranked queries of which
 * six are discarded.
 */
export function useSearch(
  query: string,
  opts: { limit?: number; kinds?: SearchKind[] } = {},
) {
  const [settled, setSettled] = useState(query);
  const { limit, kinds } = opts;

  useEffect(() => {
    const t = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const trimmed = settled.trim();
  const enabled = trimmed.length >= MIN_QUERY;

  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ["search", trimmed, limit, kinds?.join(",")],
    queryFn: () => api.search(trimmed, { limit, kinds }),
    enabled,
    staleTime: 30_000,
  });

  return { data: enabled ? data : undefined, isFetching: enabled && isFetching };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/tablo.ts frontend/src/hooks/useSearch.ts frontend/src/__tests__/search.test.tsx
git commit -m "feat: add the search client and its hook"
```

---

## Task 10: The shared result row

**Files:**
- Create: `frontend/src/components/SearchResultRow.tsx`
- Test: `frontend/src/__tests__/search.test.tsx`

**Interfaces:**
- Consumes: `SearchItem`.
- Produces: `<SearchResultRow item selected onActivate />`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/search.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchResultRow } from "../components/SearchResultRow";
import type { SearchItem } from "../api/tablo";

const ITEM: SearchItem = {
  kind: "airing", ref: "ch1|x", title: "Broncos at Chiefs",
  subtitle: "Week 1", channel: "8.1 CBS",
  start_epoch: 1_760_000_000, duration: 3600,
  target: { tab: "grid", at: "2026-10-09T10:13:20Z" }, recorded: null,
};

describe("SearchResultRow", () => {
  it("shows the title, station and subtitle", () => {
    render(<SearchResultRow item={ITEM} selected={false} onActivate={() => {}} />);
    expect(screen.getByText("Broncos at Chiefs")).toBeInTheDocument();
    expect(screen.getByText("8.1 CBS")).toBeInTheDocument();
    expect(screen.getByText(/Week 1/)).toBeInTheDocument();
  });

  it("says a past airing was recorded, so you know you did not miss it", () => {
    render(
      <SearchResultRow
        item={{ ...ITEM, recorded: { object_id: 80888 } }}
        selected={false}
        onActivate={() => {}}
      />,
    );
    expect(screen.getByText(/recorded/i)).toBeInTheDocument();
  });

  it("activates on click", () => {
    const onActivate = vi.fn();
    render(<SearchResultRow item={ITEM} selected={false} onActivate={onActivate} />);
    fireEvent.click(screen.getByRole("option"));
    expect(onActivate).toHaveBeenCalledWith(ITEM);
  });

  it("marks the selected row for assistive tech, not just visually", () => {
    render(<SearchResultRow item={ITEM} selected onActivate={() => {}} />);
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx`
Expected: FAIL — cannot resolve `../components/SearchResultRow`.

- [ ] **Step 3: Implement**

Create `frontend/src/components/SearchResultRow.tsx`:

```tsx
import { Tv, CalendarClock, Film, CheckCircle2 } from "lucide-react";
import type { SearchItem } from "../api/tablo";

const ICONS = { channel: Tv, airing: CalendarClock, recording: Film } as const;

function when(epoch: number | null): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "numeric", minute: "2-digit",
  })}`.replace(/\s/g, m => (m === " " ? " " : m));
}

/**
 * One match, rendered the same way in the dropdown, the palette and the page.
 *
 * Shared deliberately: three surfaces showing the same result differently is
 * how a search starts feeling like three separate features.
 */
export function SearchResultRow({
  item, selected, onActivate,
}: {
  item: SearchItem;
  selected: boolean;
  onActivate: (item: SearchItem) => void;
}) {
  const Icon = ICONS[item.kind];
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={() => onActivate(item)}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition
                  ${selected ? "bg-accent/20" : "hover:bg-white/5"}`}
    >
      <Icon className="w-4 h-4 shrink-0 text-white/30" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white truncate">
          {item.title || "Untitled"}
        </p>
        <p className="text-[11px] text-white/40 truncate">
          {[item.subtitle, when(item.start_epoch)].filter(Boolean).join(" · ")}
        </p>
      </div>
      {item.channel && (
        <span className="text-[10px] font-bold text-white/30 tabular-nums shrink-0">
          {item.channel}
        </span>
      )}
      {item.recorded && (
        <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 shrink-0">
          <CheckCircle2 className="w-3 h-3" aria-hidden />
          Recorded
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SearchResultRow.tsx frontend/src/__tests__/search.test.tsx
git commit -m "feat: render a search match the same way everywhere"
```

---

## Task 11: A `search` route

**Files:**
- Modify: `frontend/src/lib/route.ts`
- Test: `frontend/src/__tests__/search.test.tsx`

**Interfaces:**
- Produces: `Tab` gains `"search"`; `Route` gains `q?: string`. `#/search?q=broncos` round-trips.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/search.test.tsx`:

```tsx
import { parseRoute, writeRoute } from "../lib/route";

describe("search route", () => {
  it("round-trips a query through the hash", () => {
    expect(parseRoute("#/search?q=broncos")).toEqual({
      tab: "search", watch: null, q: "broncos",
    });
  });

  it("encodes a query with spaces", () => {
    writeRoute({ tab: "search", watch: null, q: "denver broncos" });
    expect(window.location.hash).toContain("q=denver%20broncos");
  });

  it("leaves the other tabs alone", () => {
    expect(parseRoute("#/library/rec/80888")).toEqual({
      tab: "library", watch: { kind: "recording", id: 80888 }, q: undefined,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx -t "search route"`
Expected: FAIL — tab falls back to `"live"`, `q` undefined.

- [ ] **Step 3: Implement**

In `src/lib/route.ts`:

```ts
export type Tab = "live" | "grid" | "library" | "search";

export interface Route {
  tab: Tab;
  /** What is playing, if anything. */
  watch: { kind: "live"; id: string } | { kind: "recording"; id: number } | null;
  /** The search text, when the search tab is showing. */
  q?: string;
}

const TABS: Tab[] = ["live", "grid", "library", "search"];
```

In `parseRoute`, before splitting on `/`, pull the query off the hash:

```ts
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const tab = (TABS as string[]).includes(parts[0]) ? (parts[0] as Tab) : "live";
  const q = queryPart
    ? new URLSearchParams(queryPart).get("q") ?? undefined
    : undefined;
```

Return `q` alongside `tab` and `watch` in all three return statements.

In `writeRoute`, after the existing `watch` handling:

```ts
  if (route.tab === "search" && route.q) {
    hash += `?q=${encodeURIComponent(route.q)}`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run`
Expected: PASS, including the existing route tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/route.ts frontend/src/__tests__/search.test.tsx
git commit -m "feat: address search results in the hash"
```

---

## Task 12: The topbar dropdown

**Files:**
- Create: `frontend/src/components/SearchDropdown.tsx`
- Modify: `frontend/src/components/ChannelGrid.tsx:226-241`
- Test: `frontend/src/__tests__/search.test.tsx`

**Interfaces:**
- Consumes: `useSearch`, `SearchResultRow`.
- Produces: `<SearchDropdown query onActivate onSeeAll />`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/search.test.tsx`:

```tsx
import { SearchDropdown } from "../components/SearchDropdown";

const GROUPED: SearchResponse = {
  query: "broncos",
  coverage: { since: "2026-09-01T00:00:00Z", last_sync: "2026-09-15T18:00:00Z" },
  groups: [
    { kind: "recording", total: 1, items: [{ ...ITEM, kind: "recording", ref: "1" }] },
    { kind: "airing", total: 7, items: [ITEM] },
  ],
};

describe("SearchDropdown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("groups results by kind", async () => {
    vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchDropdown query="broncos" onActivate={() => {}} onSeeAll={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/recordings/i)).toBeInTheDocument();
    expect(await screen.findByText(/guide/i)).toBeInTheDocument();
  });

  it("offers the rest when a group is truncated", async () => {
    vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchDropdown query="broncos" onActivate={() => {}} onSeeAll={() => {}} />
      </QueryClientProvider>,
    );
    // 7 matched, 1 shown.
    expect(await screen.findByText(/6 more/i)).toBeInTheDocument();
  });

  it("says nothing was found rather than showing an empty box", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ ...EMPTY, query: "zzzz" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchDropdown query="zzzz" onActivate={() => {}} onSeeAll={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx -t SearchDropdown`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement**

Create `frontend/src/components/SearchDropdown.tsx`:

```tsx
import { useSearch } from "../hooks/useSearch";
import { SearchResultRow } from "./SearchResultRow";
import type { SearchItem, SearchKind } from "../api/tablo";

const LABELS: Record<SearchKind, string> = {
  recording: "Recordings",
  airing: "Guide",
  channel: "Channels",
};

/** Results hanging under the topbar input. Three per group: a glance, not a list. */
export function SearchDropdown({
  query, onActivate, onSeeAll,
}: {
  query: string;
  onActivate: (item: SearchItem) => void;
  onSeeAll: () => void;
}) {
  const { data } = useSearch(query, { limit: 3 });
  if (!data) return null;

  const empty = data.groups.length === 0;

  return (
    <div
      role="listbox"
      aria-label="Search results"
      className="absolute top-full mt-2 left-0 right-0 z-50 rounded-xl border border-white/10
                 bg-surface-raised shadow-2xl p-2 max-h-[70vh] overflow-y-auto"
    >
      {empty ? (
        <p className="px-3 py-4 text-xs text-white/30">No matches for "{data.query}"</p>
      ) : (
        data.groups.map(group => (
          <div key={group.kind} className="mb-2 last:mb-0">
            <p className="px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white/20">
              {LABELS[group.kind]}
            </p>
            {group.items.map(item => (
              <SearchResultRow
                key={`${item.kind}:${item.ref}`}
                item={item}
                selected={false}
                onActivate={onActivate}
              />
            ))}
            {group.total > group.items.length && (
              <button
                onClick={onSeeAll}
                className="w-full text-left px-3 py-1.5 text-[11px] text-accent hover:underline"
              >
                {group.total - group.items.length} more
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
```

In `ChannelGrid.tsx`, the search input block: drop the `invisible` gating on tab (it becomes a global search, not a Live TV filter), make the wrapper `relative`, and render `<SearchDropdown>` beneath when `filter.trim().length >= 2` and the input has focus. On activate, route via the item's `target`; on "see all", `setTab("search")` with the query.

Keep the existing in-memory channel filtering for the Live TV list — it stays instant and works while the dropdown shows server results.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SearchDropdown.tsx frontend/src/components/ChannelGrid.tsx frontend/src/__tests__/search.test.tsx
git commit -m "feat: show grouped results under the topbar search"
```

---

## Task 13: The Cmd-K palette

**Files:**
- Create: `frontend/src/components/CommandPalette.tsx`
- Modify: `frontend/src/components/ChannelGrid.tsx` (mount it)
- Test: `frontend/src/__tests__/search.test.tsx`

**Interfaces:**
- Consumes: `useSearch`, `SearchResultRow`.
- Produces: `<CommandPalette open onClose onActivate />`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/search.test.tsx`:

```tsx
import { CommandPalette } from "../components/CommandPalette";

function palette(onActivate = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CommandPalette open onClose={() => {}} onActivate={onActivate} />
    </QueryClientProvider>,
  );
  return onActivate;
}

describe("CommandPalette", () => {
  afterEach(() => vi.restoreAllMocks());

  it("moves the selection with the arrow keys and activates with Enter", async () => {
    vi.spyOn(api, "search").mockResolvedValue({
      ...EMPTY,
      groups: [{
        kind: "airing", total: 2,
        items: [ITEM, { ...ITEM, ref: "ch1|y", title: "Second" }],
      }],
    });
    const onActivate = palette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "broncos" } });
    await screen.findByText("Broncos at Chiefs");

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ title: "Second" }));
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CommandPalette open onClose={onClose} onActivate={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CommandPalette open={false} onClose={() => {}} onActivate={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx -t CommandPalette`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement**

Create `frontend/src/components/CommandPalette.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useSearch } from "../hooks/useSearch";
import { SearchResultRow } from "./SearchResultRow";
import type { SearchItem } from "../api/tablo";

/**
 * Search over whatever is on screen.
 *
 * A modal rather than a route so it never disturbs playback: opening it while
 * watching must not unmount the player.
 */
export function CommandPalette({
  open, onClose, onActivate,
}: {
  open: boolean;
  onClose: () => void;
  onActivate: (item: SearchItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const { data } = useSearch(query, { limit: 5 });

  // One flat list, because the keyboard moves through results rather than
  // through groups - the headings are visual only.
  const flat = useMemo(
    () => (data?.groups ?? []).flatMap(g => g.items),
    [data],
  );

  useEffect(() => setCursor(0), [data]);
  useEffect(() => {
    if (!open) { setQuery(""); setCursor(0); }
  }, [open]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(c => Math.min(c + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && flat[cursor]) {
      e.preventDefault();
      onActivate(flat[cursor]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[15vh] px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
        onKeyDown={onKeyDown}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-xl rounded-2xl border border-white/10 bg-surface-raised shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 border-b border-white/5">
          <Search className="w-4 h-4 text-white/20" aria-hidden />
          <input
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="palette-results"
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search channels, guide and recordings..."
            className="flex-1 bg-transparent py-4 text-sm placeholder-white/20 focus:outline-none"
          />
        </div>
        <div id="palette-results" role="listbox" className="p-2 max-h-[50vh] overflow-y-auto">
          {flat.map((item, i) => (
            <SearchResultRow
              key={`${item.kind}:${item.ref}`}
              item={item}
              selected={i === cursor}
              onActivate={onActivate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

In `ChannelGrid.tsx`, add `const [paletteOpen, setPaletteOpen] = useState(false)` and a global key listener:

```tsx
  // Cmd-K / Ctrl-K from anywhere, including while watching.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
```

Mount `<CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onActivate={...} />` at the top level of the returned tree.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CommandPalette.tsx frontend/src/components/ChannelGrid.tsx frontend/src/__tests__/search.test.tsx
git commit -m "feat: add a Cmd-K palette over the current tab"
```

---

## Task 14: The full results page

**Files:**
- Create: `frontend/src/components/SearchResultsView.tsx`
- Modify: `frontend/src/components/ChannelGrid.tsx` (render for the `search` tab)
- Test: `frontend/src/__tests__/search.test.tsx`

**Interfaces:**
- Consumes: `useSearch`, `SearchResultRow`, `Route.q`.
- Produces: `<SearchResultsView query onQueryChange onActivate />`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/search.test.tsx`:

```tsx
import { SearchResultsView } from "../components/SearchResultsView";

describe("SearchResultsView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("filters to one kind when a chip is chosen", async () => {
    const spy = vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsView query="broncos" onQueryChange={() => {}} onActivate={() => {}} />
      </QueryClientProvider>,
    );
    await screen.findByText("Broncos at Chiefs");

    fireEvent.click(screen.getByRole("button", { name: /^guide$/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("broncos",
        expect.objectContaining({ kinds: ["airing"] })),
    );
  });

  it("reports how far back the guide can be trusted", async () => {
    vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchResultsView query="broncos" onQueryChange={() => {}} onActivate={() => {}} />
      </QueryClientProvider>,
    );
    // Distinguishes "did not air" from "we were not watching".
    expect(await screen.findByText(/history since/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/search.test.tsx -t SearchResultsView`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement**

Create `frontend/src/components/SearchResultsView.tsx`:

```tsx
import { useState } from "react";
import { useSearch } from "../hooks/useSearch";
import { SearchResultRow } from "./SearchResultRow";
import type { SearchItem, SearchKind } from "../api/tablo";

const CHIPS: { id: SearchKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "recording", label: "Recordings" },
  { id: "airing", label: "Guide" },
  { id: "channel", label: "Channels" },
];

export function SearchResultsView({
  query, onQueryChange, onActivate,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onActivate: (item: SearchItem) => void;
}) {
  const [chip, setChip] = useState<SearchKind | "all">("all");
  const { data, isFetching } = useSearch(query, {
    limit: 50,
    kinds: chip === "all" ? undefined : [chip],
  });

  const since = data?.coverage.since;

  return (
    <div className="flex flex-col gap-6">
      <input
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder="Search channels, guide and recordings..."
        className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/5 text-sm
                   placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />

      <div className="flex gap-2 flex-wrap">
        {CHIPS.map(c => (
          <button
            key={c.id}
            onClick={() => setChip(c.id)}
            className={`px-4 py-1.5 rounded-full text-sm font-bold transition
                        ${chip === c.id ? "bg-accent/15 text-accent" : "text-white/40 hover:text-white/60"}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Coverage, so an empty result cannot be mistaken for "it never aired". */}
      {since && (
        <p className="text-[11px] text-white/25">
          Guide history since {new Date(since).toLocaleDateString()}
        </p>
      )}

      {isFetching && !data && <p className="text-xs text-white/30">Searching...</p>}

      {data?.groups.length === 0 && query.trim().length >= 2 && (
        <p className="text-sm text-white/30">No matches for "{data.query}"</p>
      )}

      {data?.groups.map(group => (
        <section key={group.kind}>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-white/20 mb-2">
            {group.kind} · {group.total}
          </h2>
          <div role="listbox" className="flex flex-col gap-1">
            {group.items.map(item => (
              <SearchResultRow
                key={`${item.kind}:${item.ref}`}
                item={item}
                selected={false}
                onActivate={onActivate}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

In `ChannelGrid.tsx`, render it when `activeTab === "search"`, passing `route.q ?? ""` and writing the query back through `writeRoute`. Add a shared `activate(item: SearchItem)` used by all three surfaces:

```tsx
  function activate(item: SearchItem) {
    const t = item.target;
    if (t.tab === "library" && typeof t.watch === "number") {
      setTab("library");
      // hand off to the library's player the same way a card click does
    } else if (t.tab === "live" && typeof t.watch === "string") {
      setTab("live");
    } else {
      setTab("grid");
    }
    setPaletteOpen(false);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run`
Expected: PASS

- [ ] **Step 5: Lint and typecheck**

Run: `cd frontend && npx eslint src/ && npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/SearchResultsView.tsx frontend/src/components/ChannelGrid.tsx frontend/src/__tests__/search.test.tsx
git commit -m "feat: add a full search results page"
```

---

## Task 15: Deploy and verify against the device

**Files:** none — verification only.

- [ ] **Step 1: Run both suites**

```bash
cd backend && .venv/bin/python -m pytest -q
cd ../frontend && npx vitest run
```

- [ ] **Step 2: Restart the backend**

```bash
cd backend && pkill -f "uvicorn app.main:app"; sleep 2
nohup ./run-native.sh >> /tmp/native.log 2>&1 &
```

- [ ] **Step 3: Watch the first sync**

```bash
sleep 20 && grep "\[guide\]" /tmp/native.log | tail -5
```

Expected: `[guide] synced N airings, pruned 0` with N well above 986 — the point of the exercise is that the mirror is no longer capped at the grid's 1000.

- [ ] **Step 4: Confirm the index filled and the endpoint answers**

```bash
sqlite3 "$HOME/Library/Application Support/tablo-web/tablo.db" \
  "SELECT kind, count(*) FROM search_doc GROUP BY kind;"
curl -s "http://127.0.0.1:8000/api/search?q=broncos&limit=3" | python3 -m json.tool | head -40
```

Expected: rows for all three kinds; results ranked with title matches first.

- [ ] **Step 5: Rebuild the frontend**

```bash
cd /Users/peet/GitHub/tablo-web && docker compose \
  -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.native.yml \
  up -d --build frontend
```

- [ ] **Step 6: Check by hand**

Type in the topbar, press Cmd-K, press Enter to land on the results page. Confirm a past airing shows **Recorded** where a recording exists.

- [ ] **Step 7: Commit anything outstanding**

```bash
git status --porcelain
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Retention (31 days, env override) | 2 |
| Append-only, never delete on absence | 2 |
| Sync on startup + every 6h | 8 |
| Coverage log | 8, surfaced in 5 and 14 |
| Schema v2, FTS, triggers | 1 |
| Ranking (bm25 weights, tie-break) | 5 |
| Writers (channel, airing, recording) | 3, 4 |
| Cross-reference ±5 min | 6 |
| API shape, limit per kind, `kinds` | 5, 7 |
| `useSearch` single caller, debounce | 9 |
| Shared row | 10 |
| Dropdown / palette / page | 12, 13, 14 |
| `#/search?q=` | 11 |
| Migration builds index from existing data | **gap — see below** |

**Gap found and closed:** the spec says the index is built on first startup after migration from whatever is already stored, so search works before the first sync. No task did that. Add to **Task 8, Step 3**, in `run_forever` before the loop:

```python
async def backfill_index() -> int:
    """Index what is already stored, so search works before the first sync.

    Migration creates empty tables; without this, search returns nothing until
    a sync finishes, which looks identical to a broken feature.
    """
    rows = await asyncio.to_thread(store.load_guide)
    if rows:
        await asyncio.to_thread(store.save_guide, rows)
    return sum(len(ch.get("airings") or []) for ch in rows)
```

and call it once at the top of `run_forever`. Test in `test_guide_sync.py`:

```python
def test_the_index_is_backfilled_from_what_is_already_stored():
    now = time.time()
    store.save_guide([_channel("ch1", [_airing("Stored", int(now + 3600))])], now=now)
    db.execute("DELETE FROM search_doc")

    asyncio.run(guide_sync.backfill_index())

    assert db.query("SELECT 1 FROM search_doc WHERE title = 'Stored'")
```

**Placeholder scan:** no TBDs; every code step carries real code.

**Type consistency:** `SearchItem`/`SearchGroup`/`SearchResponse` are defined in Task 9 and used unchanged in 10, 12, 13, 14. `store.index_channel`/`index_airing` take `conn` first (Task 3) and are called that way in Task 2's `save_guide`. `search.search(q, limit, kinds)` matches the route in Task 7 and the client in Task 9. `Route.q` is added in Task 11 and consumed in Task 14.
