# Recording Management (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the show sheet record or cancel one episode and set a series rule to All / New / None, writing through to the Tablo and to the guide mirror.

**Architecture:** The browser sends `(channel, start)` — `guide_airing`'s primary key, which the sheet already holds. A new FastAPI router resolves that to the device's `airing_path` / `series_path` from the mirror, `PATCH`es the device, and writes the response back to the mirror. Device paths never reach the browser. A series-rule write additionally kicks a bounded background refetch of that series' future airings, because one rule change flips `schedule.state` on all of them.

**Tech Stack:** Python 3 / FastAPI / SQLite (backend, `pytest`), React 18 / TypeScript / Tailwind (frontend, `vitest` + Testing Library).

**Spec:** `docs/superpowers/specs/2026-09-16-recording-management-design.md`

## Global Constraints

- **`PATCH` only.** `POST` and `PUT` against the device's guide paths return `404 none_found`. Episode: `PATCH /guide/series/episodes/{id}` with `{"scheduled": <bool>}` (a string is rejected: `400 Invalid parameter value`). Series: `PATCH /guide/series/{id}` with `{"schedule": {"rule": "<rule>"}}` — nested; the top-level `schedule_rule` the GET returns is **not** writable.
- **The device signature covers the body and the bare path**, query string excluded. `TabloAuth.make_device_auth(method, path, body)` already handles this; the body string signed must be byte-identical to the body sent.
- **A PATCH response is the full updated record**, so a write doubles as a read. Never follow a write with a GET of the same object.
- **Device error contract:** `{"error": {"code", "description", "details"}}`. A 400 carries the reason; surface `description` rather than a generic message.
- **No device path may be returned to the browser.** A device path in client hands is a PATCH target in client hands.
- **Schema stays at version 4.** Every column this work needs already exists. Do not add a migration.
- **Every DB call from async code goes through `_run_sync`** (`app/state.py`) — `db.execute` is synchronous and `busy_timeout=5000` can hold the event loop for five seconds, which stalls HLS segments mid-stream.
- **Run the backend tests as** `cd backend && python -m pytest tests/ -q`; the frontend as `cd frontend && npm test`.

---

### Task 1: Confirm the `schedule.rule` enumeration against real hardware

Only `"new"` is proven. `"all"` and `"none"` are inferences from the Tablo app's UI. The UI follows the probe; the probe does not follow the UI.

**Files:**
- Create: `backend/tools/probe_schedule_rules.py`
- Modify: `docs/tablo-api.md` (the §Unknowns entry for `schedule.rule`)

**Interfaces:**
- Consumes: nothing.
- Produces: the confirmed value list used by `RULES` in Task 5 and by the segmented control in Task 7.

- [ ] **Step 1: Write the probe script**

Read-modify-restore, and it refuses any series that has something to lose.

```python
#!/usr/bin/env python3
"""Confirm which `schedule.rule` values the device accepts.

Two techniques from docs/tablo-api.md §"How to extend this safely":

  * Send a deliberately invalid value. A rejected write cannot change
    anything, and the 400 names the field it objected to.
  * Write a value, diff the whole object, then restore the original. A 200
    does not prove the absence of a side effect elsewhere, so verify by
    diffing rather than by reading the response.

Run against a live device with the backend's own credentials:

    cd backend && python tools/probe_schedule_rules.py
"""

import asyncio
import json
import sys

sys.path.insert(0, ".")

from app.state import state  # noqa: E402

CANDIDATES = ["all", "new", "none"]


async def main() -> int:
    state.load_config()
    if state.active_device is None:
        print("no active device - log in through the app first")
        return 1

    paths = await state.request_device("GET", "/guide/series")
    target = None
    for path in paths:
        data = await state.request_device("GET", path)
        keep = data.get("keep") or {}
        # Nothing to lose: no keep count, and whatever the rule is we can put
        # it back verbatim.
        if keep.get("rule") in (None, "none") and not keep.get("count"):
            target = (path, data)
            break

    if target is None:
        print("no series safe to probe")
        return 1

    path, before = target
    original = (before.get("schedule") or {}).get("rule") or before.get("schedule_rule")
    print(f"probing {path}, current rule {original!r}")

    status, data = await state.patch_device(path, {"schedule": {"rule": "ZZZ"}})
    print(f"invalid value -> {status} {json.dumps(data)}")

    accepted = []
    for rule in CANDIDATES:
        status, data = await state.patch_device(path, {"schedule": {"rule": rule}})
        after = await state.request_device("GET", path)
        got = (after.get("schedule") or {}).get("rule") or after.get("schedule_rule")
        print(f"{rule!r} -> {status}, series now reports {got!r}")
        if status == 200:
            accepted.append(rule)

    if original:
        await state.patch_device(path, {"schedule": {"rule": original}})
        restored = await state.request_device("GET", path)
        print("restored to", (restored.get("schedule") or {}).get("rule")
              or restored.get("schedule_rule"))

    print("accepted:", accepted)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
```

- [ ] **Step 2: Run it against the device**

Requires Task 2 (`state.patch_device`) to exist — do Task 2 first if the import fails, then return here.

Run: `cd backend && python tools/probe_schedule_rules.py`
Expected: a line per candidate. Record which return 200 and which the follow-up GET confirms.

If the device is unreachable, **stop and report**. Do not guess the enumeration — every later task can proceed with `"new"` alone, and the missing segments are added once the probe runs.

- [ ] **Step 3: Record the result in docs/tablo-api.md**

Replace the §Unknowns bullet:

```markdown
- `schedule.rule` beyond `"new"` — presumably `"none"` and `"all"`
```

with what the probe measured, e.g.:

```markdown
- `schedule.rule` accepts `"all"`, `"new"` and `"none"` — confirmed by writing
  each and diffing the series object, then restoring the original. An unknown
  value returns `400 invalid_patch_document` with `details={"rule": "<value>"}`.
```

- [ ] **Step 4: Commit**

```bash
git add backend/tools/probe_schedule_rules.py docs/tablo-api.md
git commit -m "docs: confirm the device's schedule.rule enumeration"
```

---

### Task 2: `state.patch_device()`

`_request_device_raw` calls `raise_for_status()`, which discards the device's error body — and that body is the only thing that can say *why* a write was refused.

**Files:**
- Modify: `backend/app/state.py` (after `_request_device_raw`, around line 263)
- Test: `backend/tests/test_schedule.py` (create)

**Interfaces:**
- Consumes: `AppState._request_device_raw`'s signing approach (`TabloAuth.make_device_auth`).
- Produces: `async AppState.patch_device(path: str, payload: dict) -> tuple[int, dict]` — never raises for an HTTP status; raises only on transport failure.

- [ ] **Step 1: Write the failing tests**

Async tests in this suite are driven with `asyncio.run` from a sync test — see
`tests/test_cloud_guide.py`. Follow that rather than introducing a marker style
the suite has no configuration for.

```python
"""Recording management: the device write path and the routes over it."""

import asyncio

import pytest

from app.state import AppState


class _Resp:
    def __init__(self, status, payload, text="{}"):
        self.status_code = status
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def test_patch_device_returns_the_status_and_the_body():
    """A 400 is an answer, not an exception - its body says what was wrong."""
    state = AppState()
    state.active_device = type("D", (), {"local_url": "http://tablo:8887"})()
    sent = {}

    async def fake_request(method, url, content=None, headers=None, **kw):
        sent.update(method=method, url=url, content=content, headers=headers)
        return _Resp(400, {"error": {"code": "invalid_patch_document",
                                     "description": "Invalid value for 'rule' parameter",
                                     "details": {"rule": "ZZZ"}}})

    state._http.request = fake_request

    status, data = asyncio.run(state.patch_device("/guide/series/6472",
                                                  {"schedule": {"rule": "ZZZ"}}))

    assert status == 400
    assert data["error"]["description"] == "Invalid value for 'rule' parameter"
    assert sent["method"] == "PATCH"
    assert sent["url"] == "http://tablo:8887/guide/series/6472"
    # The signature covers the body, so what was signed must be what was sent.
    assert sent["content"] == b'{"schedule":{"rule":"ZZZ"}}'
    assert sent["headers"]["Authorization"].startswith("tablo:")


def test_patch_device_tolerates_a_body_that_is_not_json():
    state = AppState()
    state.active_device = type("D", (), {"local_url": "http://tablo:8887"})()

    async def fake_request(*a, **kw):
        return _Resp(502, None, text="<html>gateway</html>")

    state._http.request = fake_request

    status, data = asyncio.run(state.patch_device("/guide/series/1", {"a": 1}))
    assert (status, data) == (502, {})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && python -m pytest tests/test_schedule.py -q`
Expected: FAIL — `AttributeError: 'AppState' object has no attribute 'patch_device'`.

- [ ] **Step 3: Implement it**

In `backend/app/state.py`, directly after `_request_device_raw`:

```python
    async def patch_device(self, path: str, payload: dict) -> tuple[int, dict]:
        """PATCH the device, returning (status, body) rather than raising.

        `_request_device_raw` calls `raise_for_status()`, which throws the
        device's error body away - and that body is the only thing that can say
        *why* a write was refused. The device answers a bad write with
        `{"error": {"code", "description", "details"}}`, and `details` echoes
        the offending field, so a failure can be shown to a person instead of
        reported as a generic error. See docs/tablo-api.md.

        Writes need no separate auth mechanism: the signature covers the body,
        which is why the payload is serialised once and both signed and sent.
        """
        if self.active_device is None:
            raise RuntimeError("No active device")

        from tablo_api import TabloAuth

        body = json.dumps(payload, separators=(",", ":"))
        auth_header, date_header = TabloAuth.make_device_auth("PATCH", path, body)
        url = self.active_device.local_url.rstrip("/") + path
        resp = await self._http.request(
            "PATCH",
            url,
            content=body.encode(),
            headers={
                "Authorization": auth_header,
                "Date": date_header,
                "Content-Type": "application/json",
                "User-Agent": "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)",
            },
        )
        try:
            return resp.status_code, resp.json()
        except ValueError:
            # A proxy error page, or an empty body. The status is still the answer.
            return resp.status_code, {}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && python -m pytest tests/test_schedule.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/state.py backend/tests/test_schedule.py
git commit -m "feat: add a device PATCH helper that keeps the error body"
```

---

### Task 3: Mirror write-through helpers

**Files:**
- Modify: `backend/app/store.py` (add after `airing_detail`, end of the guide section)
- Test: `backend/tests/test_schedule.py` (append)

**Interfaces:**
- Consumes: `db.query`, `db.query_one`, `db.execute`, `store.save_guide` (tests only).
- Produces:
  - `airing_handles(channel: str, start: str) -> dict | None` → `{"airing_path", "series_path"}`
  - `update_airing_schedule(channel: str, start: str, air: dict) -> None`
  - `series_future_airings(series_path: str, now: float | None = None, limit: int = 200) -> list[dict]` → rows of `{"channel", "start", "airing_path"}`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_schedule.py`:

```python
import time

from app import store


def _guide(now, **over):
    """One channel with one airing, the shape save_guide expects."""
    airing = {
        "title": "Finding Your Roots", "subtitle": None, "description": None,
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 3600)),
        "duration": 3600, "genres": [], "kind": "episode",
        "episode_title": "Rags to Riches", "season_number": 12,
        "episode_number": 10, "orig_air_date": None,
        "series_path": "/guide/series/6472",
        "airing_path": "/guide/series/episodes/67388",
        "schedule_state": "none", "schedule_qualifier": "none",
        "skip_reason": "none", "image_url": None,
    }
    airing.update(over)
    return [{
        "identifier": "ch1", "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "PBS", "display_name": "KPAX", "logo_url": None,
        "kind": "ota", "airings": [airing],
    }], airing["start"]


def test_airing_handles_returns_the_device_paths():
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    got = store.airing_handles("ch1", start)
    assert got == {"airing_path": "/guide/series/episodes/67388",
                   "series_path": "/guide/series/6472"}


def test_airing_handles_is_none_for_an_airing_we_do_not_have():
    assert store.airing_handles("ch1", "2026-01-01T00:00:00Z") is None


def test_update_airing_schedule_writes_only_the_schedule_columns():
    """The PATCH response is the whole record, but the row also holds guide
    text that the write must not disturb."""
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    store.update_airing_schedule("ch1", start, {
        "schedule_state": "scheduled", "schedule_qualifier": "single",
        "skip_reason": None, "airing_path": "/guide/series/episodes/67388",
        "series_path": "/guide/series/6472",
    })

    detail = store.airing_detail("ch1", start, now=now)
    assert detail["schedule_state"] == "scheduled"
    assert detail["title"] == "Finding Your Roots"
    assert detail["episode_title"] == "Rags to Riches"


def test_update_airing_schedule_keeps_the_paths_when_the_write_omits_them():
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    store.update_airing_schedule("ch1", start, {"schedule_state": "scheduled"})

    assert store.airing_handles("ch1", start)["airing_path"] == \
        "/guide/series/episodes/67388"


def test_series_future_airings_skips_the_past_and_the_unschedulable():
    now = time.time()
    past = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 7200))
    cloud = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 7200))
    rows, start = _guide(now)
    rows[0]["airings"] += [
        {**rows[0]["airings"][0], "start": past},
        {**rows[0]["airings"][0], "start": cloud, "airing_path": None},
    ]
    store.save_guide(rows, now=now)

    got = store.series_future_airings("/guide/series/6472", now=now)
    assert [r["start"] for r in got] == [start]
    assert got[0]["channel"] == "ch1"
    assert got[0]["airing_path"] == "/guide/series/episodes/67388"
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && python -m pytest tests/test_schedule.py -q`
Expected: FAIL — `AttributeError: module 'app.store' has no attribute 'airing_handles'`.

- [ ] **Step 3: Implement the helpers**

In `backend/app/store.py`, after `airing_detail`:

```python
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

    A targeted UPDATE rather than the save_guide upsert: the response being
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
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && python -m pytest tests/test_schedule.py -q`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/store.py backend/tests/test_schedule.py
git commit -m "feat: add mirror write-through helpers for schedule state"
```

---

### Task 4: Widen `airing-detail` with the recording state

**Files:**
- Modify: `backend/app/store.py` (`airing_detail`, plus a module-level helper)
- Test: `backend/tests/test_schedule.py` (append)

**Interfaces:**
- Consumes: `store.airing_detail` as it stands.
- Produces: five new keys in the `airing-detail` response — `schedulable: bool`, `scheduled: bool`, `past: bool`, `schedule_state: str | None`, `skip_reason: str | None` — and `series: {"path": str, "schedule_rule": str | None} | None`. Task 7's `AiringDetail` type mirrors these names exactly.

`past` is separate from the existing `airing_now`, and the distinction matters: `airing_now` is false for everything *upcoming* too, which is the main thing anyone records. Only `past` means "recording this is no longer possible". Both are computed server-side for the same reason — the browser's clock may differ from the guide's.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_schedule.py`:

```python
def test_airing_detail_says_whether_it_can_be_recorded():
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)
    store.save_series([{
        "path": "/guide/series/6472", "identifier": "X",
        "title": "Finding Your Roots", "description": None, "genres": [],
        "rating": "tvpg", "orig_air_date": None, "episode_runtime": 3600,
        "cast": [], "cover_image_id": None, "thumbnail_image_id": None,
        "background_image_id": None, "schedule_rule": "new",
        "keep_rule": "none", "keep_count": None,
    }])

    d = store.airing_detail("ch1", start, now=now)
    assert d["schedulable"] is True
    assert d["scheduled"] is False          # schedule_state is "none"
    assert d["schedule_state"] == "none"
    assert d["past"] is False               # _guide() puts it an hour out
    assert d["series"] == {"path": "/guide/series/6472", "schedule_rule": "new"}


def test_an_airing_that_has_finished_is_past():
    """Distinct from `airing_now`, which is also false for everything upcoming
    - and upcoming is what people record."""
    now = time.time()
    rows, _ = _guide(now)
    ended = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 7200))
    rows[0]["airings"][0]["start"] = ended
    store.save_guide(rows, now=now)

    d = store.airing_detail("ch1", ended, now=now)
    assert d["past"] is True
    assert d["airing_now"] is False


def test_a_cloud_only_airing_is_not_schedulable():
    """OTT/FAST airings exist only in the cloud, which carries no device path,
    no schedule block and no series_path - nothing can record them."""
    now = time.time()
    rows, start = _guide(now, airing_path=None, series_path=None,
                         schedule_state=None, schedule_qualifier=None,
                         skip_reason=None)
    store.save_guide(rows, now=now)

    d = store.airing_detail("ch1", start, now=now)
    assert d["schedulable"] is False
    assert d["scheduled"] is False
    assert d["series"] is None


def test_any_state_but_none_or_skipped_counts_as_recording():
    """schedule.state is an open enumeration - name the values that mean *not*
    recording and treat the rest as recording, so an unseen one is not read as
    'this is not being recorded' when it is."""
    now = time.time()
    rows, start = _guide(now, schedule_state="conflict")
    store.save_guide(rows, now=now)

    assert store.airing_detail("ch1", start, now=now)["scheduled"] is True
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && python -m pytest tests/test_schedule.py -q`
Expected: FAIL — `KeyError: 'schedulable'`.

- [ ] **Step 3: Implement**

In `backend/app/store.py`, above `airing_detail`:

```python
# The device's `schedule.state` is an open enumeration - `/server/capabilities`
# advertises features whose states we have never seen. Naming the values that
# mean "not recording" and treating everything else as recording fails safe:
# an unseen state shows a REC badge that can be turned off, rather than hiding
# a recording that is actually scheduled.
_NOT_RECORDING = {None, "none", "skipped"}


def _is_scheduled(state: str | None) -> bool:
    return state not in _NOT_RECORDING
```

Then in `airing_detail`'s returned dict, alongside `airing_now`:

```python
        # Recording state. `schedulable` is decided here rather than left to
        # the client to infer from a path, because the path never leaves the
        # backend - see routes/schedule.py.
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
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && python -m pytest tests/ -q`
Expected: PASS — the whole suite, including the existing `test_airing_detail_*` cases in `tests/test_channels.py`, which must not regress.

- [ ] **Step 5: Commit**

```bash
git add backend/app/store.py backend/tests/test_schedule.py
git commit -m "feat: report recording state from airing-detail"
```

---

### Task 5: `PUT /api/schedule/airing`

**Files:**
- Create: `backend/app/routes/schedule.py`
- Modify: `backend/app/main.py:9` (import) and `main.py:88` (include_router)
- Test: `backend/tests/test_schedule.py` (append)

**Interfaces:**
- Consumes: `store.airing_handles`, `store.update_airing_schedule`, `store.airing_detail`, `AppState._airing_row`, `state.patch_device`.
- Produces: `PUT /api/schedule/airing` taking `{channel, start, scheduled}` and returning the `airing-detail` shape; module-level `_device_error(status, data) -> HTTPException` and `_handles(channel, start)` reused by Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_schedule.py`:

```python
from fastapi.testclient import TestClient

from app.main import app
from app.state import state as app_state

client = TestClient(app)


@pytest.fixture
def authed(monkeypatch):
    monkeypatch.setattr(type(app_state), "is_authenticated",
                        property(lambda self: True))


def _device_airing(state_value):
    """A device airing record, as PATCH returns it."""
    return {
        "path": "/guide/series/episodes/67388",
        "series_path": "/guide/series/6472",
        "episode": {"title": "Rags to Riches", "number": 10,
                    "season_number": 12, "orig_air_date": None},
        "airing_details": {"datetime": "2026-09-16T08:00Z", "duration": 3600,
                           "channel_path": "/guide/channels/1", "genres": [],
                           "show_title": "Finding Your Roots"},
        "schedule": {"state": state_value, "qualifier": "single",
                     "skip_reason": None},
    }


def test_scheduling_an_airing_patches_the_device_and_the_mirror(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)
    sent = {}

    async def fake_patch(path, payload):
        sent.update(path=path, payload=payload)
        return 200, _device_airing("scheduled")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})

    assert resp.status_code == 200
    assert sent == {"path": "/guide/series/episodes/67388",
                    "payload": {"scheduled": True}}
    assert resp.json()["scheduled"] is True
    assert store.airing_detail("ch1", start, now=now)["schedule_state"] == "scheduled"


def test_an_unknown_airing_is_a_404(authed):
    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": "2026-01-01T00:00:00Z",
                            "scheduled": True})
    assert resp.status_code == 404


def test_a_cloud_airing_is_refused_without_touching_the_device(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now, airing_path=None)
    store.save_guide(rows, now=now)

    async def fake_patch(path, payload):
        raise AssertionError("the device must not be asked")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})
    assert resp.status_code == 409
    assert "cloud" in resp.json()["detail"].lower()


def test_a_device_refusal_is_reported_in_the_device_s_own_words(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    async def fake_patch(path, payload):
        return 400, {"error": {"code": "invalid_patch_document",
                               "description": "Invalid parameter value",
                               "details": {"scheduled": None}}}

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid parameter value"


def test_an_unreachable_device_is_a_502(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    async def fake_patch(path, payload):
        raise OSError("connection refused")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": start, "scheduled": True})
    assert resp.status_code == 502


def test_scheduling_requires_auth():
    resp = client.put("/api/schedule/airing",
                      json={"channel": "ch1", "start": "x", "scheduled": True})
    assert resp.status_code == 401
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && python -m pytest tests/test_schedule.py -q`
Expected: FAIL — 404 from FastAPI for every case, because the route does not exist.

- [ ] **Step 3: Write the router**

Create `backend/app/routes/schedule.py`:

```python
"""Recording management writes.

Addressed by `(channel, start)` - `guide_airing`'s primary key, which the show
sheet already holds. The device paths are resolved here and never leave the
backend: a device path in a browser is a PATCH target in a browser.

The device's write surface is `PATCH` only and its validator is strict, which
is what makes it safe to build against - a wrong value returns 400 rather than
doing something unintended. See docs/tablo-api.md.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import store
from ..state import AppState, _run_sync, state

router = APIRouter(prefix="/api/schedule", tags=["schedule"])


class AiringIn(BaseModel):
    channel: str
    start: str
    scheduled: bool


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


async def _handles(channel: str, start: str) -> dict:
    handles = await _run_sync(store.airing_handles, channel, start)
    if handles is None:
        raise HTTPException(status_code=404, detail="Airing not found")
    return handles


def _device_error(status: int, data: dict) -> HTTPException:
    """The device's own words for a refusal, or a fixed message for the rest.

    A 400 carries `error.description` and `error.details`, which is the only
    thing that can tell someone why the write was refused. Anything else is a
    transport problem and is not the person's business.
    """
    if status == 400:
        description = ((data or {}).get("error") or {}).get("description")
        return HTTPException(status_code=400,
                             detail=description or "The Tablo refused the change.")
    return HTTPException(status_code=502, detail="The Tablo could not be reached.")


@router.put("/airing")
async def schedule_airing(body: AiringIn):
    """Record, or stop recording, one episode.

    The write parameter is `scheduled`, a boolean at the top level - not the
    `schedule.state` the GET exposes, which is rejected. Read shape and write
    shape are not the same here.
    """
    _require_auth()
    handles = await _handles(body.channel, body.start)
    if not handles["airing_path"]:
        raise HTTPException(
            status_code=409,
            detail="This channel's schedule comes from the cloud, "
                   "which carries nothing to record.",
        )

    try:
        status, data = await state.patch_device(
            handles["airing_path"], {"scheduled": body.scheduled}
        )
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    if status != 200:
        raise _device_error(status, data)

    # The response is the full updated record, so the write doubles as a read.
    await _run_sync(store.update_airing_schedule, body.channel, body.start,
                    AppState._airing_row(data))
    return await _run_sync(store.airing_detail, body.channel, body.start)
```

- [ ] **Step 4: Mount it**

In `backend/app/main.py`, extend the import on line 9:

```python
from .routes import auth, channels, iptv, recordings, resume, schedule, search, stream
```

and add below `app.include_router(resume.router)`:

```python
app.include_router(schedule.router)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && python -m pytest tests/ -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routes/schedule.py backend/app/main.py backend/tests/test_schedule.py
git commit -m "feat: schedule or cancel one episode from the show sheet"
```

---

### Task 6: `PUT /api/schedule/series` and the fan-out refresh

A series rule flips `schedule.state` on every future episode. The background sync is up to `TABLO_GUIDE_SYNC_HOURS` (default 6) away, so without this every sibling airing claims it is not scheduled for the rest of the afternoon.

**Files:**
- Modify: `backend/app/routes/schedule.py`
- Test: `backend/tests/test_schedule.py` (append)

**Interfaces:**
- Consumes: Task 5's `_handles` / `_device_error`, `store.series_future_airings`, `store.save_series`, `AppState._series_row`, `state.request_device`.
- Produces: `PUT /api/schedule/series` taking `{channel, start, rule}`; `async refresh_series_airings(series_path: str) -> int`, module-level so a test can replace it and assert it was scheduled.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_schedule.py`:

```python
def _device_series(rule):
    return {
        "path": "/guide/series/6472", "identifier": "X",
        "series": {"title": "Finding Your Roots", "description": None,
                   "genres": [], "series_rating": "tvpg", "orig_air_date": None,
                   "episode_runtime": 3600, "cast": []},
        "schedule_rule": rule,
        "keep": {"rule": "none", "count": None},
    }


def test_setting_a_series_rule_patches_the_nested_shape(authed, monkeypatch):
    """`{"schedule": {"rule": ...}}` - the top-level `schedule_rule` the GET
    returns is rejected on a write."""
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)
    sent = {}

    async def fake_patch(path, payload):
        sent.update(path=path, payload=payload)
        return 200, _device_series("all")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    monkeypatch.setattr(schedule_routes, "refresh_series_airings",
                        lambda p: _noop())

    resp = client.put("/api/schedule/series",
                      json={"channel": "ch1", "start": start, "rule": "all"})

    assert resp.status_code == 200
    assert sent == {"path": "/guide/series/6472",
                    "payload": {"schedule": {"rule": "all"}}}
    assert resp.json()["series"]["schedule_rule"] == "all"


def test_an_unknown_rule_never_reaches_the_device(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)

    async def fake_patch(path, payload):
        raise AssertionError("the device must not be asked")

    monkeypatch.setattr(app_state, "patch_device", fake_patch)

    resp = client.put("/api/schedule/series",
                      json={"channel": "ch1", "start": start, "rule": "ZZZ"})
    assert resp.status_code == 422


def test_an_airing_with_no_series_is_a_409(authed, monkeypatch):
    now = time.time()
    rows, start = _guide(now, series_path=None)
    store.save_guide(rows, now=now)

    resp = client.put("/api/schedule/series",
                      json={"channel": "ch1", "start": start, "rule": "all"})
    assert resp.status_code == 409


def test_the_refresh_rereads_this_series_future_airings(monkeypatch):
    now = time.time()
    rows, start = _guide(now)
    store.save_guide(rows, now=now)
    asked = []

    async def fake_request(method, path):
        asked.append((method, path))
        return _device_airing("scheduled")

    monkeypatch.setattr(app_state, "request_device", fake_request)

    got = asyncio.run(schedule_routes.refresh_series_airings("/guide/series/6472"))

    assert got == 1
    assert asked == [("GET", "/guide/series/episodes/67388")]
    assert store.airing_detail("ch1", start, now=now)["schedule_state"] == "scheduled"


def test_a_failing_refresh_is_swallowed(monkeypatch):
    """The write already succeeded on the device. Reporting it as a failure
    because a refresh stumbled would be a lie about the thing that matters."""
    now = time.time()
    rows, _ = _guide(now)
    store.save_guide(rows, now=now)

    async def fake_request(method, path):
        raise OSError("connection refused")

    monkeypatch.setattr(app_state, "request_device", fake_request)

    assert asyncio.run(
        schedule_routes.refresh_series_airings("/guide/series/6472")) == 0
```

Add to the imports at the top of the test file:

```python
from app.routes import schedule as schedule_routes


async def _noop():
    return 0
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && python -m pytest tests/test_schedule.py -q`
Expected: FAIL — `AttributeError: module 'app.routes.schedule' has no attribute 'refresh_series_airings'`.

- [ ] **Step 3: Implement the route and the refresh**

Append to `backend/app/routes/schedule.py` (and extend its imports with `import asyncio` and `from ..state import SERIES_SYNC_CONCURRENCY`):

```python
# Confirmed against the device by tools/probe_schedule_rules.py. The validator
# rejects anything else with a 400, but refusing here keeps a typo off the wire
# and out of the audit trail.
RULES = ("all", "new", "none")


class SeriesIn(BaseModel):
    channel: str
    start: str
    rule: str


@router.put("/series")
async def schedule_series(body: SeriesIn):
    """Set the series rule: record all episodes, new ones only, or none.

    Nested, not flat: `{"schedule": {"rule": ...}}`. The GET also exposes a
    top-level `schedule_rule`, but writing that key fails with "Must specify at
    least one valid parameter".
    """
    _require_auth()
    if body.rule not in RULES:
        raise HTTPException(status_code=422, detail=f"Unknown rule: {body.rule}")

    handles = await _handles(body.channel, body.start)
    if not handles["series_path"]:
        raise HTTPException(status_code=409,
                            detail="This airing has no series to set a rule on.")

    try:
        status, data = await state.patch_device(
            handles["series_path"], {"schedule": {"rule": body.rule}}
        )
    except Exception:
        raise HTTPException(status_code=502,
                            detail="The Tablo could not be reached.") from None
    if status != 200:
        raise _device_error(status, data)

    await _run_sync(store.save_series, [AppState._series_row(data)])
    # After the response, not before it: one rule change flips the state of
    # every future episode, and re-reading them is tens of device requests.
    asyncio.create_task(refresh_series_airings(handles["series_path"]))
    return await _run_sync(store.airing_detail, body.channel, body.start)


async def refresh_series_airings(series_path: str) -> int:
    """Re-read this series' future airings so sibling cells stop lying.

    Bounded by the mirror's own list and run at the background sync's
    concurrency - the Tablo is shared with playback and saturates around 10x
    realtime, so a rule change must not turn into a burst.

    Never raises and its result is never surfaced. The write already succeeded
    on the device; a stumbling refresh is a staleness problem, which the next
    sync fixes, not a failed write.
    """
    try:
        rows = await _run_sync(store.series_future_airings, series_path)
    except Exception as e:
        print(f"[schedule] could not list {series_path}: {e}", flush=True)
        return 0

    sem = asyncio.Semaphore(SERIES_SYNC_CONCURRENCY)

    async def one(row) -> int:
        async with sem:
            try:
                data = await state.request_device("GET", row["airing_path"])
                await _run_sync(store.update_airing_schedule, row["channel"],
                                row["start"], AppState._airing_row(data))
                return 1
            except Exception:
                return 0

    return sum(await asyncio.gather(*[one(r) for r in rows]))
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && python -m pytest tests/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/schedule.py backend/tests/test_schedule.py
git commit -m "feat: set a series recording rule, and refresh its airings"
```

---

### Task 7: The sheet's recording controls

**Files:**
- Modify: `frontend/src/api/tablo.ts` (the `AiringDetail` interface, ~line 108; the `api` object, ~line 372)
- Modify: `frontend/src/components/ShowInfo.tsx`
- Test: `frontend/src/__tests__/showInfo.test.tsx`

**Interfaces:**
- Consumes: Task 4's response keys (`schedulable`, `scheduled`, `schedule_state`, `skip_reason`, `series`) and Tasks 5–6's endpoints.
- Produces: `api.scheduleAiring(channel, start, scheduled)` and `api.scheduleSeries(channel, start, rule)`, both resolving to `AiringDetail`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/__tests__/showInfo.test.tsx`, extend the `detail()` factory with the new fields:

```tsx
    schedulable: true, scheduled: false, past: false,
    schedule_state: "none", skip_reason: null,
    series: { path: "/guide/series/6472", schedule_rule: "none" },
```

and append inside `describe("ShowInfo", …)`:

```tsx
  it("offers to record an episode that is not being recorded", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    const schedule = vi.spyOn(api, "scheduleAiring")
      .mockResolvedValue(detail({ scheduled: true, schedule_state: "scheduled" }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /record episode/i }));

    expect(schedule).toHaveBeenCalledWith("ch1", "s", true);
    expect(await screen.findByRole("button", { name: /don't record episode/i }))
      .toBeInTheDocument();
  });

  it("offers to stop recording one that is", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ scheduled: true, schedule_state: "scheduled" }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /don't record episode/i }))
      .toBeInTheDocument();
    expect(screen.getByText(/this episode only/i)).toBeInTheDocument();
  });

  it("says when a recording comes from the series rule", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      scheduled: true, schedule_state: "scheduled",
      series: { path: "/guide/series/6472", schedule_rule: "all" },
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText(/all episodes/i)).toBeInTheDocument();
  });

  it("sets the series rule", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    const schedule = vi.spyOn(api, "scheduleSeries").mockResolvedValue(detail({
      scheduled: true, schedule_state: "scheduled",
      series: { path: "/guide/series/6472", schedule_rule: "new" },
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /^new$/i }));

    expect(schedule).toHaveBeenCalledWith("ch1", "s", "new");
    expect(await screen.findByRole("button", { name: /^new$/i }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("reverts and explains when the Tablo refuses", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    vi.spyOn(api, "scheduleAiring")
      .mockRejectedValue(new Error("Invalid parameter value"));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /record episode/i }));

    expect(await screen.findByText(/invalid parameter value/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record episode/i })).toBeInTheDocument();
  });

  it("does not offer to record what cannot be recorded", async () => {
    // OTT/FAST: the cloud carries no device path, no schedule block and no
    // series, so nothing can record it.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ schedulable: false, series: null }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Finding Your Roots");
    expect(screen.queryByRole("button", { name: /record episode/i })).toBeNull();
    expect(screen.getByText(/isn't available on this channel/i)).toBeInTheDocument();
  });

  it("keeps the series control on a programme that has already aired", async () => {
    // Nothing can record what has finished, but setting a rule from an old
    // listing is meaningful — it is about every episode still to come.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ airing_now: false, past: true }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record episode/i })).toBeNull();
  });

  it("still offers to record something merely upcoming", async () => {
    // `airing_now` is false for everything upcoming, which is the main thing
    // anyone records — gating on it would have hidden the button for all of it.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ airing_now: false, past: false }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /record episode/i }))
      .toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npm test -- showInfo`
Expected: FAIL — `api.scheduleAiring is not a function`, plus type errors on the new `detail()` fields.

- [ ] **Step 3: Extend the API client**

In `frontend/src/api/tablo.ts`, add to `AiringDetail` (after `airing_now`):

```ts
  /** The device can record this — false for cloud-only OTT/FAST airings. */
  schedulable: boolean;
  /** Derived server-side: any schedule state but "none"/"skipped"/null. */
  scheduled: boolean;
  /** Already finished. Not the inverse of `airing_now`, which is also false
   *  for everything upcoming. */
  past: boolean;
  /** The device's own state string, passed through. */
  schedule_state: string | null;
  skip_reason: string | null;
  /** Null for a one-off, a movie, or an airing whose series is unknown. */
  series: { path: string; schedule_rule: string | null } | null;
```

and, after `airingDetail`:

```ts
export type SeriesRule = "all" | "new" | "none";
```

(declare the type near the other exported types, above `export const api`), plus the two calls inside `api`:

```ts
  /** Record, or stop recording, one episode. Returns the updated detail —
   *  the device answers a write with the full record, so no refetch. */
  scheduleAiring: (channel: string, start: string, scheduled: boolean) =>
    req<AiringDetail>("/schedule/airing", {
      method: "PUT",
      body: JSON.stringify({ channel, start, scheduled }),
    }),

  /** Set the series rule. Affects every future episode, not just this one. */
  scheduleSeries: (channel: string, start: string, rule: SeriesRule) =>
    req<AiringDetail>("/schedule/series", {
      method: "PUT",
      body: JSON.stringify({ channel, start, rule }),
    }),
```

- [ ] **Step 4: Add the controls to the sheet**

In `frontend/src/components/ShowInfo.tsx`:

Extend the import on line 2:

```tsx
import { Play, X, Circle, CircleSlash, SlidersHorizontal } from "lucide-react";
```

and the type import on line 4:

```tsx
import type { AiringDetail, SeriesRule } from "../api/tablo";
```

Add above the component:

```tsx
const RULES: { value: SeriesRule; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "none", label: "None" },
];

/**
 * What a scheduled recording is owed to — the series rule, or this episode.
 *
 * The device does not say which, so it is inferred: a series set to record
 * anything is what put a scheduled episode there.
 */
function recordScope(d: AiringDetail): string {
  const rule = d.series?.schedule_rule;
  return rule === "all" || rule === "new"
    ? "Record: All Episodes"
    : "Record: This Episode Only";
}
```

Inside the component, beside the existing state:

```tsx
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Apply a write optimistically, and put the old state back if it fails.
   *
   * Optimistic because the common failure is the network rather than a
   * refusal, and because the response carries the truth either way — every
   * one of these endpoints answers with the full updated detail.
   */
  async function write(
    optimistic: Partial<AiringDetail>,
    work: () => Promise<AiringDetail>,
  ) {
    if (!detail) return;
    const before = detail;
    setDetail({ ...detail, ...optimistic });
    setPending(true);
    setError(null);
    try {
      setDetail(await work());
    } catch (e) {
      setDetail(before);
      setError(e instanceof Error ? e.message : "The change did not stick.");
    } finally {
      setPending(false);
    }
  }
```

Then, immediately after the Watch Live block and before the closing `</div>` of the padded body:

```tsx
          {detail && !noListing && !detail.schedulable && (
            <p className="mt-6 text-xs text-fg-muted">
              Recording isn't available on this channel.
            </p>
          )}

          {detail?.schedulable && (
            <div className="mt-6 space-y-2">
              {detail.scheduled && (
                <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                  REC · {recordScope(detail)}
                </p>
              )}

              {!detail.past && (
              <button
                disabled={pending}
                onClick={() => write(
                  { scheduled: !detail.scheduled },
                  () => api.scheduleAiring(channel, start!, !detail.scheduled),
                )}
                className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl
                           text-sm font-semibold bg-fill-soft text-fg
                           hover:bg-fill transition disabled:opacity-60
                           focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {detail.scheduled
                  ? <CircleSlash className="w-4 h-4 shrink-0" aria-hidden />
                  : <Circle className="w-4 h-4 shrink-0" aria-hidden />}
                {detail.scheduled ? "Don't Record Episode" : "Record Episode"}
              </button>
              )}

              {detail.series && (
                <div className="rounded-xl bg-fill-soft p-3">
                  <p className="flex items-center gap-3 text-sm font-semibold text-fg">
                    <SlidersHorizontal className="w-4 h-4 shrink-0" aria-hidden />
                    Edit Series Recording
                  </p>
                  <div className="mt-3 flex gap-2">
                    {RULES.map(({ value, label }) => {
                      const on = detail.series?.schedule_rule === value;
                      return (
                        <button
                          key={value}
                          aria-pressed={on}
                          disabled={pending}
                          onClick={() => write(
                            { series: { ...detail.series!, schedule_rule: value } },
                            () => api.scheduleSeries(channel, start!, value),
                          )}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold
                                      transition disabled:opacity-60
                                      focus:outline-none focus:ring-2 focus:ring-accent ${
                            on ? "bg-accent text-accent-fg"
                               : "bg-fill text-fg-secondary hover:text-fg"}`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {error && (
                <p role="alert" className="text-xs text-danger">{error}</p>
              )}
            </div>
          )}
```

The episode button is hidden once `past` is true — nothing can record what has finished — while the series control stays, because a rule set from an old listing is about every episode still to come. Gate on `past`, never on `airing_now`: that is false for everything upcoming too, which is most of what anyone records.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npm test`
Expected: PASS — the whole suite. The existing `renders a bare airing without empty rows` case must still pass, so check the new block is omitted rather than emptied when `schedulable` is false.

- [ ] **Step 6: Typecheck and lint**

Run: `cd frontend && npx tsc -b && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/tablo.ts frontend/src/components/ShowInfo.tsx frontend/src/__tests__/showInfo.test.tsx
git commit -m "feat: record episodes and set series rules from the show sheet"
```

---

### Task 8: Verify against the real device

Tests use injected device responses. Nothing so far proves the signature is accepted, that `guide_airing.airing_path` holds real paths, or that the sheet's buttons move anything on the Tablo.

**Files:** none — this task changes nothing unless it finds a fault.

- [ ] **Step 1: Bring the stack up the supported way**

**REQUIRED SUB-SKILL:** invoke the `tablo-stack` skill and follow it. A bare `docker compose up` serves the app from the wrong backend and nothing in the UI says so.

- [ ] **Step 2: Rebuild the frontend and open the app**

Per `tablo-stack`. Then open `http://127.0.0.1:7070`, open the Guide, and click a programme on an OTA channel that has EPG data.

- [ ] **Step 3: Record one episode**

Click **Record Episode**. Expected: the button becomes **Don't Record Episode** and the `REC · Record: This Episode Only` eyebrow appears. Reload the page and re-open the same programme — the state must survive, which is what proves the mirror was written and not just React state.

Confirm on the device or in the Tablo app that the episode is now scheduled.

- [ ] **Step 4: Set a series rule and watch the fan-out**

Click **All**. Expected: 200, the segment fills, and the backend log shows no `[schedule] could not list` line. Open a *different* future episode of the same series: it must already show as scheduled, which is the refresh having run.

- [ ] **Step 5: Check the refusal path**

Open a programme on an OTT/FAST channel (500.1, 501.5, 501.6, 528.1 or 7.99 on the mapped device). Expected: no buttons, and the line "Recording isn't available on this channel."

- [ ] **Step 6: Put it back**

Set the series rule back to what the probe in Task 1 recorded as its original value, and cancel the episode recording if it was not wanted. Leave the device as it was found.

- [ ] **Step 7: Commit anything the verification changed**

Only if a fault was found and fixed. Otherwise there is nothing to commit — say what was verified instead.

---

## Notes for the executor

- **The probe (Task 1) gates the segments, not the plan.** If the device is unreachable, do Tasks 2–8 with `RULES = ("new",)` and a single `New` / cancel control, and say so in the summary. Do not ship `"all"` / `"none"` on an inference.
- **`_airing_row` and `_series_row` are `@staticmethod`s on `AppState`** — call them as `AppState._airing_row(data)`, not on the `state` singleton.
- **Never call `store.save_guide` to write a single airing back.** It replaces whole rows; `update_airing_schedule` exists because the row also holds guide text and artwork.
- **The two schedule endpoints return the `airing-detail` shape**, so the sheet re-renders from the write's own response. Do not add a follow-up `airingDetail()` call in the frontend.
