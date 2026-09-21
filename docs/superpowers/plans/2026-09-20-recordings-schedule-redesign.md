# Recordings Schedule Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ruled-but-unrecorded series appear on the Recordings page, and add a per-series **Schedule** view that marks every upcoming airing with its real record state (so a rule-skipped rerun is visible).

**Architecture:** One cached backend resolver (`resolve_ruled`) turns the minimal `requested&lh` rule set into full series records by matching `identifier` against the `/guide/shows` catalog. It feeds both the fixed `/series` union merge and a new flat `/series/schedule` feed. Frontend collapses the Recordings tabs to `Recordings · Schedule · Failures` and adds a `ScheduleGrid`.

**Tech Stack:** FastAPI + httpx (backend, signed device reads), React + React Query + Tailwind semantic tokens (frontend), pytest + vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-recordings-schedule-redesign.md`

## Global Constraints

- Worktree; TDD. Backend `ruff` clean + `pytest -q` green (run with main-checkout venv: `cd <worktree>/backend && PYTHONPATH=. /Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m pytest -q`). Frontend `tsc -b` + `vitest` + `npm run build` green; eslint no new errors on changed files.
- Device facts are in the spec — do not re-probe. `POST /batch` takes a JSON list of **paths** (`state.request_device("POST","/batch", json.dumps(paths))` → `{path: obj|null}`), rejects SHOW identifiers. Chunk 48.
- `requested&lh` objects: `recordings_path` present for recorded series, `None` for unrecorded; `guide_path` always `None`. Titles/covers/guide-paths only via the catalog.
- No PII in logs. Follow existing `series.py` idioms (`_try`, `_airing_row`, `_REC_PATH`/`_GUIDE_PATH` allow-lists, bounded `asyncio.Semaphore`).

---

## Task 1: Cached catalog index — `_ruled_catalog_index`

**Files:**
- Modify: `backend/app/routes/series.py` (add near `_show_of`, after `_DEFAULT_KEEP`)
- Test: `backend/tests/test_series_schedule.py` (create)

**Interfaces:**
- Produces: `async def _ruled_catalog_index(want_ids: set[str]) -> dict[str, dict]` — maps `identifier → resolved catalog object` for the wanted identifiers. In-process TTL cache (module-level) keyed on the active device sid; 5-min TTL. Early-exits catalog scan once all `want_ids` are found.
- Consumes: `state.request_device("GET","/guide/shows")`, `state.request_device("POST","/batch", json.dumps(chunk))`.

- [ ] **Step 1: Write failing test** (`test_series_schedule.py`)

```python
import json
import pytest
from app.routes import series as S

class FakeState:
    def __init__(self, responses, active_sid="sidA"):
        self.responses = responses      # {(method, path): value} ; "/batch" special-cased
        self.active_sid = active_sid
        self.is_authenticated = True
        self.calls = []
    async def request_device(self, method, path, body=""):
        self.calls.append((method, path, body))
        if path == "/batch":
            paths = json.loads(body)
            return {p: self.responses["objs"].get(p) for p in paths}
        return self.responses.get((method, path))

CATALOG = ["/guide/series/1", "/guide/series/2", "/guide/series/3"]
OBJS = {
    "/guide/series/1": {"identifier": "IDA", "series": {"title": "Alpha", "cover_image": {"image_id": 11}},
                         "recordings_path": None, "show_counts": {"scheduled_count": 2}},
    "/guide/series/2": {"identifier": "IDB", "series": {"title": "Beta", "cover_image": {"image_id": 22}},
                         "recordings_path": "/recordings/series/9", "show_counts": {}},
    "/guide/series/3": {"identifier": "IDC", "sport": {"title": "Gamma"}, "recordings_path": None},
}

@pytest.fixture(autouse=True)
def _clear_cache():
    S._RULED_CATALOG_CACHE.clear()
    yield
    S._RULED_CATALOG_CACHE.clear()

@pytest.mark.asyncio
async def test_catalog_index_maps_identifier_to_object(monkeypatch):
    fake = FakeState({("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)
    idx = await S._ruled_catalog_index({"IDA", "IDC"})
    assert idx["IDA"]["series"]["title"] == "Alpha"
    assert idx["IDC"]["sport"]["title"] == "Gamma"

@pytest.mark.asyncio
async def test_catalog_index_caches_within_ttl(monkeypatch):
    fake = FakeState({("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)
    await S._ruled_catalog_index({"IDA"})
    n = sum(1 for c in fake.calls if c[1] == "/guide/shows")
    await S._ruled_catalog_index({"IDA"})
    n2 = sum(1 for c in fake.calls if c[1] == "/guide/shows")
    assert n == 1 and n2 == 1  # second call served from cache
```

- [ ] **Step 2: Run to verify fail** — `pytest tests/test_series_schedule.py -q` → FAIL (`_ruled_catalog_index` / `_RULED_CATALOG_CACHE` missing).

- [ ] **Step 3: Implement** (in `series.py`)

```python
import time

# identifier->object index, cached per device sid. The /guide/shows catalog is
# ~884 shows and stable; resolving it on every Recordings load is wasteful.
_RULED_CATALOG_CACHE: dict[str, tuple[float, dict[str, dict]]] = {}
_RULED_CATALOG_TTL = 300.0  # seconds
_BATCH_CHUNK = 48


async def _ruled_catalog_index(want_ids: set[str]) -> dict[str, dict]:
    """Map each wanted rule `identifier` to its resolved catalog object.

    The `requested&lh` rule set carries no title/cover/guide_path, and `/batch`
    rejects SHOW identifiers, so the only join is `identifier` across the
    `/guide/shows` catalog. Cached per device sid (TTL) because the catalog is
    large and slow-changing; the scan early-exits once every wanted id is found.
    """
    if not want_ids:
        return {}
    sid = getattr(state, "active_sid", None) or "_"
    hit = _RULED_CATALOG_CACHE.get(sid)
    if hit and (time.monotonic() - hit[0]) < _RULED_CATALOG_TTL:
        if want_ids <= hit[1].keys():
            return {k: hit[1][k] for k in want_ids if k in hit[1]}
    paths = await _try("GET", "/guide/shows") or []
    index: dict[str, dict] = {}
    for i in range(0, len(paths), _BATCH_CHUNK):
        chunk = [p for p in paths[i:i + _BATCH_CHUNK] if isinstance(p, str)]
        if not chunk:
            continue
        resolved = await _try("POST", "/batch", json.dumps(chunk)) or {}
        for obj in resolved.values():
            if isinstance(obj, dict) and obj.get("identifier"):
                index[obj["identifier"]] = obj
        if want_ids <= index.keys():
            break
    _RULED_CATALOG_CACHE[sid] = (time.monotonic(), index)
    return {k: index[k] for k in want_ids if k in index}
```

- [ ] **Step 4: Run to verify pass** — `pytest tests/test_series_schedule.py -q` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(series): cached identifier->catalog index for ruled series"`

---

## Task 2: `resolve_ruled` — the shared series record

**Files:**
- Modify: `backend/app/routes/series.py`
- Test: `backend/tests/test_series_schedule.py`

**Interfaces:**
- Consumes: `_ruled_catalog_index` (Task 1), `state.request_device("GET","/guide/shows?state=requested&lh")`.
- Produces: `async def resolve_ruled() -> list[dict]` — one dict per ruled series with keys `identifier, guide_path, recordings_path, title, cover_image_id, kind, rule, keep, offsets, show_counts`. `guide_path` is the catalog `path`. Series whose identifier is unresolved are skipped (`logging.warning`, identifier only).

- [ ] **Step 1: Write failing test**

```python
RULED = [
    {"identifier": "IDA", "schedule": {"rule": "new", "offsets": {"start": 0, "end": 0, "source": "none"}},
     "keep": {"rule": "none", "count": None}, "recordings_path": None},
    {"identifier": "IDB", "schedule": {"rule": "all"}, "keep": {"rule": "count", "count": 3},
     "recordings_path": "/recordings/series/9"},
]

@pytest.mark.asyncio
async def test_resolve_ruled_joins_catalog(monkeypatch):
    fake = FakeState({("GET", "/guide/shows?state=requested&lh"): RULED,
                      ("GET", "/guide/shows"): CATALOG, "objs": OBJS})
    monkeypatch.setattr(S, "state", fake)
    out = {r["identifier"]: r for r in await S.resolve_ruled()}
    assert out["IDA"]["title"] == "Alpha"
    assert out["IDA"]["guide_path"] == "/guide/series/1"
    assert out["IDA"]["recordings_path"] is None
    assert out["IDA"]["rule"] == "new"
    assert out["IDB"]["recordings_path"] == "/recordings/series/9"
    assert out["IDB"]["keep"] == {"rule": "count", "count": 3}
```

- [ ] **Step 2: Run to verify fail** — FAIL (`resolve_ruled` missing).

- [ ] **Step 3: Implement**

```python
import logging

logger = logging.getLogger(__name__)


def _kind_of_guide(path: str) -> str | None:
    parts = path.split("/")
    return parts[2] if len(parts) > 2 else None


async def resolve_ruled() -> list[dict]:
    """Every series that has a recording rule, recorded or not.

    Joins the minimal `requested&lh` rule set (rule/keep/offsets/identifier,
    and recordings_path for the recorded ones) with the catalog index that
    supplies title/cover/guide_path/counts.
    """
    ruled = await _try("GET", "/guide/shows?state=requested&lh") or []
    want = {r["identifier"] for r in ruled if r.get("identifier")}
    index = await _ruled_catalog_index(want)
    out: list[dict] = []
    for r in ruled:
        ident = r.get("identifier")
        cat = index.get(ident) if ident else None
        if not cat:
            if ident:
                logger.warning("ruled series %s not found in catalog", ident)
            continue
        sched = r.get("schedule") or {}
        show = _show_of(cat)
        guide_path = cat.get("path")
        out.append({
            "identifier": ident,
            "guide_path": guide_path,
            "recordings_path": r.get("recordings_path") or cat.get("recordings_path"),
            "kind": _kind_of_guide(guide_path) if guide_path else None,
            "title": show.get("title") or "Untitled",
            "cover_image_id": _img(show.get("cover_image")),
            "rule": sched.get("rule") or "none",
            "keep": r.get("keep") or cat.get("keep") or dict(_DEFAULT_KEEP),
            "offsets": sched.get("offsets") or dict(_DEFAULT_OFFSETS),
            "show_counts": cat.get("show_counts") or {},
        })
    return out
```

Note: the catalog resolved object's own `path` is the guide series path — confirm `_batch` returns objects keyed with a `path` field (the probe showed `path` in the object keys). If a resolved object lacks `path`, fall back to the batch key: build the index in Task 1 as `{identifier: {**obj, "path": obj.get("path") or key}}`. **Adjust Task 1 to inject the key as `path` when absent** (do this now):

```python
        for key, obj in resolved.items():
            if isinstance(obj, dict) and obj.get("identifier"):
                obj.setdefault("path", key)
                index[obj["identifier"]] = obj
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(series): resolve_ruled joins rule set with catalog"`

---

## Task 3: `/series` union merge fix

**Files:**
- Modify: `backend/app/routes/series.py` (`_compose_series_index`)
- Test: `backend/tests/test_series_schedule.py`

**Interfaces:**
- Consumes: `resolve_ruled` (Task 2), `/recordings/shows`, per-path meta.
- Produces: `/api/recordings/series` cards now = ruled ∪ recorded. Ruled-unrecorded card: `recordings_path=None`, `episode_count=0`, `rule` set, plus new optional fields `guide_path` and `scheduled_count`.

- [ ] **Step 1: Write failing test**

```python
@pytest.mark.asyncio
async def test_series_union_includes_unrecorded_ruled(monkeypatch):
    resp = {
        ("GET", "/guide/shows?state=requested&lh"): RULED,
        ("GET", "/guide/shows"): CATALOG,
        ("GET", "/recordings/shows"): ["/recordings/series/9"],
        ("GET", "/recordings/series/9"): {
            "series": {"title": "Beta", "cover_image": {"image_id": 22}},
            "show_counts": {"airing_count": 5, "unwatched_count": 1,
                            "protected_count": 0, "failed_count": 0}},
        "objs": OBJS,
    }
    fake = FakeState(resp)
    monkeypatch.setattr(S, "state", fake)
    cards = {c["title"]: c for c in await S._compose_series_index()}
    # unrecorded ruled series now present:
    assert cards["Alpha"]["recordings_path"] is None
    assert cards["Alpha"]["rule"] == "new"
    assert cards["Alpha"]["episode_count"] == 0
    assert cards["Alpha"]["guide_path"] == "/guide/series/1"
    # recorded ruled series keeps disk data:
    assert cards["Beta"]["recordings_path"] == "/recordings/series/9"
    assert cards["Beta"]["episode_count"] == 5
```

- [ ] **Step 2: Run to verify fail** — FAIL (Alpha absent; no `guide_path` key).

- [ ] **Step 3: Implement** — rewrite `_compose_series_index`:

```python
async def _compose_series_index() -> list[dict]:
    """Every series worth a card: those with a rule (recorded or not) unioned
    with those that have recordings but no rule.

    `resolve_ruled()` supplies the ruled set with title/cover/guide_path even
    when nothing is on disk yet — the case the old recorded-paths-only loop
    dropped entirely. Recorded-but-unruled series are then added from
    `/recordings/shows`.
    """
    ruled = await resolve_ruled()
    ruled_by_recpath = {r["recordings_path"]: r for r in ruled if r.get("recordings_path")}
    rec_paths = await _try("GET", "/recordings/shows") or []
    sem = asyncio.Semaphore(8)

    async def counts_for(path: str) -> dict | None:
        async with sem:
            meta = await _try("GET", path)
        return meta

    # Enrich ruled cards that DO have recordings with real disk counts; build
    # unruled cards for the rest.
    ruled_meta = await asyncio.gather(
        *[counts_for(r["recordings_path"]) for r in ruled if r.get("recordings_path")]
    )
    meta_by_path = {
        r["recordings_path"]: m
        for r, m in zip([x for x in ruled if x.get("recordings_path")], ruled_meta)
    }

    cards: list[dict] = []
    for r in ruled:
        meta = meta_by_path.get(r.get("recordings_path")) or {}
        counts = meta.get("show_counts") or r.get("show_counts") or {}
        cards.append(_card(
            recordings_path=r.get("recordings_path"),
            identifier=r["identifier"],
            guide_path=r.get("guide_path"),
            kind=r.get("kind") or (_kind_of(r["recordings_path"]) if r.get("recordings_path") else None),
            title=r["title"],
            cover_image_id=r["cover_image_id"],
            rule=r["rule"], keep=r["keep"], offsets=r["offsets"],
            counts=counts,
        ))

    # Recorded-but-unruled: any recordings show not covered by a ruled recpath.
    async def unruled_card(path: str) -> dict | None:
        if path in ruled_by_recpath:
            return None
        async with sem:
            meta = await _try("GET", path)
        if not meta:
            return None
        show = _show_of(meta)
        return _card(
            recordings_path=path, identifier=None, guide_path=None,
            kind=_kind_of(path), title=show.get("title") or "Untitled",
            cover_image_id=_img(show.get("cover_image")),
            rule="none", keep=meta.get("keep") or dict(_DEFAULT_KEEP),
            offsets=dict(_DEFAULT_OFFSETS), counts=meta.get("show_counts") or {},
        )

    extra = await asyncio.gather(*[unruled_card(p) for p in rec_paths])
    cards.extend(c for c in extra if c)
    return cards


def _card(*, recordings_path, identifier, guide_path, kind, title,
          cover_image_id, rule, keep, offsets, counts) -> dict:
    return {
        "recordings_path": recordings_path,
        "identifier": identifier,
        "guide_path": guide_path,
        "kind": kind,
        "title": title,
        "cover_image_id": cover_image_id,
        "rule": rule,
        "keep": keep,
        "offsets": offsets,
        "episode_count": counts.get("airing_count", 0),
        "unwatched_count": counts.get("unwatched_count", 0),
        "protected_count": counts.get("protected_count", 0),
        "failed_count": counts.get("failed_count", 0),
        "scheduled_count": counts.get("scheduled_count", 0),
        "conflict": (counts.get("conflicted_count", 0) or 0) > 0,
    }
```

- [ ] **Step 4: Run to verify pass** — PASS. Also run the existing series tests: `pytest tests/ -q -k series` (fix any shape drift — the card keys are a superset of before).

- [ ] **Step 5: Commit** — `git commit -am "fix(series): show ruled-but-unrecorded series (union merge)"`

---

## Task 4: `GET /series/schedule` feed

**Files:**
- Modify: `backend/app/routes/series.py`
- Test: `backend/tests/test_series_schedule.py`

**Interfaces:**
- Consumes: `resolve_ruled`, `{guide_path}/episodes` + `/batch`, `_airing_row`.
- Produces: `GET /api/recordings/schedule` → `list[ScheduleRow]` sorted by `datetime`. `ScheduleRow = _airing_row(a) + {series_title, series_cover_image_id}`. A series whose `/episodes` fails is skipped.

- [ ] **Step 1: Write failing test**

```python
EPISODES_1 = ["/guide/series/1/episodes/100", "/guide/series/1/episodes/101"]
AIR_OBJS = {
    "/guide/series/1/episodes/100": {"object_id": 100, "episode": {"title": "E1"},
        "airing_details": {"datetime": "2026-09-22T00:00Z", "duration": 1800,
            "channel": {"channel": {"call_sign": "ABC", "major": 7, "minor": 1}}},
        "schedule": {"state": "scheduled", "skip_reason": "none"}},
    "/guide/series/1/episodes/101": {"object_id": 101, "episode": {"title": "E2"},
        "airing_details": {"datetime": "2026-09-21T22:00Z", "duration": 1800,
            "channel": {"channel": {"call_sign": "ABC", "major": 7, "minor": 1}}},
        "schedule": {"state": "skipped", "skip_reason": "not_new"}},
}

@pytest.mark.asyncio
async def test_schedule_flat_sorted_with_states(monkeypatch):
    resp = {
        ("GET", "/guide/shows?state=requested&lh"): [RULED[0]],  # IDA only -> Alpha /guide/series/1
        ("GET", "/guide/shows"): CATALOG,
        ("GET", "/guide/series/1/episodes"): EPISODES_1,
        "objs": {**OBJS, **AIR_OBJS},
    }
    fake = FakeState(resp)
    monkeypatch.setattr(S, "state", fake)
    rows = await S._compose_schedule()
    assert [r["state"] for r in rows] == ["skipped", "scheduled"]   # time-sorted
    assert rows[0]["skip_reason"] == "not_new"
    assert rows[0]["series_title"] == "Alpha"
    assert rows[0]["channel"] == "ABC"
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement**

```python
async def _compose_schedule() -> list[dict]:
    ruled = await resolve_ruled()
    sem = asyncio.Semaphore(6)

    async def rows_for(r: dict) -> list[dict]:
        gp = r.get("guide_path")
        if not gp:
            return []
        async with sem:
            paths = await _try("GET", f"{gp}/episodes") or []
            resolved = (await _try("POST", "/batch", json.dumps(paths[:300]))
                        if paths else {}) or {}
        out = []
        for a in resolved.values():
            if not isinstance(a, dict):
                continue
            row = _airing_row(a)
            row["series_title"] = r["title"]
            row["series_cover_image_id"] = r["cover_image_id"]
            out.append(row)
        return out

    nested = await asyncio.gather(*[rows_for(r) for r in ruled])
    rows = [row for group in nested for row in group]
    rows.sort(key=lambda x: x.get("datetime") or "")
    return rows


@router.get("/schedule")
async def schedule():
    """Every upcoming airing of every series I record, titled and state-marked.

    Scoped to ruled series (not the whole lineup): each row carries its real
    `schedule.state` — `scheduled`, `skipped` (with `skip_reason`), `conflicted`,
    `recording` — so a rerun a "new" rule drops is visible, not hidden.
    """
    _require_auth()
    return await _compose_schedule()
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(series): /schedule feed of state-marked upcoming airings"`

---

## Task 5: `series_airings` all-states + `series_detail` guide fallback

**Files:**
- Modify: `backend/app/routes/series.py`
- Test: `backend/tests/test_series_schedule.py`

**Interfaces:**
- `series_airings`: `state` param accepts `"requested" | "conflicted" | "all"`; `"all"` returns every airing (no state filter).
- `series_detail`: accepts EITHER `recordings_path` OR `guide_path`. With only `guide_path`, returns meta+settings from the ruled/catalog data and `episodes: []` (nothing on disk).

- [ ] **Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_series_airings_all_returns_every_state(monkeypatch):
    resp = {("GET", "/guide/series/1/episodes"): EPISODES_1, "objs": AIR_OBJS}
    fake = FakeState(resp)
    monkeypatch.setattr(S, "state", fake)
    rows = await S.series_airings(guide_path="/guide/series/1", airing_state="all")
    assert {r["state"] for r in rows} == {"scheduled", "skipped"}

@pytest.mark.asyncio
async def test_series_detail_by_guide_path_no_recordings(monkeypatch):
    resp = {("GET", "/guide/shows?state=requested&lh"): RULED,
            ("GET", "/guide/shows"): CATALOG, "objs": OBJS}
    fake = FakeState(resp)
    monkeypatch.setattr(S, "state", fake)
    d = await S.series_detail(recordings_path=None, guide_path="/guide/series/1")
    assert d["meta"]["title"] == "Alpha"
    assert d["settings"]["rule"] == "new"
    assert d["episodes"] == []
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement**
  - `series_airings`: change the `Literal` to include `"all"`; when `airing_state == "all"`, keep all rows (skip the `state == want` filter). Keep `_airing_row` output.
  - `series_detail`: make `recordings_path` Optional; add `guide_path: str | None = Query(None)`. Require exactly one. When `guide_path` only: validate with `_GUIDE_PATH`; look the series up via `resolve_ruled()` (match on `guide_path`) for settings+meta; `episodes=[]`; `counts` from its `show_counts`. Keep the existing recordings_path branch unchanged (incl. the 404 handling).

- [ ] **Step 4: Run to verify pass** — PASS + existing airings/detail tests still green.

- [ ] **Step 5: Commit** — `git commit -am "feat(series): all-state airings + guide-path detail fallback"`

---

## Task 6: `ruff` + backend gate

- [ ] **Step 1:** `cd backend && PYTHONPATH=. /Users/peet/GitHub/tablo-web/backend/.venv/bin/python -m ruff check app/routes/series.py` → 0 errors (fix imports order: `logging`, `time` added).
- [ ] **Step 2:** Full backend suite green: `PYTHONPATH=. …/.venv/bin/python -m pytest -q`.
- [ ] **Step 3: Commit** any lint fixes — `git commit -am "chore: ruff clean"`

---

## Task 7: Frontend API types + client funcs

**Files:**
- Modify: `frontend/src/api/tablo.ts`
- Test: `frontend/src/__tests__/scheduleApi.test.ts` (create) — a light type/shape test is optional; the real coverage is in Task 8/9 component tests.

**Interfaces:**
- `SeriesCard`: `recordings_path: string | null`; add `guide_path: string | null`; add `scheduled_count: number`.
- New `ScheduleRow` type = `SeriesAiring & { series_title: string; series_cover_image_id: number | null }`.
- `api.series.schedule: () => req<ScheduleRow[]>("/recordings/schedule")`.
- `api.series.airings(guidePath, state)` — widen `state` to `"requested" | "conflicted" | "all"`.
- `api.series.detail` — add optional guide-path form: `detailByGuide: (guidePath) => req<SeriesDetail>(...guide_path=...)`.

- [ ] **Step 1:** Edit types + funcs as above.
- [ ] **Step 2:** `tsc -b` from `frontend/` → expect errors in `RecordingsView.tsx`/`SeriesDetail.tsx`/`SeriesGridCard` where `recordings_path` is now nullable — these are fixed in Tasks 8–9. Commit types alone once `tablo.ts` itself typechecks in isolation (or bundle with Task 8).
- [ ] **Step 3: Commit** — `git commit -am "feat(api): schedule feed + nullable recordings_path types"`

---

## Task 8: RecordingsView → 3 tabs + ScheduleGrid

**Files:**
- Modify: `frontend/src/components/RecordingsView.tsx`
- Create: `frontend/src/components/ScheduleGrid.tsx`
- Test: `frontend/src/__tests__/scheduleGrid.test.tsx` (create); update `recordings.test.tsx` / `recordings-page.test.tsx` for the 3-tab set.

**Interfaces:**
- Consumes: `api.series.schedule`, `ScheduleRow`.
- Produces: `ScheduleGrid` — rows grouped by day, state markers, on/off toggle chips `[Scheduled] [Airing] [Conflict]` (Recording always shown). Empty state "Nothing scheduled."

- [ ] **Step 1: Write failing test** (`scheduleGrid.test.tsx`) — render with two rows (one `scheduled`, one `skipped/not_new`); assert both visible with correct labels; toggle "Airing" off → the skipped row hidden; empty data → "Nothing scheduled."
- [ ] **Step 2: Run** → FAIL (component missing).
- [ ] **Step 3: Implement**
  - `ScheduleGrid.tsx`: `useQuery(["schedule"], api.series.schedule)`. Group rows by local day (`toDateString`), header per day. Row: time (`format` lib), series_title, episode title, channel, and a state pill via a `stateMarker(row)` helper. `skip_reason` label map: `not_new→"Rerun"`, `manual→"Skipped"`, default `"Won't record"`. Toggle chips control a `Set<state-group>` in component state; `scheduled`→Scheduled, `skipped`→Airing, `conflicted`→Conflict, `recording` always shown. Contained scroll: `flex-1 min-h-0 overflow-y-auto` matching existing lists. Use semantic tokens: Scheduled `text-accent-strong bg-accent-soft`, Airing `text-fg-muted bg-fill`, Conflict `text-danger bg-danger-soft`, Recording `text-success bg-success-soft`.
  - `RecordingsView.tsx`: `Segment = "recordings" | "schedule" | "failures"`; `TABS` = those three; remove `scheduled`/`upcoming`/`conflicts` segments, their queries (`upcoming`, `conflicts`) and `AiringList` usage for the page (keep `AiringList` only if still used elsewhere; otherwise remove). Keep the conflicts banner but source the count from schedule rows with `state==="conflicted"` (or drop the banner — see note). Render `ScheduleGrid` for `schedule`.
  - **Conflicts banner:** keep it — compute `conflictCount` from `api.series.schedule` rows (`state==="conflicted"`); clicking it switches to Schedule with the Conflict toggle forced on. If wiring the forced-toggle is fiddly, the banner simply switches to the Schedule tab.
- [ ] **Step 4: Run** → PASS. Update `recordings*.test.tsx` expectations (3 tabs).
- [ ] **Step 5: Commit** — `git commit -am "feat(recordings): Schedule tab with state-marked airing grid"`

---

## Task 9: SeriesGridCard null path + drawer all-state Upcoming

**Files:**
- Modify: `frontend/src/components/RecordingsView.tsx` (`SeriesGridCard`, `SeriesGrid` key)
- Modify: `frontend/src/components/SeriesDetail.tsx`
- Test: update `recordings.test.tsx`; add a case to a SeriesDetail test if one exists.

**Interfaces:**
- `SeriesGridCard`: tolerate `recordings_path === null` — show a "Scheduled" status chip + "0 recorded", hide delete/clear-cover actions. `SeriesGrid` key becomes `s.identifier ?? s.recordings_path`.
- Drawer opens ruled-unrecorded cards via `guide_path` (`api.series.detailByGuide`).
- Drawer **Upcoming** tab uses `api.series.airings(guidePath, "all")` so skipped airings show; each row gets a state marker (reuse the `stateMarker` from ScheduleGrid or a shared helper). **Conflicts** drawer tab stays `"conflicted"`.

- [ ] **Step 1: Write failing test** — a `SeriesCard` with `recordings_path: null, rule: "new"` renders the Scheduled chip and no "Delete" control.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**
  - `SeriesGridCard`: branch on `s.recordings_path`. Null → status chip `Scheduled` (squarish, matching the "status not action" rule from prior work), episode line shows `0 recorded` / `{scheduled_count} scheduled`. Guard the image clear/delete affordances behind `s.recordings_path`.
  - `SeriesDetail`: accept a card with null `recordings_path`; fetch detail via `detailByGuide(card.guide_path)` when path is null, else `detail(path)`. Bulk-delete / danger-zone hidden when no recordings_path. Upcoming query → `"all"`; render markers. Extract `stateMarker`/`skipLabel` into `frontend/src/lib/scheduleState.ts` (shared by ScheduleGrid + AiringsPane) to keep DRY.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(recordings): ruled-unrecorded cards + all-state drawer upcoming"`

---

## Task 10: Frontend gate

- [ ] `cd frontend && npx tsc -b` → clean.
- [ ] `npx vitest run` → green (all suites).
- [ ] `npx eslint src/components/ScheduleGrid.tsx src/components/RecordingsView.tsx src/components/SeriesDetail.tsx src/lib/scheduleState.ts src/api/tablo.ts` → no new errors.
- [ ] `npm run build` → succeeds.
- [ ] Commit any fixes.

---

## Task 11: Merge, deploy, push

- [ ] Backend restart (native), then `check-stack.sh` green.
- [ ] `docker compose build frontend && docker compose up -d --force-recreate frontend`; `check-stack.sh` exit 0; bundle hash changed.
- [ ] Live smoke (Chrome ext or curl): `GET /api/recordings/series` includes Jeopardy!/First Civilizations; `GET /api/recordings/schedule` returns state-marked rows incl. a `skipped`/`not_new` Jeopardy! airing.
- [ ] `ExitWorktree keep` → from main: `git fetch origin -q && git merge --ff-only origin/main` → `git merge --no-ff <branch>` (watch the untracked-doc gotcha) → `git worktree remove --force` + `git branch -D`.
- [ ] `git push origin main`.
- [ ] Report bundle hash + verified behavior.

## Self-review notes
- Type consistency: `_card` is the single card shape; `SeriesCard` TS mirror gains `guide_path`, `scheduled_count`, nullable `recordings_path`. `stateMarker`/`skipLabel` live once in `lib/scheduleState.ts`.
- Spec coverage: merge fix (T3), schedule feed (T4), drawer all-states (T5/T9), tabs (T8), ruled-unrecorded cards (T9). All covered.
- YAGNI: no per-airing record/skip actions, no whole-lineup browse, no persisted toggles.
