# Recordings Schedule Redesign — Design Spec

**Date:** 2026-09-20

**Goal:** Make the Recordings page tell the truth about what will and won't record. Two coupled changes: (1) fix the series merge so *scheduled-but-not-yet-recorded* series appear at all, and (2) add a per-series **Schedule** view — a time-ordered grid of every upcoming airing of the series you record, each marked with its real record state, so a rerun that a "New" rule silently skips is visible instead of hidden.

**Audience:** the device owner managing their own DVR. No production, no other users (project memory: tablo-web is under development).

## Why

Two defects in the current Recordings page, found by live device probing:

1. **Ruled-but-unrecorded series are invisible.** `_compose_series_index` builds cards by iterating `/recordings/shows` (series with bytes on disk) only. The guide rule-set (`/guide/shows?state=requested&lh`) is used purely as an enrichment lookup. A series with a rule set but nothing recorded yet has `recordings_path: null` and never enters the loop. On the live device, **4 of 8 ruled series are hidden this way**: *Jeopardy!* (new), *First Civilizations* (all), *Comics Unleashed With Byron Allen* (all), and one more (`C31616310_SHOW_…`, all).

2. **No way to see "airing but not recording."** The `requested&lh` and `conflicted&lh` feeds only list airings that *will* record or that clash. An episode a rule *skips* (e.g. a rerun under "New") is in neither feed — so the page can show "Jeopardy! · rule: New" while giving no hint that tonight's episode is a rerun and won't be captured. Live proof: *Jeopardy!* has 21 upcoming airings — 10 `scheduled`, 11 `skipped`/`not_new`.

## Device facts (probed 2026-09-20, do not re-derive)

- `/guide/shows?state=requested&lh` → the rule set. Returns **minimal** objects: `{identifier, keep, schedule}` only. `recordings_path`/`guide_path` are `null` on it — even for recorded series. `schedule.rule` ∈ `all|new|none`. This is the only endpoint that lists *which series have a rule*; `?state=requested` without `&lh` is **400**.
- `/guide/shows` (no query) → the catalog: ~884 plain series paths (`/guide/series/377`). Batchable. Each resolved object carries `identifier`, `series`/`sport`/`movie` (with `title`, `cover_image.image_id`), `show_counts`, and `recordings_path` (null if unrecorded).
- `POST /batch` resolves a list of **paths** → objects. Rejects SHOW identifiers (`C…_SHOW_…`) with 400 `invalid_post_data`. Chunk size 48 works.
- `{guide_series_path}/episodes` → plain batchable airing paths for **future** airings only (no past). Each resolved airing: `{airing_details{datetime, channel, duration}, episode, schedule{state, skip_reason, offsets}, object_id, series_path, season_path}`.
- `schedule.state` vocabulary on an airing: `scheduled` (will record), `skipped` (won't — see `skip_reason`, e.g. `not_new`), `conflicted` (wanted, tuner clash), `recording` (in progress now), `none`.
- Mapping a ruled `identifier` → its guide series path is only possible by matching `identifier` across the catalog batch. There is no derivation from the identifier string.

## Global Constraints

- **Worktree; TDD.** Backend: `ruff` clean, `pytest -q` green (run with the main-checkout venv against worktree code — see plan). Frontend: `tsc -b` + `vitest` green, `npm run build` succeeds, eslint no new errors on changed files.
- **Deploy** via the tablo-stack skill: `docker compose build frontend && up -d --force-recreate frontend`; backend restart via `run-native.sh` (does not hot-reload); `check-stack.sh` exits 0; bundle hash changes. Push (user authorized).
- **No PII in logs or commits.** Never log `/server/location` (postal code) or raw device identifiers beyond what already ships.
- **Recordings own their assets** (memory): covers are image ids resolved through the existing `/api/images/...` path, not device URLs.
- Follow existing `series.py` / `RecordingsView.tsx` / `SeriesDetail.tsx` patterns; do not restructure unrelated code.

## Architecture

One shared backend primitive feeds both halves.

### Shared resolver — `resolve_ruled()`

New in `backend/app/routes/series.py`. Returns the full picture of every series that has a rule, whether or not it has recordings.

```
RuledSeries = {
  identifier: str,            # C…_SHOW_… — the settings handle
  guide_path: str,            # /guide/series/NNN — for /episodes
  recordings_path: str|None,  # on disk, or None if never recorded
  title: str,
  cover_image_id: int|None,
  rule: "all"|"new"|"none",
  keep: {rule, count},
  offsets: {start, end, source},
  show_counts: {airing_count, scheduled_count, conflicted_count, ...},
}

resolve_ruled() -> list[RuledSeries]:
  ruled = GET /guide/shows?state=requested&lh          # minimal objects, the identifiers+rule
  want_ids = {r.identifier for r in ruled}
  index = _ruled_catalog_index()                       # identifier -> catalog object, cached
  for each ruled r: join r (rule/keep/offsets) with index[r.identifier] (title/cover/paths/counts)
```

`_ruled_catalog_index()` batches `/guide/shows` (884 paths, chunks of 48) into an `identifier → object` map. **Cached in-process with a short TTL (5 min)** keyed on the device id — the catalog is large and stable; rebuilding it on every page load is wasteful. Cache miss cost ≈ 19 batch calls; hit cost = 0. A ruled identifier absent from the catalog (should not happen) is skipped with a `logging.warning` (no PII — log the identifier only).

### Half 1 — merge fix (`/series`)

`_compose_series_index` changes from "iterate recorded paths" to "iterate the union":

- Start from `resolve_ruled()` → one card per ruled series (recorded or not).
- Add cards for recorded-but-unruled series: `/recordings/shows` paths not already covered by a ruled `recordings_path` (rule `none`, as today).
- A ruled-unrecorded card has `recordings_path: null`, `episode_count: 0`, `rule` set. The frontend already tolerates a null path for the CloudOff/settings case; it must additionally suppress delete/library actions when the path is null (see Half 3).

`SeriesCard` gains no required new field; `scheduled_count` (from `show_counts`) is added as an optional field for the badge.

### Half 2 — schedule feed (`GET /api/recordings/schedule`)

New endpoint. For each ruled series (from `resolve_ruled()`), fetch `{guide_path}/episodes`, batch-resolve, and emit one flat, time-sorted list of airing rows:

```
ScheduleRow = {
  airing_id: int,             # object_id
  series_title: str,
  cover_image_id: int|None,
  datetime: str,              # ISO, airing_details.datetime
  duration: int,              # seconds
  channel: str|None,          # call sign, best-effort from airing_details.channel
  state: "scheduled"|"skipped"|"conflicted"|"recording"|"none",
  skip_reason: str|None,      # e.g. "not_new"
}
```

Per-series `/episodes` fetches run under a bounded `asyncio.Semaphore`; a flaky series drops itself (logs, no crash), matching the existing `one()` tolerance. Rows sorted by `datetime`. No paging needed — scoped to the owner's series, tens of rows in practice.

The existing `/series/airings` (per-series, in the drawer) drops its state filter so the drawer's Upcoming tab shows **all** upcoming airings of that one series with their states — the same "every airing even if not recording" data, series-scoped.

### Half 3 — frontend

**Tabs collapse to three:** `Recordings · Schedule · Failures` in `RecordingsView.tsx`. Remove the `scheduled`, `upcoming`, `conflicts` segments.

- **Recordings** — the series-card grid, now including ruled-unrecorded series. A ruled-unrecorded card shows a "Scheduled" status chip and "0 recorded"; its delete/clear-cover actions are hidden (null `recordings_path`), settings remain editable.
- **Schedule** — new `ScheduleGrid` component consuming `/api/recordings/schedule`. Time-ordered rows grouped by day, each with a state marker: `Scheduled` (accent), `Airing` (muted, shows skip reason like "rerun"), `Conflict` (danger), `Recording` (success, live). Independent on/off toggle chips filter by state: `[Scheduled] [Airing] [Conflict]` (Recording always shown when present). Contained-scroll pane, same layout idiom as the current lists.
- **Failures** — unchanged (`failed_count > 0` filter over the series list).
- **Series Detail drawer** — its Upcoming tab now lists all upcoming airings with state markers (via the unfiltered `/series/airings`), so the same gap is visible per-series.

`skip_reason` → human label map (frontend): `not_new` → "Rerun", `manual` → "Skipped", else "Won't record".

## Data flow

```
RecordingsView
 ├─ tab Recordings → GET /api/recordings/series   (resolve_ruled ∪ recorded)  → SeriesGrid
 ├─ tab Schedule   → GET /api/recordings/schedule (resolve_ruled → /episodes) → ScheduleGrid
 └─ tab Failures   → same /series data, failed_count>0                        → SeriesGrid
SeriesDetail (drawer)
 └─ tab Upcoming   → GET /api/recordings/series/airings?…  (state filter removed) → AiringsPane
```

Both `/series` and `/schedule` call `resolve_ruled()`, which shares the cached catalog index — so opening the page warms the cache for both tabs.

## Error handling

- Catalog batch chunk fails → that chunk's identifiers stay unresolved; affected series are skipped (warning). The page renders the rest.
- A ruled series with no `guide_path` after resolve → skipped from Schedule (can't fetch episodes), still shown as a card if it has other data.
- `/episodes` 404 for a series → dropped from Schedule, logged, page renders.
- Device unreachable → existing 502 behavior via `_try`/`request_device`.
- Frontend: empty Schedule (no ruled series or all filtered out) → an empty-state line ("Nothing scheduled"), not a spinner.

## Testing

**Backend** (`backend/tests/`):
- `resolve_ruled` joins minimal ruled objects with catalog index: ruled-unrecorded series gets title/cover/guide_path; recorded ruled series keeps its recordings_path. (mock device responses)
- Catalog index caches: second call within TTL issues no new `/guide/shows` batch (assert call count).
- `/series` union: a ruled-unrecorded identifier appears as a card with `recordings_path=None`, `rule` set, `episode_count=0`; a recorded-unruled series still appears with rule `none`.
- `/schedule`: mixed `scheduled`/`skipped` episodes across two series produce a flat time-sorted list with correct `state`/`skip_reason`; a series whose `/episodes` 404s is skipped without failing the response.
- `/series/airings` returns all states (no filter) — a `skipped` airing is present.

**Frontend** (`frontend/src/__tests__/`):
- `ScheduleGrid` renders rows grouped by day with correct markers; toggling `Airing` off hides skipped rows; empty state shows.
- `RecordingsView` shows three tabs; a ruled-unrecorded card renders with the Scheduled chip and no delete control.
- `skip_reason` label mapping.

## Out of scope (YAGNI)

- Whole-lineup airing browse (that's the Guide page).
- Editing a rule from the Schedule grid (settings stay in the drawer).
- Persisting toggle state across sessions (in-memory per mount is fine).
- Per-airing one-off record/skip actions — not requested; future work.
