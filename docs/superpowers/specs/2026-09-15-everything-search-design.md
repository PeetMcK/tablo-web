# Everything Search

One search box that finds live channels, guide airings and recordings, served
from SQLite and presented through three surfaces: a topbar dropdown, a Cmd-K
palette, and a full results page.

Supersedes nothing. Builds on the SQLite mirror described in
`2026-09-15-sqlite-persistence-design.md`.

## Problem

There is no way to find anything by name. The Live TV tab has a search input,
but it filters the channel list already in memory and reaches nothing else. To
answer "is the Broncos game on this week, and did I already record it?" you read
the guide grid by eye, then the library by eye, and hope.

Two facts make this worse than it sounds.

The stored guide covers **986 airings, about 37 hours**, against the **8455** the
device holds. Anything more than a day or two out is not in the database at all,
so even a perfect search over what we store would find almost nothing.

The guide is also **destroyed and rebuilt on every save**. `save_guide` issues
`DELETE FROM guide_channel`, and `guide_airing` references it
`ON DELETE CASCADE`, so every sync wipes every airing. Two further filters drop
the past independently: `save_guide` skips airings that have already ended, and
`load_guide` hides them on read. Nothing that has aired survives anywhere.

That last point is the one that matters most. The device's `/guide/airings` is
forward-looking - once a programme airs it falls off the list, and no later
request can recover it. History can therefore only ever be captured going
forward. Any stretch where this app was not running is a permanent hole that
nothing can backfill.

## Approach

A single ranked index over three sources, queried once, rendered three ways.

The guide mirror becomes **append-only**: a record of what aired rather than a
snapshot of what the device currently lists. Rows are written by sync and
removed only by age. The device dropping an airing never deletes our copy.

Search reads a dedicated index rather than the source tables. One table, one
query, one ranking, and a `kind` column that lets a fourth source join later
without touching the query, the API, or any of the three surfaces.

### Why not the alternatives

**`LIKE` over the existing tables.** Fast enough at this size - a substring scan
of 8455 rows is about a millisecond - and it needs no new schema. Rejected
because there is no ranking. All three surfaces show a truncated list, so *which*
five results appear is the entire user experience, and `LIKE` leaves that to be
hand-rolled and hand-tuned.

**Query the three tables per request and merge in Python.** No schema change at
all, but every new source means editing the merge, ranking is still hand-rolled,
and recordings are not in SQLite - so it would hit the device on every keystroke.

## Retention

Airings are kept for 31 days after they end.

A module constant with an env override (`TABLO_GUIDE_RETENTION_DAYS`), not a
stored setting - it becomes a real app setting when there is a settings screen
to put it on, and inventing one now would be building the plumbing twice.

The number is deliberately generous rather than tuned. At ~267 bytes an airing,
31 days across 27 channels is roughly 7 MB and a year would be 80 MB, so the
cost of keeping too much is nil and the cost of keeping too little is
unrecoverable. There is no cap and no eviction; only age prunes.

Pruning runs once per sync:

```sql
DELETE FROM guide_airing WHERE end_epoch < :now - :retention_days * 86400
```

**Absence from the device is never a reason to delete.** This is the whole
distinction between a mirror and a record, and it is the rule most likely to be
undone by a well-meaning later change.

## Sync

A background task started from the FastAPI lifespan:

- **On startup, always.** Coming back after downtime captures whatever is still
  in the device's forward window, which recovers everything if the gap was
  shorter than the device's horizon (about two weeks).
- **Then every `TABLO_GUIDE_SYNC_HOURS`, default 6.** The device guide moves
  slowly and each pass costs ~8455 device requests at concurrency 30, so this is
  chosen for margin against missed history rather than freshness.

It calls the existing enrichment path with `max_airings=15000` - the EPG mode
that bypasses the grid's 1000 cap - and writes through `save_guide`, so the grid
and search share one mirror with no second copy to drift.

A failed sync logs and waits for the next tick. A stale mirror still serves
search; returning nothing because a refresh failed would be worse.

### Coverage

Each attempt appends to `guide_sync`. The search response reports
`coverage: {since, last_sync}`, where `since` is the earliest successful sync
still inside the retention window.

This exists so search can distinguish **"it did not air"** from **"we were not
watching"**. Without it, a gap in history is indistinguishable from an empty
result, which is precisely the failure this feature is meant to remove.

## Schema

Migration to `SCHEMA_VERSION = 2`.

```sql
CREATE TABLE IF NOT EXISTS guide_sync (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    airings_seen  INTEGER NOT NULL DEFAULT 0,
    ok            INTEGER NOT NULL DEFAULT 0,
    error         TEXT
);

CREATE TABLE IF NOT EXISTS search_doc (
    kind         TEXT NOT NULL,          -- 'channel' | 'airing' | 'recording'
    ref          TEXT NOT NULL,          -- identity within that kind
    title        TEXT,
    subtitle     TEXT,
    body         TEXT,                   -- description, genres, network
    channel      TEXT,                   -- display label, e.g. "8.1 CBS"
    start_epoch  INTEGER,                -- NULL for channels
    duration     INTEGER NOT NULL DEFAULT 0,
    target       TEXT NOT NULL,          -- JSON: what clicking it does
    PRIMARY KEY (kind, ref)
);
CREATE INDEX IF NOT EXISTS search_doc_start ON search_doc(start_epoch);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, subtitle, body, channel,
    content='search_doc',
    content_rowid='rowid',
    tokenize='unicode61'
);
```

`search_fts` is an external-content table over `search_doc`, kept in step by
triggers on insert, update and delete. Triggers rather than manual rebuilds
because the writers are spread across sync, the recordings listing and cache
registration, and a missed rebuild would show as silently stale results.

### Ranking

`bm25(search_fts, 10.0, 5.0, 1.0, 2.0)` - title, subtitle, body, channel. Lower
is better in SQLite's bm25, so results order ascending.

Ties break by `start_epoch`: upcoming before past, nearest first. A channel has
no `start_epoch` and sorts first within its group, since a channel match on a
short query is almost always what was meant.

### Writers

One function per source, each idempotent and safe to call repeatedly:

| Source | Called from | `ref` | `target` |
|---|---|---|---|
| Channels | `save_guide` | channel identifier | `{tab: "live", watch: identifier}` |
| Airings | `save_guide` | `channel_id \| start` | `{tab: "grid", at: start}` |
| Recordings | `list_recordings`, `cache.register` | `object_id` | `{tab: "library", watch: object_id}` |

Recordings need a writer because the library is **not** in SQLite. The
`recording` table holds cache bookkeeping - path, pinned, an `info` JSON blob -
for the handful of recordings we have transcoded, not the device's library. The
device is the source of truth and is listed per request, so the writer runs on
each listing and keeps the index current as a side effect.

## Cross-reference

A past airing on its own only half-answers "did I miss it?". Each airing result
whose `start_epoch` is in the past is matched against recordings on title and
start time, and carries `recorded: {object_id, cached}` or `recorded: null`.

The match is exact on normalised title plus a start within ±5 minutes, which
covers the padding a recording carries. Anything looser produces false matches
across repeats of the same show, which is worse than reporting nothing.

## API

```
GET /api/search?q=<text>&limit=<n>&kinds=<csv>
```

- `q` - trimmed; fewer than 2 characters returns empty groups rather than 400,
  so a surface can call on every keystroke without special-casing.
- `limit` - **per kind**, default 5, max 50. The dropdown asks for 3 and the
  results page for 50 against the same endpoint.
- `kinds` - optional filter, e.g. `airing,recording`. Absent means all.

```json
{
  "query": "broncos",
  "coverage": { "since": "2026-09-15T00:00:00Z", "last_sync": "2026-09-15T18:00:00Z" },
  "groups": [
    { "kind": "recording", "total": 2, "items": [ ... ] },
    { "kind": "airing",    "total": 7, "items": [ ... ] },
    { "kind": "channel",   "total": 1, "items": [ ... ] }
  ]
}
```

Each item: `kind`, `ref`, `title`, `subtitle`, `channel`, `start`, `duration`,
`target`, and for airings `recorded`. `total` is the full match count so a
surface can say "7 more" without a second request.

Groups are ordered recording, airing, channel - what you already have, then what
is coming, then where to watch it.

## Frontend

One hook, three presentations.

`useSearch(query, { limit, kinds })` wraps react-query with a 180 ms debounce
and cancels superseded requests. It is the only thing that talks to the API, so
the three surfaces cannot disagree about results, ordering or loading state.

`SearchResultRow` renders one item for every surface, so a match looks the same
wherever it appears.

**Topbar dropdown.** Generalises the existing input in `ChannelGrid`, which
today filters the in-memory channel list and is wired only to Live TV. It keeps
that instant local filtering for channels and gains grouped server results
beneath. `limit: 3`. Enter opens the results page.

**Cmd-K palette.** A modal over the current tab, so it never disturbs what is
playing. Cmd-K / Ctrl-K opens, Escape closes, arrows move, Enter activates.
`limit: 5`.

**Results page.** A new `search` tab in `lib/route.ts`, addressed
`#/search?q=broncos`, with per-kind filter chips. `limit: 50`.

The hash carries the query only - identity, not scroll position or selection -
matching the existing rule that the URL says what you are looking at and nothing
about where you are within it.

## Migration

`SCHEMA_VERSION` 1 → 2. Additive: three new tables and triggers, no existing
table altered, no data moved.

`save_guide` changes from delete-and-rebuild to upsert. Channels become
`INSERT OR REPLACE`; the `DELETE FROM guide_channel` goes away, which is what
stops the cascade from wiping the airings. Airings are already
`INSERT OR REPLACE` and stay so. The `end < cutoff` skip on write is removed.

`load_guide` keeps its `end_epoch >= cutoff` filter unchanged - the grid renders
forward and must not show finished airings. Search queries `search_doc`
directly, so history is searchable without altering what the grid displays.

The index is built on first startup after migration from whatever is already
stored, so search works immediately rather than waiting for a sync.

## Verification

Backend:

- A sync no longer destroys airing history - write, sync, assert the earlier
  airings are still present. This is the regression that the cascade caused.
- Retention boundary: an airing that ended 30 days ago survives, 32 days ago is
  pruned, and one absent from the device but inside the window survives.
- Ranking: a title match outranks a description match for the same term.
- `kinds` filtering, `limit` per group, `total` exceeding returned items.
- Queries under 2 characters return empty groups, not an error.
- Cross-reference: exact title within ±5 minutes matches; 30 minutes does not.
- Coverage reports the earliest successful sync inside the window.

Frontend:

- The hook debounces and cancels superseded queries.
- Palette keyboard navigation: arrows move, Enter activates, Escape closes.
- All three surfaces render the same item identically.
- The dropdown still filters channels locally with no server results.

## Risks

**History gaps are permanent.** If the backend is not running, that period is
lost and cannot be recovered. Mitigated by syncing on startup and by reporting
coverage, not solved. The backend still does not survive a reboot, so this is a
live exposure rather than a theoretical one.

**A full sync is ~8455 device requests.** The device is the bottleneck for
transcoding too - it serves roughly 10x realtime in total - so a sync competes
directly with playback and with the background fill.

It does **not** participate in the transcode cache's on-demand bookkeeping, so
none of the existing yielding applies to it: `_pause_background` suspends
encoders, not HTTP fetches. Mitigation is therefore scheduling and concurrency,
not priority - the sync runs at startup and every six hours rather than on
demand, and uses a lower semaphore (8) than the guide's interactive path so it
leaves headroom for a seek.

If this proves disruptive in practice the honest fix is to make the sync
observe the same `_ondemand` signal the encoders do, which is a larger change
than this spec covers.

**Triggers keeping FTS in step.** An external-content FTS5 table that falls out
of step returns stale or missing rows silently. Covered by a test asserting the
index reflects a deletion.

## Out of scope

- **Scheduled recordings.** The device exposes them - airings carry
  `schedule.state`, and `GET /guide/airings?state=scheduled` returns them,
  signing the bare path while sending the query. They need their own UI, which
  is being designed separately. The seam is `kind`: a fourth writer joins the
  index without touching the query, the API or any surface.
- Search history and saved searches.
- Fuzzy or typo-tolerant matching. FTS5 prefix matching covers partial words.
- Any change to how the grid renders.
