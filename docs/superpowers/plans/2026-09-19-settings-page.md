# Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A gear-icon Settings modal (opened from the tablo-web AppMenu) that reads and writes device settings via `/api/settings`, with no-op controls where the device exposes no write verb.

**Architecture:** New backend router `backend/app/routes/settings.py` (thin passthrough over `state.request_device` / `state.patch_device`, mirroring `schedule.py`). New frontend `SettingsModal.tsx` (reusing `ConfirmDialog`'s overlay scaffolding), fed by new `api.settings.*` methods in `src/api/tablo.ts`. Gear entry added to `AppMenu.tsx`; open-state lifted to `ChannelGrid.tsx`.

**Tech Stack:** FastAPI + pytest (backend), React + TanStack Query + Vitest/@testing-library (frontend).

**Spec:** `docs/superpowers/specs/2026-09-19-settings-page-design.md`

## Global Constraints

- Every device call goes through `state.request_device(method, path, body="")` or `state.patch_device(path, payload)->(status,body)`. Never call the device directly from a route.
- Every route requires auth via `_require_auth()` (401) exactly as `schedule.py`.
- Device refusals surfaced with the `_device_error(status, data)` pattern from `schedule.py` (device's own words on 400, 502 otherwise).
- Router prefix `/api/settings`; include plainly in `main.py` (no extra prefix, like `channels`).
- PATCH `/settings/info` is flat, one key per call; allow-list enforced backend-side.
- No-op routes return `{"ok": false, "noop": true, "reason": "..."}` with 200.
- Frontend fetches on modal open only; tolerant of null slices.

---

### Task 1: Backend settings reads

**Files:**
- Create: `backend/app/routes/settings.py`
- Modify: `backend/app/main.py:9,101-108` (import + include_router)
- Test: `backend/tests/test_settings.py`

**Interfaces:**
- Produces: router at `/api/settings` with `GET /overview`, `GET /info`, `GET /harddrives`, `GET /location`, `GET /guide-status`.
- `_require_auth()`, `_device_error(status,data)` copied/imported. `overview()` returns `{server, network, harddrives, guide, location, settings, update}` each `None` on sub-failure.

- [ ] **Step 1: Failing test — routes require auth**

```python
from fastapi.testclient import TestClient
from app.main import app
client = TestClient(app)

def test_settings_reads_require_auth():
    for path in ["/api/settings/overview", "/api/settings/info",
                 "/api/settings/harddrives", "/api/settings/location",
                 "/api/settings/guide-status"]:
        assert client.get(path).status_code == 401
```

- [ ] **Step 2: Run — FAIL (404, router absent)**

Run: `cd backend && .venv/bin/pytest tests/test_settings.py -v`

- [ ] **Step 3: Write router reads**

```python
"""Device settings: reads and writes over the Tablo settings surface.

Thin passthrough. Every device call is signed in state; nothing here talks to
the box directly. See docs/tablo-api.md for the endpoint map.
"""
import asyncio
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..state import state

router = APIRouter(prefix="/api/settings", tags=["settings"])

def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")

def _device_error(status: int, data: dict) -> HTTPException:
    if status == 400:
        description = ((data or {}).get("error") or {}).get("description")
        return HTTPException(status_code=400,
                             detail=description or "The Tablo refused the change.")
    return HTTPException(status_code=502, detail="The Tablo could not be reached.")

async def _try(method: str, path: str):
    """A tolerant read: a failing sub-fetch becomes None, not a 500."""
    try:
        return await state.request_device(method, path)
    except Exception:
        return None

@router.get("/overview")
async def overview():
    _require_auth()
    server, network, harddrives, guide, location, settings_info, update = (
        await asyncio.gather(
            _try("GET", "/server/info"),
            _try("GET", "/server/network"),
            _try("GET", "/server/harddrives"),
            _try("GET", "/server/guide/status"),
            _try("GET", "/server/location"),
            _try("GET", "/settings/info?allowAudioTranscode=true"),
            _try("GET", "/server/update/info"),
        )
    )
    return {"server": server, "network": network, "harddrives": harddrives,
            "guide": guide, "location": location, "settings": settings_info,
            "update": update}

@router.get("/info")
async def info():
    _require_auth()
    return await state.request_device("GET", "/settings/info?allowAudioTranscode=true")

@router.get("/harddrives")
async def harddrives():
    _require_auth()
    return await state.request_device("GET", "/server/harddrives")

@router.get("/location")
async def location():
    _require_auth()
    return await state.request_device("GET", "/server/location")

@router.get("/guide-status")
async def guide_status():
    _require_auth()
    return await state.request_device("GET", "/server/guide/status")
```

- [ ] **Step 4: Wire router in main.py**

Add `settings` to the `from .routes import ...` line and `app.include_router(settings.router)` beside the others.

- [ ] **Step 5: Run — PASS**

Run: `cd backend && .venv/bin/pytest tests/test_settings.py -v`

- [ ] **Step 6: Test — overview tolerates a failing sub-call**

```python
import pytest
from app.state import state as app_state

@pytest.fixture
def authed(monkeypatch):
    monkeypatch.setattr(type(app_state), "is_authenticated",
                        property(lambda self: True))

def test_overview_null_slice_on_failure(authed, monkeypatch):
    async def fake(method, path, body=""):
        if "harddrives" in path:
            raise RuntimeError("boom")
        return {"path": path}
    monkeypatch.setattr(app_state, "request_device", fake)
    r = client.get("/api/settings/overview")
    assert r.status_code == 200
    body = r.json()
    assert body["harddrives"] is None
    assert body["server"] == {"path": "/server/info"}
```

- [ ] **Step 7: Run — PASS. Commit.**

```bash
git add backend/app/routes/settings.py backend/app/main.py backend/tests/test_settings.py
git commit -m "feat(settings): backend read routes for the device settings surface"
```

---

### Task 2: Backend settings writes (info allow-list + rename)

**Files:**
- Modify: `backend/app/routes/settings.py`
- Test: `backend/tests/test_settings.py`

**Interfaces:**
- Produces: `PATCH /api/settings/info` (one allow-listed key), `PATCH /api/settings/name`.
- Consumes: `state.patch_device`, `_device_error`.

- [ ] **Step 1: Failing tests**

```python
def test_info_patch_rejects_unknown_key(authed, monkeypatch):
    called = {}
    async def fake_patch(path, payload):
        called["hit"] = True; return 200, {}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/info", json={"bogus": 1})
    assert r.status_code == 400
    assert "hit" not in called  # never reached the device

def test_info_patch_forwards_one_key(authed, monkeypatch):
    seen = {}
    async def fake_patch(path, payload):
        seen["path"], seen["payload"] = path, payload
        return 200, {"led": "dim"}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/info", json={"led": "dim"})
    assert r.status_code == 200
    assert seen == {"path": "/settings/info", "payload": {"led": "dim"}}

def test_led_bad_value_rejected(authed, monkeypatch):
    async def fake_patch(path, payload): return 200, {}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    assert client.patch("/api/settings/info", json={"led": "blinky"}).status_code == 400

def test_rename_forwards(authed, monkeypatch):
    seen = {}
    async def fake_patch(path, payload):
        seen["path"], seen["payload"] = path, payload
        return 200, {"name": "Den"}
    monkeypatch.setattr(app_state, "patch_device", fake_patch)
    r = client.patch("/api/settings/name", json={"name": "Den"})
    assert r.status_code == 200 and seen["path"] == "/server/info"
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement writes**

```python
_BOOL_KEYS = {"enable_amplifier", "exclude_duplicates",
              "extend_live_recordings", "auto_delete_recordings"}
_ENUM_KEYS = {"led": {"on", "dim", "off"}, "audio": {"ac3", "aac"}}

class InfoPatch(BaseModel):
    class Config: extra = "allow"

@router.patch("/info")
async def patch_info(body: dict):
    _require_auth()
    if len(body) != 1:
        raise HTTPException(400, "Send exactly one setting per request.")
    key, value = next(iter(body.items()))
    if key in _BOOL_KEYS:
        if not isinstance(value, bool):
            raise HTTPException(400, f"{key} must be a boolean.")
    elif key in _ENUM_KEYS:
        if value not in _ENUM_KEYS[key]:
            raise HTTPException(400, f"{key} must be one of {sorted(_ENUM_KEYS[key])}.")
    else:
        raise HTTPException(400, f"{key} is not a writable setting.")
    status, data = await state.patch_device("/settings/info", {key: value})
    if status >= 400:
        raise _device_error(status, data)
    return data

class NameIn(BaseModel):
    name: str

@router.patch("/name")
async def patch_name(body: NameIn):
    _require_auth()
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty.")
    status, data = await state.patch_device("/server/info", {"name": name})
    if status >= 400:
        raise _device_error(status, data)
    return data
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/settings.py backend/tests/test_settings.py
git commit -m "feat(settings): allow-listed device write routes (info toggles, rename)"
```

---

### Task 3: Backend channels lineup/scan + no-op routes

**Files:**
- Modify: `backend/app/routes/settings.py`
- Test: `backend/tests/test_settings.py`

**Interfaces:**
- Produces: `GET /channels`, `POST /channels/scan`, `GET /channels/scan/{id}`, `GET /channels/scan/{id}/discovered`, `POST /channels/commit`, plus no-op `POST /guide/update`, `PATCH /location`.

- [ ] **Step 1: Failing tests**

```python
def test_noop_guide_update(authed, monkeypatch):
    async def fake(*a, **k): raise AssertionError("must not touch device")
    monkeypatch.setattr(app_state, "request_device", fake)
    monkeypatch.setattr(app_state, "patch_device", fake)
    r = client.post("/api/settings/guide/update")
    assert r.status_code == 200 and r.json()["noop"] is True

def test_noop_location_set(authed, monkeypatch):
    async def fake(*a, **k): raise AssertionError("must not touch device")
    monkeypatch.setattr(app_state, "patch_device", fake)
    r = client.patch("/api/settings/location", json={"postal_code": "97201"})
    assert r.status_code == 200 and r.json()["noop"] is True

def test_commit_forwards_the_array(authed, monkeypatch):
    seen = {}
    async def fake_request(method, path, body=""):
        seen["method"], seen["path"], seen["body"] = method, path, body
        return {}
    monkeypatch.setattr(app_state, "request_device", fake_request)
    paths = ["/channels/scans/discovered/1", "/channels/scans/discovered/2"]
    r = client.post("/api/settings/channels/commit",
                    json={"scan_id": "77", "paths": paths})
    assert r.status_code == 200
    assert seen["method"] == "POST"
    assert seen["path"] == "/channels/scans/77/commit"
    import json as _j; assert _j.loads(seen["body"]) == paths
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

```python
import json as _json

@router.get("/channels")
async def channels_lineup():
    _require_auth()
    info = await state.request_device("GET", "/channels/info")
    committed = (info or {}).get("committed_scan")
    if not committed:
        return {"scan_id": None, "channels": []}
    scan_id = committed.rstrip("/").split("/")[-1]
    disc = await state.request_device("GET", f"/channels/scans/{scan_id}/discovered")
    paths = disc if isinstance(disc, list) else (disc or {}).get("discovered", [])
    async def one(p):
        cid = p.rstrip("/").split("/")[-1]
        rec = await _try("GET", f"/channels/scans/discovered/{cid}")
        ch = (rec or {}).get("channel") or {}
        return {"path": p, "channel_identifier": ch.get("channel_identifier"),
                "call_sign": ch.get("call_sign"), "resolution": ch.get("resolution"),
                "selected": (rec or {}).get("selected", True),
                "signal_state": (rec or {}).get("signal_state")}
    channels = await asyncio.gather(*[one(p) for p in paths])
    return {"scan_id": scan_id, "channels": channels}

@router.post("/channels/scan")
async def channels_scan_start():
    _require_auth()
    scan = await state.request_device("POST", "/channels/scans")
    return {"scan_id": scan.get("object_id"), "progress": scan.get("progress", 0.0),
            "completed": scan.get("completed", False)}

@router.get("/channels/scan/{scan_id}")
async def channels_scan_status(scan_id: str):
    _require_auth()
    scan = await state.request_device("GET", f"/channels/scans/{scan_id}")
    return {"progress": scan.get("progress", 0.0),
            "completed": scan.get("completed", False)}

@router.get("/channels/scan/{scan_id}/discovered")
async def channels_scan_discovered(scan_id: str):
    _require_auth()
    disc = await state.request_device("GET", f"/channels/scans/{scan_id}/discovered")
    paths = disc if isinstance(disc, list) else (disc or {}).get("discovered", [])
    async def one(p):
        cid = p.rstrip("/").split("/")[-1]
        rec = await _try("GET", f"/channels/scans/discovered/{cid}")
        ch = (rec or {}).get("channel") or {}
        return {"path": p, "channel_identifier": ch.get("channel_identifier"),
                "call_sign": ch.get("call_sign"), "resolution": ch.get("resolution"),
                "selected": (rec or {}).get("selected", True),
                "signal_state": (rec or {}).get("signal_state")}
    return {"channels": await asyncio.gather(*[one(p) for p in paths])}

class CommitIn(BaseModel):
    scan_id: str
    paths: list[str]

@router.post("/channels/commit")
async def channels_commit(body: CommitIn):
    _require_auth()
    await state.request_device("POST", f"/channels/scans/{body.scan_id}/commit",
                               _json.dumps(body.paths, separators=(",", ":")))
    return {"ok": True, "count": len(body.paths)}

@router.post("/guide/update")
async def guide_update():
    _require_auth()
    return {"ok": False, "noop": True,
            "reason": "no guide-refresh verb captured"}

class LocationIn(BaseModel):
    postal_code: str

@router.patch("/location")
async def set_location(body: LocationIn):
    _require_auth()
    return {"ok": False, "noop": True,
            "reason": "no location-set verb captured"}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/settings.py backend/tests/test_settings.py
git commit -m "feat(settings): channel lineup/scan/commit routes + no-op guide/location"
```

---

### Task 4: Frontend API client methods

**Files:**
- Modify: `frontend/src/api/tablo.ts` (add types + `api.settings` block near end of the `api` object)
- Test: none standalone (covered by component tests)

**Interfaces:**
- Produces: `api.settings.overview()`, `.patchInfo(key,value)`, `.rename(name)`, `.channels()`, `.startScan()`, `.scanStatus(id)`, `.scanDiscovered(id)`, `.commit(scanId, paths)`, `.guideUpdate()`, `.setLocation(postal)`.

- [ ] **Step 1: Add types + methods**

```typescript
export interface SettingsOverview {
  server: { name?: string; version?: string; build_number?: string;
            local_address?: string; server_id?: string;
            model?: { name?: string; tuners?: number } } | null;
  network: { ip?: string; connection?: string; status?: string } | null;
  harddrives: unknown | null;
  guide: { last_update?: string; limit?: string;
           download_progress?: number; guide_seeded?: boolean } | null;
  location: { state?: string; location?: Record<string, unknown>;
              timezone?: string } | null;
  settings: { led?: string; enable_amplifier?: boolean;
              exclude_duplicates?: boolean; extend_live_recordings?: boolean;
              auto_delete_recordings?: boolean; audio?: string } | null;
  update: { available_update?: unknown; state?: string;
            last_checked?: string } | null;
}
export interface LineupChannel {
  path: string; channel_identifier?: string; call_sign?: string;
  resolution?: string; selected: boolean; signal_state?: string;
}
```

Add to the `api` object:

```typescript
  settings: {
    overview: () => req<SettingsOverview>("/settings/overview"),
    patchInfo: (key: string, value: string | boolean) =>
      req<Record<string, unknown>>("/settings/info",
        { method: "PATCH", body: JSON.stringify({ [key]: value }) }),
    rename: (name: string) =>
      req<Record<string, unknown>>("/settings/name",
        { method: "PATCH", body: JSON.stringify({ name }) }),
    channels: () =>
      req<{ scan_id: string | null; channels: LineupChannel[] }>("/settings/channels"),
    startScan: () =>
      req<{ scan_id: string; progress: number; completed: boolean }>(
        "/settings/channels/scan", { method: "POST" }),
    scanStatus: (id: string) =>
      req<{ progress: number; completed: boolean }>(`/settings/channels/scan/${id}`),
    scanDiscovered: (id: string) =>
      req<{ channels: LineupChannel[] }>(`/settings/channels/scan/${id}/discovered`),
    commit: (scanId: string, paths: string[]) =>
      req<{ ok: boolean; count: number }>("/settings/channels/commit",
        { method: "POST", body: JSON.stringify({ scan_id: scanId, paths }) }),
    guideUpdate: () =>
      req<{ ok: boolean; noop: boolean; reason: string }>("/settings/guide/update",
        { method: "POST" }),
    setLocation: (postal_code: string) =>
      req<{ ok: boolean; noop: boolean; reason: string }>("/settings/location",
        { method: "PATCH", body: JSON.stringify({ postal_code }) }),
  },
```

- [ ] **Step 2: `cd frontend && npx tsc --noEmit` — PASS**

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/tablo.ts
git commit -m "feat(settings): api client methods for the settings surface"
```

---

### Task 5: Frontend SettingsModal component

**Files:**
- Create: `frontend/src/components/SettingsModal.tsx`
- Test: `frontend/src/__tests__/settingsModal.test.tsx`

**Interfaces:**
- Produces: `export function SettingsModal({ onClose }: { onClose: () => void })`.
- Consumes: `api.settings.*`.

Sections per spec: Storage, Device (LED/amp), Recording, Audio, Guide, Location, Channels, About. Overlay scaffolding copied from `ConfirmDialog.tsx:43-52` (fixed inset-0 z-[60] bg-scrim backdrop-blur, role=dialog aria-modal, Esc + scrim close, inner `bg-surface-raised border rounded-2xl` with `stopPropagation`). Fetch overview in a `useEffect` on mount; hold in state; render each section tolerant of null.

- [ ] **Step 1: Failing test — renders sections from a mocked overview**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, afterEach, test, expect } from "vitest";
import { SettingsModal } from "../components/SettingsModal";
import { api } from "../api/tablo";

afterEach(() => vi.restoreAllMocks());

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>
    <SettingsModal onClose={() => {}} /></QueryClientProvider>);
}

test("renders device name and firmware from overview", async () => {
  vi.spyOn(api.settings, "overview").mockResolvedValue({
    server: { name: "Den Tablo", version: "2.2.58", build_number: "1",
              local_address: "172.16.16.121", server_id: "SID123" },
    network: { ip: "172.16.16.121" }, harddrives: null,
    guide: { last_update: "2026-09-19T00:00:00Z", limit: "2026-10-01T00:00:00Z" },
    location: { state: "OR" },
    settings: { led: "dim", enable_amplifier: true, exclude_duplicates: true,
                extend_live_recordings: true, auto_delete_recordings: false,
                audio: "ac3" },
    update: null,
  } as never);
  vi.spyOn(api.settings, "channels").mockResolvedValue({ scan_id: null, channels: [] });
  renderModal();
  await waitFor(() => expect(screen.getByDisplayValue("Den Tablo")).toBeInTheDocument());
  expect(screen.getByText("2.2.58")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd frontend && npx vitest run src/__tests__/settingsModal.test.tsx`

- [ ] **Step 3: Implement the component** (full sections; toggles call `api.settings.patchInfo`; LED 3-way; audio toggle; guide Update calls `guideUpdate` and shows a "not yet available" note; location input + no-op Save; channels list with checkboxes + Rescan + Save→commit; About with inline rename→`api.settings.rename`). Storage renders a capacity bar from `harddrives` (capacity-only if no free field). Each write optimistic; resync from response.

- [ ] **Step 4: Run — PASS; `npx tsc --noEmit` clean**

- [ ] **Step 5: Test — a toggle fires the right PATCH**

```tsx
test("amplifier switch patches enable_amplifier", async () => {
  // overview mock as above; then
  const patch = vi.spyOn(api.settings, "patchInfo").mockResolvedValue({});
  // click the amplifier switch, assert:
  await waitFor(() => expect(patch).toHaveBeenCalledWith("enable_amplifier", false));
});
```

- [ ] **Step 6: Test — guide Update is a no-op toast, no device write**

```tsx
test("guide update calls the no-op route", async () => {
  const gu = vi.spyOn(api.settings, "guideUpdate")
    .mockResolvedValue({ ok: false, noop: true, reason: "x" });
  // click Update; assert gu called and a "not yet available" note appears
});
```

- [ ] **Step 7: Run — PASS. Commit.**

```bash
git add frontend/src/components/SettingsModal.tsx frontend/src/__tests__/settingsModal.test.tsx
git commit -m "feat(settings): the settings modal and its sections"
```

---

### Task 6: Gear entry in AppMenu + wire modal into ChannelGrid

**Files:**
- Modify: `frontend/src/components/AppMenu.tsx` (add gear "Settings" item; new prop `onOpenSettings`)
- Modify: `frontend/src/components/ChannelGrid.tsx:492-493` (hold `settingsOpen`, pass `onOpenSettings`, render `<SettingsModal>`)
- Test: `frontend/src/__tests__/settingsModal.test.tsx` (add: menu → open)

**Interfaces:**
- Consumes: `SettingsModal`. AppMenu gains `onOpenSettings: () => void`.

- [ ] **Step 1: Failing test — gear item opens the modal**

```tsx
// render ChannelGrid shell (see pageChrome.test.tsx mockShell/renderShell),
// open AppMenu, click "Settings", assert the dialog appears
test("app menu has a Settings gear that opens the modal", async () => { /* ... */ });
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Add a gear button to AppMenu's dropdown** (a menu item with a gear SVG + "Settings", `onClick={() => { setOpen(false); onOpenSettings(); }}`), placed above "Sign Out". Add `onOpenSettings` to props.

- [ ] **Step 4: In ChannelGrid** add `const [settingsOpen, setSettingsOpen] = useState(false);`, pass `onOpenSettings={() => setSettingsOpen(true)}` to `<AppMenu>`, and render `{settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}`.

- [ ] **Step 5: Run — PASS; full suite `npx vitest run`; `npx tsc --noEmit`**

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AppMenu.tsx frontend/src/components/ChannelGrid.tsx frontend/src/__tests__/settingsModal.test.tsx
git commit -m "feat(settings): gear entry in the app menu opens the settings modal"
```

---

### Task 7: Full verify + rebuild

- [ ] **Step 1:** `cd backend && .venv/bin/pytest` — all pass.
- [ ] **Step 2:** `cd frontend && npx vitest run && npx tsc --noEmit` — all pass, clean.
- [ ] **Step 3:** Merge worktree → main (no-ff), rebuild per `tablo-stack` skill (build frontend, `--force-recreate`, all 3 compose files, restart `run-native.sh`), run `check-stack.sh` (exit 0), confirm bundle hash changed.

## Self-Review

- Spec coverage: Storage(T1/T5), LED(T2/T5), amplifier(T2/T5), dup+extend+autodelete(T2/T5), audio(T2/T5), guide last-updated(T1/T5) + Update no-op(T3/T5), location read(T1/T5) + set no-op(T3/T5), channel scan/rescan(T3/T5), channel hide/select via commit(T3/T5), about name/rename(T1/T2/T5), ip/serial/fw(T1/T5), gear entry(T6). All covered.
- No placeholders in backend tasks (full code). Frontend component body (T5 step 3) is described not fully transcribed — acceptable: it is UI assembly over the already-specified api methods and section list; executor writes JSX to satisfy the listed tests.
- Type consistency: `LineupChannel`, `SettingsOverview` used consistently across T4/T5; `api.settings.*` names match between T4 and T5/T6.
