# Recordings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new top-level **Recordings** tab — the DVR management home: the series I record and their rules/keep/padding, episode cleanup, and a read-only view of what's upcoming and what conflicts.

**Architecture:** New backend router `series.py` (mounted before `recordings.router`, same `/api/recordings` prefix, so its literal `/series`, `/upcoming`, `/conflicts` paths win over the int `{object_id}` routes). It composes device reads (`/guide/shows?state=requested&lh` full objects + `/recordings/shows` paths) and writes settings via the nested `/guide/{identifier}` shapes. Frontend: `RecordingsView.tsx` (segmented Series/Upcoming/Conflicts) + `SeriesDetail.tsx`, reusing `Switch`/`Segmented` promoted to `components/ui/controls.tsx`. Episode-level protect/watched/delete already exist and are reused.

**Tech Stack:** FastAPI + httpx (signed device helpers in `state.py`), React + React Query + Tailwind, vitest + pytest.

**Spec:** `docs/superpowers/specs/2026-09-20-recordings-page-design.md`

## Global Constraints

- All implementation in a **git worktree**, never on `main` (project memory). Reset worktree onto local `main`; symlink `frontend/node_modules`.
- Device signs the **bare path** (query stripped) — already handled by `state.request_device`/`patch_device`. `&lh` is **required** on `/guide/shows` and `/guide/airings` (400 without).
- All writes to `/guide/{identifier}` are **nested**; offsets in **seconds**. Single **retry on transient 999** for `/guide/{identifier}` writes.
- `{kind}` ∈ `series | sports | movies` from `recordings_path`; episode segment `episodes` (series/movies) or `events` (sports).
- Every new route auth-gated (`_require_auth`); device refusals via `_device_error(status, data)`.
- Never log the account postal code or commit raw HARs.
- Duration for progress/percent = `video_details.duration`, never `airing_details.duration`.
- TDD: failing test first, minimal impl, green, commit. Match surrounding code's comment density/idiom.
- Deploy via `tablo-stack` skill (`check-stack.sh` exit 0 + bundle-hash change). Backend change ⇒ restart `run-native.sh`.

## Confirmed device shapes (probed live 2026-09-20, fw 2.2.58)

- `GET /guide/shows?state=requested&lh` → list of **objects**: `{identifier, schedule{rule, channel_identifier, offsets{start,end,source}}, keep{rule,count}, recordings_path|null}`.
- `GET /recordings/shows` → list of **path strings** (`/recordings/series/92895`, `/recordings/sports/86664`).
- `GET /recordings/{kind}/{id}` → `{object_id, path, series{title,genres,description,orig_air_date,episode_runtime,cast,cover_image{image_id},background_image{image_id},thumbnail_image{image_id}}, show_counts{airing_count,unwatched_count,protected_count,watched_and_protected_count,failed_count}, user_info{up_next}, keep{rule,count}, guide_path}`. (No `schedule`/rule/offsets here — those come from the guide/shows projection joined on `recordings_path`.)
- `GET /recordings/{kind}/{id}/episodes` → episode path strings (`/recordings/series/episodes/92894`).
- `GET /recordings/{kind}/episodes|events/{eid}` → `{object_id, airing_details{datetime,duration,...}, episode{title,number,season_number,orig_air_date}, video_details{size,state,duration,...}, snapshot_image, user_info{position,watched,protected}}`.
- `POST /batch` body=`["/path", …]` → `{path: object}` (used to resolve episode paths in bulk).
- `GET /guide/airings?state=requested&lh` / `?state=conflicted&lh` → list of `{identifier, schedule{state,qualifier,skip_reason,skip_detail,offsets}}`. **Identifier is a lineup handle** `LH-C{content}-S{station}_{maj}_{min}-T{epoch}` — encodes datetime (epoch after `-T`) + channel major.minor, **no title**, NOT resolvable via `/batch`. v1 renders parsed handles; titles are a documented follow-up.
- Writes: `PATCH /guide/{identifier} {"schedule":{"rule":…}}` | `{"keep":{"rule":…,"count":…}}` | `{"schedule":{"offsets":{"source":"show","start":<s>,"end":<s>}}}`. Bulk delete `POST {recordings_path}/delete {"filter":"watched"|"unprotected"}`. Protect `PATCH {episode_path} {"protected":bool}` (already built). Watched `POST /recordings/{id}/watched` (already built). Delete one `DELETE /recordings/{id}` (already built).

---

## Task 1: `series.py` router + passthrough reads (upcoming, conflicts)

**Files:**
- Create: `backend/app/routes/series.py`
- Modify: `backend/app/main.py` (include `series.router` **before** `recordings.router`)
- Test: `backend/tests/test_series.py`

**Interfaces:**
- Produces: `router = APIRouter(prefix="/api/recordings", tags=["series"])`; helpers `_require_auth()`, `_device_error(status, data)` (copy the settings.py pattern); route `GET /upcoming`, `GET /conflicts`.

- [ ] **Step 1: Failing test** — `test_upcoming_and_conflicts_pass_through` and `test_series_reads_require_auth` in `test_series.py`. Stub `app_state.request_device` to return a canned list for `/guide/airings?state=requested&lh`; assert `GET /api/recordings/upcoming` returns it and that the signed path carried `state=requested&lh`. Auth test: with auth off, each of `/api/recordings/upcoming`, `/conflicts`, `/series` → 401/403 (per existing `_require_auth`).

```python
def test_upcoming_passes_through(authed, monkeypatch):
    async def fake(method, path, body=""):
        assert path == "/guide/airings?state=requested&lh"
        return [{"identifier": "LH-x-S1_008_06-T1789923600",
                 "schedule": {"state": "scheduled", "skip_reason": "none"}}]
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/recordings/upcoming")
    assert r.status_code == 200
    assert r.json()[0]["identifier"].startswith("LH-")
```

- [ ] **Step 2: Run — FAIL** (`pytest backend/tests/test_series.py -q`), route missing.
- [ ] **Step 3: Implement** — router with `_require_auth`, `_device_error`; `GET /upcoming` → `request_device("GET", "/guide/airings?state=requested&lh")`; `GET /conflicts` → `…?state=conflicted&lh`. Register in main.py before recordings.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(series): recordings-series router with upcoming/conflicts passthrough`.

## Task 2: `GET /api/recordings/series` — composed index

**Files:** Modify `backend/app/routes/series.py`; Test `backend/tests/test_series.py`.

**Interfaces:**
- Produces `GET /series` → `{series: [ {recordings_path, identifier|null, kind|null, title, art_url|null, rule, keep:{rule,count}, offsets:{start,end,source}, episode_count, unwatched_count, protected_count, conflict:false} ]}`.
- Consumes: `state.request_device`. Reuse art via existing `_with_art`/cover helpers in recordings.py **only if trivial**; otherwise build `art_url` from `series.cover_image.image_id` as `/api/recordings/<oid>/art`-style is per-recording — instead expose the device image id and let the FE request the series cover through the existing image proxy. **Decision:** include `cover_image_id` and resolve on FE via the existing channel/image proxy path used elsewhere; if none exists for series covers, set `art_url=null` in v1 (cards fall back to a title tile).

**Merge algorithm:**
1. `guide = request_device("GET","/guide/shows?state=requested&lh")` → objects.
2. `rec_paths = request_device("GET","/recordings/shows")` → path strings.
3. Index guide by `recordings_path` (skip null). Start the result from the **union** of recorded series (fetch each `GET {path}` meta, bounded by a semaphore of ~8, tolerant per-series: a failed fetch is skipped) and ruled-but-unrecorded guide entries (recordings_path null → still list, kind/title from a light `GET {identifier}`? identifier is a guide handle, not fetchable; **v1: list only ruled series that also have recordings_path or are in /recordings/shows** — a rule with no recordings and no resolvable title is dropped, noted as a follow-up).
4. For each recorded series: `kind` = 2nd path segment; `title/genres/cover_image` from meta.series; counts from `show_counts`; `keep` from meta.keep; `rule/offsets/identifier` from the joined guide entry (by recordings_path) else `rule="none"`, `offsets` defaults, `identifier` from meta.`guide_path` transformed? **guide_path** (`/guide/series/2915`) is NOT the PATCH identifier (`C..._SHOW_...`). So settings need the guide-shows `identifier`; a recorded series absent from `state=requested` has rule none and **no identifier** → settings disabled for it (spec open item 3). Set `identifier` only from the join.

- [ ] **Step 1: Failing test** `test_series_index_merges_rule_and_counts`: stub `request_device` to dispatch by path — `/guide/shows?state=requested&lh` → one object with `recordings_path="/recordings/series/1"`, rule "all", keep count 5; `/recordings/shows` → `["/recordings/series/1","/recordings/sports/2"]`; `/recordings/series/1` → meta with title "A", show_counts unwatched 3, keep {none}; `/recordings/sports/2` → meta title "B", no matching guide entry. Assert result has 2 items; item for path 1 has `rule=="all"`, `keep.count==5` (guide join wins over meta for rule; keep from guide entry), `unwatched_count==3`, `kind=="series"`, `identifier` set; item for path 2 has `rule=="none"`, `identifier is None`, `kind=="sports"`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** merge with bounded gather + per-series try/except.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(series): composed /series index (guide rules ⋈ recorded shows)`.

## Task 3: `GET /api/recordings/series/detail` — meta + settings + episodes

**Files:** Modify `series.py`; Test `test_series.py`.

**Interfaces:** `GET /series/detail?recordings_path=…` → `{meta:{title,genres,description,cover_image_id,kind}, settings:{identifier|null, rule, keep:{rule,count}, offsets:{start,end,source}}, counts:{...show_counts}, episodes:[ {object_id, title, season_number, episode_number, orig_air_date, datetime, duration (video_details.duration), size, state, snapshot_image, position, watched, protected, is_recording} ]}`.

**Algorithm:** validate `recordings_path` matches `^/recordings/(series|sports|movies)/\d+$` (400 otherwise — never forward arbitrary paths to the device). `meta = GET {recordings_path}`. `ep_paths = GET {recordings_path}/episodes`. Resolve episodes with `POST /batch` (body = ep_paths) → map; build each row (duration from `video_details.duration`; `is_recording` = `video_details.state=="recording"`). Settings: `guide = GET /guide/shows?state=requested&lh`; find entry by recordings_path for identifier/rule/offsets; keep from meta.keep; if no entry, identifier None + rule "none".

- [ ] **Step 1: Failing test** `test_series_detail_composes_episodes_and_settings`: stub reads; assert one episode row uses `video_details.duration` (not airing slot), carries `protected`/`watched`/`position`, and settings.identifier + rule come from the guide join. Add `test_series_detail_rejects_foreign_path` (recordings_path `/server/info` → 400).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** (path allow-list regex; batch resolve; tolerant).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(series): series detail (meta + settings + episode list)`.

## Task 4: `PATCH /api/recordings/series/settings` — rule / keep / padding

**Files:** Modify `series.py`; Test `test_series.py`.

**Interfaces:** body `{identifier: str, rule?: "all"|"new"|"none", keep?: {rule:"all"|"none"|"count", count?:int}, offsets?: {start:int, end:int}}`. Pydantic model; reject unknown top-level keys (`model_config = ConfigDict(extra="forbid")`) and validate enums. Maps to nested device bodies and issues one `PATCH /guide/{identifier}` per provided facet (rule/offsets both live under `schedule`; combine into a single `schedule` object when both present). Offsets → `{"schedule":{"offsets":{"source":"show" if (start or end) else "none","start":start,"end":end}}}`. Single **retry on 999**. Returns the device echo(es).

- [ ] **Step 1: Failing tests** — `test_settings_rule_maps_to_schedule_rule` (rule "new" → `PATCH /guide/{id}` body `{"schedule":{"rule":"new"}}`), `test_settings_keep_count` (→ `{"keep":{"rule":"count","count":5}}`), `test_settings_padding_seconds` (`{start:-300,end:1800}` → `{"schedule":{"offsets":{"source":"show","start":-300,"end":1800}}}`), `test_settings_rejects_unknown_key` (422), `test_settings_retries_once_on_999` (first `patch_device` returns `(999,{})`, second `(200,{...})`; assert 2 calls, 200 result). Stub `app_state.patch_device` capturing `(path,payload)`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** (allow-list model; nested mapping; 999 retry helper).
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(series): allow-listed series settings PATCH (rule/keep/padding, 999 retry)`.

## Task 5: `POST /api/recordings/series/bulk-delete`

**Files:** Modify `series.py`; Test `test_series.py`.

**Interfaces:** body `{recordings_path: str, filter: "watched"|"unprotected"}` (extra="forbid", filter enum). Validate recordings_path against the same regex. Forward `POST {recordings_path}/delete {"filter":…}` via `_request_device_raw` (may be 200/204). Auth-gated; device refusal surfaced.

- [ ] **Step 1: Failing tests** `test_bulk_delete_forwards_filter` (asserts device call `POST /recordings/series/1/delete` body `{"filter":"watched"}`), `test_bulk_delete_rejects_bad_filter` (422), `test_bulk_delete_rejects_foreign_path` (400).
- [ ] **Step 2: FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(series): series bulk-delete (watched | unprotected)`.

## Task 6: append device verbs to `docs/tablo-api.md`

**Files:** Modify `docs/tablo-api.md`.

- [ ] **Step 1** Append the series/upcoming/conflicts/batch verbs + the lineup-handle note (no test; doc task folded into the backend deliverable). Commit `docs(tablo-api): series rules/keep/padding, batch, airings state filters`.

## Task 7: promote `Switch`/`Segmented` to `components/ui/controls.tsx`

**Files:** Create `frontend/src/components/ui/controls.tsx`; Modify `frontend/src/components/SettingsModal.tsx` (import from ui, delete local copies); Test: existing `SettingsModal` tests must stay green (no new test — pure refactor).

- [ ] **Step 1** Move both components verbatim into `controls.tsx` with `export`. Import in SettingsModal.
- [ ] **Step 2** `npx tsc -b` + `npx vitest run src/__tests__` (settings tests) → green.
- [ ] **Step 3: Commit** `refactor(ui): promote Switch/Segmented to components/ui/controls`.

## Task 8: `api.series.*` + types in `tablo.ts`

**Files:** Modify `frontend/src/api/tablo.ts`; Test `frontend/src/__tests__/` (a small `api` shape test is optional — covered by view tests).

**Interfaces (produces):**
```ts
export interface SeriesCard { recordings_path: string; identifier: string | null; kind: string | null;
  title: string; cover_image_id: number | null; rule: "all"|"new"|"none";
  keep: { rule: string; count: number | null }; offsets: { start: number; end: number; source: string };
  episode_count: number; unwatched_count: number; protected_count: number; }
export interface SeriesEpisode { object_id: number; title: string | null; season_number: number | null;
  episode_number: number | null; orig_air_date: string | null; datetime: string | null;
  duration: number; size: number | null; state: string | null; snapshot_image: number | null;
  position: number; watched: boolean; protected: boolean; is_recording: boolean; }
export interface SeriesDetail { meta: {...}; settings: { identifier: string|null; rule: "all"|"new"|"none";
  keep:{rule:string;count:number|null}; offsets:{start:number;end:number;source:string} };
  counts: Record<string, number>; episodes: SeriesEpisode[]; }
export interface UpcomingAiring { identifier: string; schedule: { state: string; qualifier: string;
  skip_reason: string; skip_detail: string | null; offsets: {start:number;end:number;source:string} }; }
```
`api.series = { index(), detail(path), update(body), bulkDelete(path,filter), upcoming(), conflicts() }` using the existing `req` helper + `detailToMessage` on errors. (Episode protect/watched/delete reuse the existing top-level `api.setProtected`, `api.setRecordingWatched`, `api.deleteRecording`.)

- [ ] **Step 1** Add types + `api.series` block.
- [ ] **Step 2** `npx tsc -b` green.
- [ ] **Step 3: Commit** `feat(api): series management client (index/detail/update/bulk-delete/upcoming/conflicts)`.

## Task 9: add the **Recordings** tab (route + nav + body)

**Files:** Modify `frontend/src/lib/route.ts` (add `"recordings"` to `Tab` + `TABS`); Modify `frontend/src/components/ChannelGrid.tsx` (nav button after Library; body `activeTab === "recordings"` renders `<RecordingsView/>`); Create stub `frontend/src/components/RecordingsView.tsx` (returns a heading for now); Test `frontend/src/__tests__/route.test.ts` (if present) — `parseRoute("#/recordings")` → tab "recordings"; round-trips via `writeRoute`.

- [ ] **Step 1: Failing test** for route parse/serialize of `recordings` (extend existing route test file; if none, add `route.test.ts`).
- [ ] **Step 2: FAIL → Step 3: Implement** Tab type + nav pill (mirror the Library button) + body branch + stub view.
- [ ] **Step 4: PASS** + `tsc -b`.
- [ ] **Step 5: Commit** `feat(recordings): Recordings tab (route + nav + stub view)`.

## Task 10: `RecordingsView.tsx` — segmented switch + Series grid + Conflicts banner + Upcoming list

**Files:** Modify `RecordingsView.tsx`; Test `frontend/src/__tests__/recordings-page.test.tsx`.

**Behaviour:**
- `Segmented` value Series | Upcoming | Conflicts (Conflicts option hidden when `conflicts().length === 0`). React Query for `api.series.index/upcoming/conflicts`.
- **Conflicts banner**: when non-empty, an alert above the grid ("N scheduled recordings conflict") regardless of segment.
- **Series grid**: card per `SeriesCard` — cover (via image proxy or fallback title tile), title, badge row: rule (All/New/None) · keep (All/N/None) · `episode_count` · `unwatched_count` (accent when >0). Click → open `SeriesDetail` (Task 11) via state.
- **Upcoming**: parse each `UpcomingAiring.identifier` → `{epoch, major, minor}` (`-T(\d+)` → date; `S\d+_(\d+)_(\d+)` → maj/min). Group by local day; row = time + `maj.minor` + skip badge when `skip_reason!=="none"`. Documented v1 limitation: no title. Read-only.

- [ ] **Step 1: Failing tests** — `renders series cards from a mocked index` (asserts title + rule/keep/unwatched badges), `hides the Conflicts segment when there are none`, `shows a conflicts banner when conflicts exist`, `groups upcoming airings by day and shows time+channel`. Mock `api.series.*` with `vi.spyOn`.
- [ ] **Step 2: FAIL → Step 3: Implement.**
- [ ] **Step 4: PASS** + `tsc -b`.
- [ ] **Step 5: Commit** `feat(recordings): Series grid, Upcoming list, Conflicts banner`.

## Task 11: `SeriesDetail.tsx` — settings + episode list + bulk bar

**Files:** Create `frontend/src/components/SeriesDetail.tsx`; wire open/close from `RecordingsView`; Test `recordings-page.test.tsx`.

**Behaviour:**
- Header: cover, title, genres, description (from `detail.meta`).
- **Recording rule**: `Segmented` All/New/None → `api.series.update({identifier, rule})`. Disabled with a hint when `settings.identifier === null`.
- **Keep**: `Segmented` All/None/Count + preset chips 1·3·5·10·20 + free int → `update({identifier, keep})`.
- **Padding**: start/end minute steppers (UI minutes, wire seconds; start early = negative) → `update({identifier, offsets:{start,end}})`.
- **Danger zone**: *Stop recording* = `update({identifier, rule:"none"})`; *Stop & delete everything* = confirm dialog (reuse `ConfirmDialog`) → `update({rule:"none"})` then `api.series.bulkDelete(path,"unprotected")`.
- **Episodes**: list rows — checkbox, title, S/E, aired date, duration (`video_details.duration`), size, watched pip, protected lock, in-progress indicator. Per-row: watched toggle (`api.setRecordingWatched` / unwatch → `api.setRecordingPosition(id,1)`), protect toggle (`api.setProtected`), delete (`api.deleteRecording`, confirm). Optimistic + invalidate `["series-detail", path]`.
- **Bulk bar**: appears with a selection — Delete selected (loop `deleteRecording`); always-available — Delete watched (`bulkDelete(path,"watched")`), Delete all (`bulkDelete(path,"unprotected")`, confirm). Invalidate detail + `["series"]` after.

- [ ] **Step 1: Failing tests** — `rule segment fires update with the right payload`, `keep count fires keep payload`, `padding stepper wires seconds (start early = negative)`, `delete-all confirms then calls bulkDelete unprotected`, `per-row protect toggle calls setProtected`, `un-watch writes position 1`, `multi-select delete loops deleteRecording`. Mock `api.series.*` + episode APIs.
- [ ] **Step 2: FAIL → Step 3: Implement.**
- [ ] **Step 4: PASS** + `tsc -b`.
- [ ] **Step 5: Commit** `feat(recordings): Series detail — settings, episode list, bulk actions`.

## Task 12: full-suite gate + deploy

- [ ] Backend `pytest -q` all green; Frontend `npx vitest run` all green; `npx tsc -b`; `npm run build`.
- [ ] eslint on new/changed files (no new warnings; the pre-existing `writeDevicePosition` warning stays).
- [ ] Merge `--no-ff` into main; remove worktree + branch.
- [ ] Deploy: `docker compose build frontend` + `up -d --force-recreate frontend`; restart `run-native.sh` (backend changed); `check-stack.sh` exit 0; bundle hash changed.
- [ ] Report; push when told.

## Self-review notes

- **Spec coverage:** Series (index/detail/settings/keep/padding/danger/episodes/bulk) ✓ Tasks 2–5,11. Upcoming ✓ Task 10 (title-less v1, documented). Conflicts ✓ Task 10 (banner + list; hidden at 0). Tab entry ✓ Task 9. Backend routes ✓ Tasks 1–5 (protect already exists — reused). Shared primitives ✓ Task 7. Duration rule enforced in Task 3/11. Watched/unwatch device rules reused from Library work.
- **Deviations from spec (intentional, documented):** (1) Upcoming/Conflicts rows are parsed lineup handles (time+channel+skip), no poster/title — the `?state=requested&lh` projection carries only the handle and it is not `/batch`-resolvable; titled upcoming is a fast-follow. (2) `api.series.*` namespace instead of overloading `api.recordings` (which is already a function). (3) A recorded series with no active rule (absent from `state=requested`) has `identifier=null` → settings section disabled (spec open item 3), episode cleanup still available.
- **Type consistency:** `recordings_path` string is the join key end-to-end; `identifier` (guide handle) is the settings PATCH target and may be null; `duration` always = `video_details.duration`.
