# Recordings Page — Design

**Date:** 2026-09-20
**Status:** built 2026-09-20 (plan: `docs/superpowers/plans/2026-09-20-recordings-page.md`).
v1 deviations: Upcoming/Conflicts render parsed lineup handles (time + channel +
skip reason) — the `?state=requested&lh` projection carries only the handle and
it is not `/batch`-resolvable, so titled upcoming is a follow-up. Series
management (rules/keep/padding/danger/episodes/bulk) is complete. A recorded
series with no active rule (no guide identifier) shows episode cleanup with the
settings section disabled.

## Goal

A new top-level **Recordings** tab: the DVR **management** home. Cards-first.
Where Library is "captured episodes, to watch," Recordings is "everything about
what my DVR records" — the series I record and their rules, what's scheduled,
conflicts, and bulk cleanup of episodes.

Every capability below is backed by a **captured, confirmed** device call (see
"Device API" — no no-ops this time).

## Non-goals (deferred)

- **All Library work** — Library stays exactly as-is for now; its UX cleanup
  (inline delete, watched toggle, view types) is a separate later pass.
- **Additional view types** for Recordings (list/table) — cards-first now;
  alternate views come once management is complete.
- **Conflict *resolution* writes** — v1 *shows* conflicts (read); choosing which
  airing wins is a later capture.
- **Migrating ShowInfo's "Edit Series Recording"** into Recordings — leave it in
  ShowInfo for now; retire it once Recordings owns series settings.

## Entry point

New tab in the top nav: `Live | Guide | Library | Recordings`. Add
`"recordings"` to the `Tab` type (`frontend/src/lib/route.ts`) and a nav button
after Library (`ChannelGrid.tsx`).

## Page shape

Recordings opens on a top **segmented switch**: **Series · Upcoming · Conflicts**
(Conflicts hidden when zero). All three are card grids (cards-first).

### 1. Series (primary)
A card per series I record or have recordings for. Card:
- poster (series art), title
- badges: recording rule (All / New / None), keep (All / N / None), episode
  count, unwatched count, a conflict dot if any of its airings conflict
Tapping a card opens **Series Detail**.

The list is the **merge** of:
- `GET /guide/shows?state=requested&lh` — series with an active rule (carries the
  **guide identifier** = the settings PATCH target, plus `recordings_path`,
  `schedule{rule,offsets}`, `keep{rule,count}`)
- `GET /recordings/shows` — series that have recordings (may include ones whose
  rule is now none). Join on `recordings_path`.

A series with a rule but no episodes yet, and a series with episodes but no
current rule, both appear.

### 2. Upcoming
Cards/list of scheduled airings from `GET /guide/airings?state=requested&lh`
(116 on the test box), each `{identifier, schedule{state, qualifier,
skip_reason, offsets}}`. Grouped by day. Read-only in v1 (tapping opens the
existing ShowInfo sheet for per-airing record/skip, which already works).

### 3. Conflicts
`GET /guide/airings?state=conflicted&lh`. **Surfaced prominently at the top of
the Recordings tab** when non-empty (a banner/alert above the series grid, not
buried in a segment) — exact UX **TBD**. v1 is read-only (flags what's
double-booked); resolution is deferred.

## Series Detail (modal/panel)

Header: poster, title, genre, description (from `GET {recordings_path}` →
`series{title, genres, description}`).

**Recording rule** — segmented All / New / None
→ `PATCH /guide/{identifier} {"schedule":{"rule":"all"|"new"|"none"}}`

**Keep** — All / None / Keep N (presets 1·3·5·10·20 + free int)
→ `{"keep":{"rule":"count","count":N}}` | `{"keep":{"rule":"all"}}` |
`{"keep":{"rule":"none"}}`

**Padding** — start early/late, end early/late (UI in minutes, wire in
**seconds**; negative start = start early, positive end = end late)
→ `{"schedule":{"offsets":{"source":"show","start":<sec>,"end":<sec>}}}`
(source flips to `"show"` when customised, `"none"` at defaults)

**Danger zone — two distinct actions:**
- **Stop recording** = rule → none, **keeps** existing episodes
- **Stop & delete everything** = rule → none **+** bulk delete
  (`POST {recordings_path}/delete {"filter":"unprotected"}`) — confirm dialog

**Episodes** — list, each row:
- checkbox (multi-select), title, S/E, aired date, duration, size,
  watched pip, protected lock icon, in-progress indicator if recording
- per-row actions: watched toggle, protect toggle, delete
- source: `GET {recordings_path}/episodes` → `/recordings/{kind}/episodes/{eid}`
  paths → detail each (`object_id, airing_details{datetime,duration},
  episode{title,number,season_number,orig_air_date}, video_details{size,state},
  snapshot_image, user_info{position, watched, protected}`)

**Recording status is driven entirely by `user_info` (confirmed on-device):**
- **New** = `position == 0 && !watched` (never started) — the NEW badge
- **In progress** = `position > 0 && !watched` (resume from `position` seconds)
- **Watched** = `watched == true`
- **Protected** = `protected == true` (independent; the lock icon; skipped by
  `delete {filter:"unprotected"}`)

Verified: two "Comics Unleashed" episodes, both `watched:false` — S4E32
`position:0` shows **New**, S1E126 `position:98` does not. So the NEW badge keys
on `position`, not just `watched`. `unwatched_count` on a series card should count
`!watched` (both New + in-progress); a separate "new count" would be
`position==0 && !watched` if wanted.

`position` and `watched` are **independent** and both settable in one PATCH
(`PATCH /recordings/{kind}/episodes|events/{id} {"position":N,"watched":bool}`).
On completion the official app sets `watched:true` **and** resets `position:0`
together (a watched recording sits at position 0, same as New — the `watched`
flag is what distinguishes them).

**Duration: use `video_details.duration`, NOT `airing_details.duration`.**
`airing_details.duration` is the **scheduled slot** length; the real recorded
length is `video_details.duration`. They diverge whenever a program overruns —
confirmed on the College Football recording: slot `airing_details.duration`
10800s (180:00), actual `video_details.duration` 12615s (210:15), the extra 30
min captured by a +1800s post-padding (`video_details.recorded_offsets.end`).
All progress bars, "X min left", and percent-complete must use
`video_details.duration`. `video_details` also carries `size`, `state`,
`has_snap_grid` (BIF), `seek`, and the offsets actually applied.

**Who sets `watched`: the DEVICE does, off the player session — not the client.**
The NFL playback capture shows position PATCHes climbing to the end and a
`DELETE /player/sessions/{id}`, with **no `watched` write at all**, yet the games
became watched. So the device flips `watched:true` and resets `position:0`
server-side when a **device player session** (`POST {rec}/watch` → keepalive →
`PATCH {position}` → `DELETE /player/sessions/{id}`) ends near the end. A raw
`PATCH {position:<near-end>}` **does not** trigger it (my manual test didn't) —
it's the session lifecycle, not the position value.

Implication for OUR player (later): if recordings play **through the device's
`/watch` session**, watched is handled for free — just report position and tear
the session down. If we **bypass** it (serve via our own VOD/transcode path),
the device won't know and we must set watched ourselves, replicating the
observed **~5-minute near-end window** (bracketed on College Football: 10:40
remaining = unwatched, 4:45 = watched; also ~90s/~3:xx on a 1920s recording),
against `video_details.duration`, resetting `position` to 0.

For **this page**, none of that applies: it only needs the manual **Mark
watched / unwatched** toggle → `PATCH {watched}` (works regardless of session).

**Bulk bar** (appears with a selection, plus always-available series-wide ops):
- Delete selected (loop `DELETE /recordings/{id}`)
- Delete watched → `POST {recordings_path}/delete {"filter":"watched"}`
- Delete all → `POST {recordings_path}/delete {"filter":"unprotected"}`
  (skips protected — that is the device's "all"; deleting a protected episode
  needs unprotect first or a single delete)

## Two different cards — series vs episode

- **Recordings top-level cards are SERIES cards** — one per series (poster,
  title, series-level badges: rule · keep · episode_count · unwatched_count ·
  conflict dot). They do **not** carry the per-episode watched/protect/NEW
  overlay. Their counts come straight from the series object's `show_counts`
  (`{airing_count, unwatched_count, protected_count,
  watched_and_protected_count, failed_count}`) and its `keep`/`guide_path`.
- **Episode cards** (the thumbnail card below) are what **Library** shows
  directly (deferred) and what the **episode list inside a Recordings series
  detail** shows. The overlay convention applies to *these*, not to series cards.

## Episode card — thumbnail overlay convention (shared)

The convention for an **episode** thumbnail card — used by the episode list in a
Recordings series detail, and inherited by the Library episode card later
(Library build deferred). Maps to the existing LibraryView corners:

```
┌─ thumbnail ────────────────────────────────┐
│ [top-left]                     [top-right]  │
│  state badge + "Only here"      watched · lock
│  (Recording/Incomplete/Cached/                (affirmative persistent,
│   Ready/%cached; CloudOff beside it)          negative on hover)
│                                             │
│ [bottom-left]                  [bottom-right]│
│  NEW chip                        runtime     │
├──────────────────────────────────────────────┤  ← fill/progress strip on the bottom edge
```

- **top-left** — the single mutually-exclusive cache/record **state badge**
  (Recording / Incomplete / Cached / Ready / "% cached"), with the `CloudOff`
  **"Only here"** badge moved to sit **beside** it (was top-right).
- **top-right** — **watched + protect toggle cluster**, order **watched (left) →
  protect (right)**. Rule: *the affirmative icon is persistent (rest + hover) and
  clickable to turn off; the negative icon is hidden at rest and appears only on
  hover, clickable to turn on.* No icon morphs on hover.

  | slot | state | rest | hover | click → |
  |---|---|---|---|---|
  | Watched | watched | `Eye` | `Eye` | unwatch |
  |         | unwatched | — | `EyeOff` | watch |
  | Protect | protected | `Lock` | `Lock` | unprotect |
  |         | unprotected | — | `LockOpen` | protect |

  So watched+protected shows open-eye + closed-lock (unchanged on hover);
  neither shows nothing at rest, both actionable icons on hover. Icons: lucide
  `Eye`/`EyeOff`, `Lock`/`LockOpen`. Chip style matches the runtime badge
  (`bg-ink/80`). Each toggle `stopPropagation`s (a tap toggles, never plays),
  optimistic with revert-on-error. Writes: watched → `POST /recordings/{id}/watched`,
  protect → `PATCH /recordings/{kind}/episodes|events/{id} {protected}`.
- **bottom-left** — **NEW chip**, shown when `position == 0 && !watched` (accent
  chip). The only always-free corner otherwise.
- **bottom-right** — runtime badge (`video_details.duration`, per the duration
  note above — never `airing_details.duration`).
- **bottom edge** — the existing fill/progress strip (resume position).

Hover reveal uses the same **card-level** group-hover trigger the Resume/From
start buttons already use.

## Device API (all captured / confirmed on 172.16.16.121, fw 2.2.58)

All writes to `/guide/{identifier}` are **nested**; the `?lh` query is stripped
before signing by `state` (already handled). Offsets are **seconds**.

| Concern | Call |
|---|---|
| Series w/ rules | `GET /guide/shows?state=requested&lh` (**`&lh` required**; 400 without) |
| Recorded series | `GET /recordings/shows` → `/recordings/{kind}/{id}` paths |
| Series meta | `GET /recordings/{kind}/{id}` |
| Series episodes | `GET /recordings/{kind}/{id}/episodes` → `/recordings/{kind}/episodes/{eid}` |
| Rule | `PATCH /guide/{identifier} {"schedule":{"rule":"all"\|"new"\|"none"}}` |
| Keep | `PATCH /guide/{identifier} {"keep":{"rule":"count"\|"all"\|"none","count":N}}` |
| Padding | `PATCH /guide/{identifier} {"schedule":{"offsets":{"source":"show","start":<sec>,"end":<sec>}}}` |
| Upcoming | `GET /guide/airings?state=requested&lh` |
| Conflicts | `GET /guide/airings?state=conflicted&lh` |
| Delete one | `DELETE /recordings/{id}` |
| Bulk delete | `POST {recordings_path}/delete {"filter":"watched"\|"unprotected"}` |
| Watched | `POST /recordings/{id}/watched {watched:bool}` (or `PATCH {watched}`) |
| Protect | `PATCH /recordings/{kind}/episodes\|events/{id} {"protected":true\|false}` |

`GET /guide/{identifier}` is **write-only** (404 on GET); read rule/keep/offsets
from the `/guide/shows?state=requested` projection. `{kind}` ∈
`series | sports | movies` (from `recordings_path`); episode segment is
`episodes` for series/movies, `events` for sports.

Note: one keep PATCH returned a transient **999** then succeeded on retry — add
a single retry on 999 for the `/guide/{identifier}` writes.

## Backend — expand `/api/recordings` (+ a series-settings route)

Reuse the existing signed helpers (`request_device`, `patch_device`,
`_request_device_raw` for 204s). New routes:

- `GET  /api/recordings/series` → composed index (merge the two device lists;
  each item `{identifier, recordings_path, title, art, kind, rule, keep,
  offsets, episode_count, unwatched_count}`). Tolerant per-series.
- `GET  /api/recordings/series/detail?recordings_path=…` → `{meta, settings
  {rule,keep,offsets,identifier}, episodes:[…]}`.
- `PATCH /api/recordings/series/settings` → body `{identifier, rule?, keep?,
  offsets?}`; allow-listed; maps to the nested device shapes; single retry on
  999; returns the device echo.
- `POST /api/recordings/series/bulk-delete` → `{recordings_path, filter}` with
  `filter ∈ {watched, unprotected}`; forwards to `POST {recordings_path}/delete`.
- `PATCH /api/recordings/{object_id}/protect` → `{protected:bool}` →
  `PATCH {episode_path} {"protected":…}` (resolve episode path from object_id or
  accept the path).
- `GET  /api/recordings/upcoming` → `GET /guide/airings?state=requested&lh`.
- `GET  /api/recordings/conflicts` → `GET /guide/airings?state=conflicted&lh`.
- Existing, reused: `DELETE /recordings/{id}`, `POST /recordings/{id}/watched`.

Every route auth-gated (`_require_auth`), device refusals surfaced with the
`_device_error` pattern.

## Frontend

- `RecordingsView.tsx` — segmented Series/Upcoming/Conflicts + the three grids.
- `SeriesDetail.tsx` (or a section within) — settings controls + episode list +
  bulk bar. Reuse the `Switch`/`Segmented` primitives from `SettingsModal.tsx`
  (consider promoting them to a shared `ui/` module).
- `api.recordings.*` — `series()`, `seriesDetail(path)`, `updateSeries(...)`,
  `bulkDelete(path,filter)`, `setProtected(id,bool)`, `upcoming()`,
  `conflicts()`.
- Optimistic writes with revert-on-error; resync from the device echo.

## Testing

- **Backend:** index merge/join; settings PATCH maps rule/keep/offsets to the
  correct nested device bodies and rejects unknown keys; bulk-delete filter
  allow-list; protect forwards; 999-retry; upcoming/conflicts pass through;
  auth gates. Device stubbed (`monkeypatch` `request_device`/`patch_device`/
  `_request_device_raw`), same as `test_settings.py`.
- **Frontend:** series grid renders from a mocked index; opening a card shows
  detail; rule/keep/padding controls fire the right `updateSeries` payloads;
  multi-select + delete-watched + delete-all call the right endpoints; protect
  toggle; upcoming/conflicts render and hide-when-empty; segmented switch.

## Open items / decisions

1. **Delete a protected episode — RESOLVED:** a **single delete works
   regardless of protect** (`DELETE /recordings/{id}` on the episode). Only the
   series-wide **"delete all" (`filter:"unprotected"`) skips protected** episodes.
   So no "unprotect first" step for single deletes; the per-episode Delete acts
   on protected episodes too. (Delete-watched likewise leaves protected ones
   only if they're also watched-and-protected — the device's filter decides.)
2. **Upcoming/Conflicts placement:** segmented switch (this spec) vs stacked
   sections. (Lean: segmented — still open.)
3. **Series with no guide identifier — LIKELY MOOT:** the series object
   (`GET {recordings_path}`) carries a **`guide_path`** (seen on the College
   Football series), which is the settings PATCH target, so settings are
   available even for a recorded series with no active rule. If a series ever
   lacks `guide_path`, show its card for **episode cleanup only** and disable the
   settings section. Series cards are per-**series**, not per-episode.
4. **Episode kind paths:** one resolver for `series|sports|movies` +
   `episodes|events` (sports use `/events`, series/movies `/episodes`).
5. `docs/tablo-api.md` gets all the above verbs appended during the build.
