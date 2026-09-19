# Field Accounting and Device Pool Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every field that leaves the presenter's queue countable, log a held picture that still holds a non-empty queue, and let the backend recover from a dead device connection pool without a restart.

**Architecture:** Three independent changes. The presenter gains two counters (`skippedCount`, `tickCount`) and one derived measure (`nothingDueMs`), all computed where the field clock and the audio clock are the same quantity. The session reads them, asserts nothing, and reports them: a 5-second rollup line and a rising-edge `picture held` warning. The backend grows a second `httpx.AsyncClient` used only for device calls, with split timeouts and a generation-guarded reset-and-retry-once on transport failure.

**Tech Stack:** TypeScript, Vitest, React; Python 3, FastAPI, httpx, pytest.

**Spec:** `docs/superpowers/specs/2026-09-18-field-accounting-design.md`

**Status:** Tasks 1–4 implemented on branch `field-accounting`. Task 5 —
merge, build, deploy — deliberately not run: the user asked for the work to be
finished on the branch and merged separately.

## Global Constraints

- The app has **no authentication and wildcard CORS**. It stays bound to `127.0.0.1` via the gitignored `docker-compose.override.yml`. Do not add a network binding.
- Type-check with `npx tsc -b`, never `npx tsc --noEmit` — the latter skips test files and has passed while the Docker build failed.
- `npx eslint src` has **2 pre-existing errors** (`ChannelGrid.tsx`, `useMediaQuery.ts`) and 2 warnings on main. That is the baseline; do not claim lint is clean, and do not fix them here.
- jsdom has no layout: `getBoundingClientRect().width` is `0`. It has no `matchMedia` and no `captureStream`.
- The presenter's `deps.now()` is the **raw sink clock** (`audio.clockSeconds`). The session's `mediaClock()` is that plus `ptsOffset`. Never compare a value from one against a value from the other.
- Run the full frontend suite with `npx vitest run` from `frontend/`. Baseline is 626 passing.
- Backend tests: `python -m pytest` from `backend/`.

---

### Task 1: Count the fields `selectFrame` skips, and count ticks

**Files:**
- Modify: `frontend/src/lib/wasmlive/presenter.ts`
- Test: `frontend/src/__tests__/wasmlivePresenter.test.ts`

**Interfaces:**
- Consumes: `selectFrame(queue, clockSeconds): { present, drop, keep }` from `frontend/src/lib/wasmlive/frameQueue.ts` — `drop` is already returned and already correct; this task stops ignoring it.
- Produces: on the `Presenter` interface, `readonly skippedCount: number` and `readonly tickCount: number`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("createPresenter", ...)` block in `frontend/src/__tests__/wasmlivePresenter.test.ts`:

```ts
  it("counts the fields it skipped past, so no field leaves the queue uncounted", () => {
    const { presenter, drawn, setClock } = harness();
    // Three frames, six fields, spanning about a tenth of a second.
    presenter.offer(decoded(1));
    presenter.offer(decoded(1 + FRAME));
    presenter.offer(decoded(1 + FRAME * 2));
    expect(presenter.queued).toBe(6);

    // One tick, arriving after every one of them is due: the newest is drawn
    // and the other five are passed over. Before this change those five
    // vanished without a number attached to them.
    setClock(1 + FRAME * 3);
    presenter.tick();

    expect(drawn).toHaveLength(1);
    expect(presenter.presentedCount).toBe(1);
    expect(presenter.skippedCount).toBe(5);
    expect(presenter.queued).toBe(0);
  });

  it("accounts for every field offered: drawn, skipped, refused, or still queued", () => {
    const { presenter, setClock } = harness();
    // More frames than the cap can hold, so admission refuses some too, and
    // all three exits are exercised at once.
    const frames = MAX_QUEUED_FRAMES; // 2 fields each, so twice the cap offered
    for (let i = 0; i < frames; i++) presenter.offer(decoded(1 + FRAME * i));
    const offered = frames * 2;

    setClock(1 + FRAME * 10);
    presenter.tick();
    setClock(1 + FRAME * 20);
    presenter.tick();

    expect(
      presenter.presentedCount + presenter.skippedCount
        + presenter.droppedCount + presenter.queued,
    ).toBe(offered);
  });

  it("counts every tick, including the ones with nothing due", () => {
    const { presenter, setClock } = harness();
    presenter.offer(decoded(1));
    // Clock behind the fields: nothing is due, nothing is drawn, but the
    // animation frame still happened and that is the quantity being measured.
    setClock(0.5);
    presenter.tick();
    presenter.tick();
    expect(presenter.presentedCount).toBe(0);
    expect(presenter.tickCount).toBe(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/__tests__/wasmlivePresenter.test.ts
```

Expected: FAIL. `presenter.skippedCount` and `presenter.tickCount` are `undefined`, so the assertions report `undefined` against a number.

- [ ] **Step 3: Add the counters**

In `frontend/src/lib/wasmlive/presenter.ts`, add to the `Presenter` interface, directly beneath the existing `droppedCount` declaration:

```ts
  /**
   * Fields passed over because a newer one was also due. Not a hole in the
   * timeline — the picture stayed on the clock — but the difference between
   * `presentedCount` and the field rate, and so the measure of whether ticks
   * are arriving as fast as fields are.
   */
  readonly skippedCount: number;
  /** Calls to `tick()`: how often there was a chance to draw at all. */
  readonly tickCount: number;
```

Add to the local state at the top of `createPresenter`, beside `let dropped = 0;`:

```ts
  let skipped = 0;
  let ticks = 0;
```

In `tick()`, increment `ticks` on the first line of the body, before the `deps.nowMs?.()` call:

```ts
      ticks++;
```

Replace the destructuring at the selection site:

```ts
      const { present, drop, keep } = selectFrame(queue, clock);
      queue = keep;
      skipped += drop.length;
      if (!present) return;
```

Add the two getters beside `droppedCount`:

```ts
    get skippedCount() {
      return skipped;
    },

    get tickCount() {
      return ticks;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/__tests__/wasmlivePresenter.test.ts
```

Expected: PASS, including the pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/presenter.ts frontend/src/__tests__/wasmlivePresenter.test.ts
git commit -m "Count the fields the presenter skips past"
```

---

### Task 2: Measure a picture held while fields are still in hand

**Files:**
- Modify: `frontend/src/lib/wasmlive/presenter.ts`
- Test: `frontend/src/__tests__/wasmlivePresenter.test.ts`

**Interfaces:**
- Consumes: `PresenterDeps.nowMs?(): number` — already declared, already optional, currently used only for `msSinceTick`.
- Produces: `readonly nothingDueMs: number` on `Presenter`. Milliseconds since the last draw, during which the clock has been running and the queue non-empty. `0` whenever a draw happens, whenever the queue is empty, and whenever the clock is `null`.

- [ ] **Step 1: Write the failing test**

The existing `harness` does not supply `nowMs`, so this test needs its own. Append to `frontend/src/__tests__/wasmlivePresenter.test.ts`:

```ts
  it("reports how long the picture has held while fields are still queued", () => {
    let clock = 0;
    let wall = 0;
    const presenter = createPresenter({
      now: () => clock,
      nowMs: () => wall,
      upload: () => {},
      draw: () => {},
    });

    // A field due now, and a second one a full second later — the shape of a
    // hole in the middle of a segment. The queue never empties, so
    // `waiting for fields` never fires, and before this change nothing at all
    // was recorded until the six-second watchdog.
    presenter.offer(decoded(1, { interlaced: false }));
    presenter.offer(decoded(2, { interlaced: false }));

    clock = 1;
    wall = 1000;
    presenter.tick();
    expect(presenter.presentedCount).toBe(1);
    expect(presenter.nothingDueMs).toBe(0);

    // A quarter of a second later the clock has moved and the queue is not
    // empty, but nothing in it is due yet.
    clock = 1.25;
    wall = 1250;
    presenter.tick();
    expect(presenter.queued).toBe(1);
    expect(presenter.nothingDueMs).toBe(250);

    // The second field arrives at its moment and the measure resets.
    clock = 2;
    wall = 2000;
    presenter.tick();
    expect(presenter.presentedCount).toBe(2);
    expect(presenter.nothingDueMs).toBe(0);
  });

  it("reports nothing held when the queue is empty, which is a different failure", () => {
    let clock = 0;
    let wall = 0;
    const presenter = createPresenter({
      now: () => clock,
      nowMs: () => wall,
      upload: () => {},
      draw: () => {},
    });
    presenter.offer(decoded(1, { interlaced: false }));
    clock = 1;
    wall = 1000;
    presenter.tick();

    // Queue empty: this is starvation, which `waiting for fields` already
    // names. Reporting it twice under two names would make one stall look
    // like two problems.
    clock = 3;
    wall = 3000;
    presenter.tick();
    expect(presenter.queued).toBe(0);
    expect(presenter.nothingDueMs).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/__tests__/wasmlivePresenter.test.ts
```

Expected: FAIL with `presenter.nothingDueMs` `undefined`.

- [ ] **Step 3: Implement**

In `frontend/src/lib/wasmlive/presenter.ts`, add to the `Presenter` interface beneath `msSinceTick`:

```ts
  /**
   * Milliseconds the picture has held while fields were still queued.
   *
   * A hole in the middle of a segment does not empty the queue — it leaves it
   * full of fields whose moment has not come — so `waiting for fields`, which
   * fires on an empty queue, never sees it. The clock runs, nothing is due,
   * the picture holds, and the only thing that eventually notices is the
   * six-second watchdog. Zero when the queue is empty: that is starvation,
   * which already has a name.
   */
  readonly nothingDueMs: number;
```

Add to the local state beside `let stillShown`:

```ts
  /** Wall clock at the last draw, so a held picture can be timed. */
  let lastDrawMs: number | null = null;
  let heldMs = 0;
```

In `tick()`, in the `clock === null` branch, reset the measure before returning — a stopped clock is a pause, not a hole. Insert immediately after `if (clock === null) {`:

```ts
        heldMs = 0;
        lastDrawMs = at;
```

Then replace the tail of `tick()` — from `if (!present) return;` to the end of the method — with:

```ts
      if (!present) {
        // Held only when there is something in hand to draw. An empty queue is
        // starvation and is reported elsewhere.
        heldMs = queue.length > 0 && lastDrawMs !== null ? at - lastDrawMs : 0;
        return;
      }

      if (uploaded !== present.source) {
        deps.upload(present.source);
        uploaded = present.source;
      }
      deps.draw(present);
      presented++;
      lastDrawMs = at;
      heldMs = 0;
```

Add the getter beside `msSinceTick`:

```ts
    get nothingDueMs() {
      return heldMs;
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/__tests__/wasmlivePresenter.test.ts
```

Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wasmlive/presenter.ts frontend/src/__tests__/wasmlivePresenter.test.ts
git commit -m "Measure a picture held with fields still queued"
```

---

### Task 3: Report the decomposition — rollup line, held-picture warning, diagnostics

**Files:**
- Modify: `frontend/src/lib/wasmlive/session.ts`
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

**Interfaces:**
- Consumes: `presenter.skippedCount`, `presenter.tickCount`, `presenter.nothingDueMs` from Tasks 1 and 2; `deps.nowMs()`, already used by `tick()`.
- Produces: nothing other code calls. Two console lines and three diagnostics fields.

**Note on the test stub:** `frontend/src/__tests__/wasmliveSession.test.ts` builds its presenter by hand rather than with `createPresenter`. Adding a field to the `Presenter` interface breaks that stub at compile time, not at run time, so `npx vitest run` can pass while `npx tsc -b` fails. Step 1 updates the stub.

- [ ] **Step 1: Extend the hand-rolled presenter stub**

In `frontend/src/__tests__/wasmliveSession.test.ts`, find the object literal that stands in for the presenter (it declares `presentedCount`, `droppedCount`, `msSinceTick`, `queued`). Add three fields to it, matching the style already there:

```ts
    skippedCount: 0,
    tickCount: 0,
    nothingDueMs: 0,
```

If the stub is built by a factory function with mutable locals, add the three as mutable locals with getters, following whatever pattern the neighbouring counters use.

- [ ] **Step 2: Write the failing test**

Append to `frontend/src/__tests__/wasmliveSession.test.ts`, inside the top-level `describe`:

```ts
  it("warns once when the picture holds with fields still queued", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const h = harness();
    await h.start();

    // Playing normally: nothing held, nothing said.
    h.presenter.nothingDueMs = 0;
    h.presenter.queued = 40;
    h.tick();
    expect(warn.mock.calls.filter(([m]) => m === "picture held")).toHaveLength(0);

    // A hole: the clock runs, forty fields are in hand, none of them is due.
    h.presenter.nothingDueMs = 250;
    h.tick();
    const held = warn.mock.calls.filter(([m]) => m === "picture held");
    expect(held).toHaveLength(1);
    expect(held[0][1]).toMatchObject({ heldMs: 250, queued: 40 });

    // Still held on the next tick. One event, not one per animation frame.
    h.presenter.nothingDueMs = 280;
    h.tick();
    expect(warn.mock.calls.filter(([m]) => m === "picture held")).toHaveLength(1);

    // Recovered, then held again: a second event.
    h.presenter.nothingDueMs = 0;
    h.tick();
    h.presenter.nothingDueMs = 300;
    h.tick();
    expect(warn.mock.calls.filter(([m]) => m === "picture held")).toHaveLength(2);

    warn.mockRestore();
    h.stop();
  });
```

Match `harness()`, `h.tick()`, `h.start()` and `h.stop()` to whatever the existing tests in that file use — do not invent new helpers. If the file's harness advances the clock through a fake `nowMs`, drive `nowMs` forward between ticks the same way the neighbouring tests do. `log` is imported in that file already; if not, add `import { log } from "../lib/debug";`.

- [ ] **Step 3: Run it to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/wasmliveSession.test.ts
```

Expected: FAIL — `held` has length 0, because nothing emits `picture held`.

- [ ] **Step 4: Add the held-picture edge**

In `frontend/src/lib/wasmlive/session.ts`, add a constant beside `FROZEN_MS` (line 31):

```ts
/**
 * How long the picture may hold with fields still queued before it is worth a
 * line in the log. Three field periods at 59.94, so ordinary jitter is quiet.
 */
const HELD_MS = 100;
```

Add a mutable beside `wasStalled` (search for `let wasStalled`):

```ts
let wasHeld = false;
```

In `tick()`, immediately after the block that emits `waiting for fields` / `playing` (after its closing `}` and the `emit(...)` call), insert:

```ts
    // A hole in the middle of a segment does not empty the queue, so the stall
    // edge above never sees it: the clock runs, the fields in hand are all in
    // the future, and the picture holds. That is the shape of a stutter you can
    // hear and cannot find, and until now nothing recorded it before the
    // six-second watchdog.
    const held = !paused && sawAudio && deps.presenter.nothingDueMs > HELD_MS;
    if (held !== wasHeld) {
      wasHeld = held;
      if (held) {
        log.warn("picture held", {
          heldMs: Math.round(deps.presenter.nothingDueMs),
          queued: deps.presenter.queued,
          oldestPts: deps.presenter.oldestPts,
          newestPts: deps.presenter.newestPts,
          rawClock: deps.audio.clockSeconds,
          clock: mediaClock(),
          ptsOffset,
          msSinceTick: Math.round(deps.presenter.msSinceTick),
          buffered: Number(deps.audio.bufferedSeconds.toFixed(2)),
          fedThroughMedia,
        });
      }
    }
```

No `emit()` call: this is not a stall as far as the UI is concerned, and raising the overlay for a 250ms hole would be worse than the hole.

- [ ] **Step 5: Run it to verify it passes**

```bash
cd frontend && npx vitest run src/__tests__/wasmliveSession.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add the rollup line and the diagnostics fields**

Still in `frontend/src/lib/wasmlive/session.ts`. Add a constant beside `HELD_MS`:

```ts
/** How often to report where the fields went. */
const ROLLUP_MS = 5000;
```

Add mutables beside `wasHeld`:

```ts
let rollupAtMs = 0;
let rollupMark = { presented: 0, skipped: 0, dropped: 0, ticks: 0 };
```

In `tick()`, at the very end of the function body, insert:

```ts
    // Where the fields went, as rates rather than as totals.
    //
    // Every real finding in this area came from a number the user pasted into
    // the conversation; every wrong one came from reasoning about a log that
    // lacked it. `presented` alone counts ticks that drew, not fields consumed,
    // and reading it as a field rate is how a phantom "the presenter is drawing
    // a fiftieth of what it should" survived a whole evening.
    if (rollupAtMs === 0) rollupAtMs = nowMs;
    else if (nowMs - rollupAtMs >= ROLLUP_MS) {
      const span = (nowMs - rollupAtMs) / 1000;
      const per = (n: number) => Math.round(n / span);
      log.wasm("fields", {
        drawn: per(deps.presenter.presentedCount - rollupMark.presented),
        skipped: per(deps.presenter.skippedCount - rollupMark.skipped),
        refused: per(deps.presenter.droppedCount - rollupMark.dropped),
        ticks: per(deps.presenter.tickCount - rollupMark.ticks),
        queued: deps.presenter.queued,
        buffered: Number(deps.audio.bufferedSeconds.toFixed(2)),
      });
      rollupAtMs = nowMs;
      rollupMark = {
        presented: deps.presenter.presentedCount,
        skipped: deps.presenter.skippedCount,
        dropped: deps.presenter.droppedCount,
        ticks: deps.presenter.tickCount,
      };
    }
```

In the `diagnostics: () => ({ ... })` object, beside `droppedFields`, add:

```ts
      skippedFields: deps.presenter.skippedCount,
      ticks: deps.presenter.tickCount,
      heldMs: Math.round(deps.presenter.nothingDueMs),
```

And in the `waiting for fields` warning payload, beside `droppedFields:`, add:

```ts
          skippedFields: deps.presenter.skippedCount,
          ticks: deps.presenter.tickCount,
```

- [ ] **Step 7: Run the full frontend suite and the type build**

```bash
cd frontend && npx vitest run && npx tsc -b
```

Expected: all tests pass (baseline 626, plus the six added in Tasks 1–3), and `tsc -b` exits 0. `tsc -b` is the one that checks the test files; `--noEmit` does not, and has passed while the Docker build failed.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/wasmlive/session.ts frontend/src/__tests__/wasmliveSession.test.ts
git commit -m "Report where the fields went"
```

---

### Task 4: A device HTTP client that recovers from a dead pool

**Files:**
- Modify: `backend/app/state.py` (constructor near line 156; `_request_device_raw` at 386; `patch_device` at 417)
- Test: `backend/tests/test_device_pool.py` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks. Independent of Tasks 1–3.
- Produces: on `AppState` — `self._device_http: httpx.AsyncClient`, `async def _reset_device_http(self, generation: int) -> None`, and the exception class `DeviceUnreachable(RuntimeError)` at module level in `backend/app/state.py`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_device_pool.py`:

```python
"""The device pool recovers from a link that dropped under it.

The Tablo is reached over Tailscale. When that link goes away, the pooled
connections are dead but still handed out, so every device call sits until its
timeout and fails - with a ``ReadTimeout`` whose ``str()`` is the empty string,
which reached the viewer as the complete sentence ``Device error: ``. Database
routes kept answering in milliseconds throughout, which is how it was found.
Restarting the backend cleared it, and all restarting did was build a new pool.
"""

import asyncio

import httpx
import pytest

from app.state import AppState, DeviceUnreachable
from tablo_api import TabloDevice


class FakeResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return {"ok": True}


class FakeClient:
    """Fails its first N requests with a transport error, then succeeds."""

    instances: list["FakeClient"] = []

    def __init__(self, fail_times: int = 0, **_kwargs):
        self.fail_times = fail_times
        self.requests = 0
        self.closed = False
        FakeClient.instances.append(self)

    async def request(self, *_args, **_kwargs):
        self.requests += 1
        if self.requests <= self.fail_times:
            raise httpx.ReadTimeout("")
        return FakeResponse()

    async def aclose(self):
        self.closed = True


@pytest.fixture
def app_state(monkeypatch):
    state = AppState()
    state.active_device = TabloDevice(
        server_id="sid", name="Tablo", local_url="http://127.0.0.1:8885"
    )
    monkeypatch.setattr(
        "app.state.TabloAuth.make_device_auth",
        staticmethod(lambda *a, **k: ("auth", "date")),
        raising=False,
    )
    FakeClient.instances.clear()
    return state


def test_a_dead_pool_is_replaced_and_the_call_retried(app_state, monkeypatch):
    first = FakeClient(fail_times=1)
    second = FakeClient(fail_times=0)
    clients = iter([second])
    app_state._device_http = first
    monkeypatch.setattr("app.state.httpx.AsyncClient", lambda **kw: next(clients))

    result = asyncio.run(app_state.request_device("GET", "/server/info"))

    assert result == {"ok": True}
    assert first.closed, "the dead pool must be closed, not merely dropped"
    assert second.requests == 1, "the retry goes out on the new pool"


def test_a_second_failure_says_what_failed(app_state, monkeypatch):
    first = FakeClient(fail_times=2)
    second = FakeClient(fail_times=2)
    clients = iter([second])
    app_state._device_http = first
    monkeypatch.setattr("app.state.httpx.AsyncClient", lambda **kw: next(clients))

    with pytest.raises(DeviceUnreachable) as excinfo:
        asyncio.run(app_state.request_device("GET", "/server/info"))

    # The whole point: ``Device error: `` was the entire message the viewer got,
    # because ``str(ReadTimeout(""))`` is the empty string.
    message = str(excinfo.value)
    assert message.strip(), "the message must not be empty"
    assert "/server/info" in message
    assert "GET" in message


def test_concurrent_failures_rebuild_the_pool_once(app_state, monkeypatch):
    # A guide build fails a dozen calls at once. Without the generation guard
    # each one swaps in its own client and the retries scatter across a dozen
    # fresh pools.
    first = FakeClient(fail_times=12)
    replacements = [FakeClient(fail_times=0) for _ in range(12)]
    clients = iter(replacements)
    app_state._device_http = first
    monkeypatch.setattr("app.state.httpx.AsyncClient", lambda **kw: next(clients))

    async def run():
        return await asyncio.gather(
            *(app_state.request_device("GET", f"/p{i}") for i in range(12))
        )

    asyncio.run(run())

    built = [c for c in replacements if c.requests > 0]
    assert len(built) == 1, f"rebuilt the pool {len(built)} times, expected once"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && python -m pytest tests/test_device_pool.py -v
```

Expected: FAIL at import — `cannot import name 'DeviceUnreachable' from 'app.state'`.

- [ ] **Step 3: Implement the device client**

In `backend/app/state.py`, add at module level, beside `GuideFetchIncomplete`:

```python
class DeviceUnreachable(RuntimeError):
    """A device call failed at the transport, twice, on two different pools.

    Raised rather than letting the httpx exception through, because the one
    that matters here carries no message at all: ``str(httpx.ReadTimeout(""))``
    is the empty string, and the route handlers format failures as
    ``f"Device error: {e}"`` - so a dropped link reached the viewer as
    ``Device error: `` and nothing else.
    """
```

In `AppState.__init__`, beside `self._http = httpx.AsyncClient(timeout=30)`:

```python
        # A second client, used only for the local device.
        #
        # Separate from `_http` so that recovering from a dead device pool does
        # not abort in-flight cloud requests: the observed failure was
        # device-only, with cloud and database routes answering in
        # milliseconds throughout. Separate timeouts for the same reason - a
        # device call that has not answered in ten seconds is not going to, and
        # the flat thirty seconds meant every call sat for half a minute before
        # admitting the link was gone.
        self._device_http = httpx.AsyncClient(timeout=self._DEVICE_TIMEOUT)
        self._device_generation = 0
        self._device_lock = asyncio.Lock()
```

Add the timeout as a class attribute beside `_GRID_CACHE_TTL`:

```python
    _DEVICE_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)
```

Add the reset helper as a method on `AppState`, directly above `_request_device_raw`:

```python
    async def _reset_device_http(self, generation: int) -> None:
        """Swap in a fresh device pool, once, however many callers ask.

        A guide build fails a dozen calls at once when the link drops. Each one
        arrives here wanting a new pool; the generation it saw before it failed
        says whether someone else has already built one. Without this guard the
        twelve retries go out on twelve different pools.
        """
        async with self._device_lock:
            if generation != self._device_generation:
                return
            old = self._device_http
            self._device_http = httpx.AsyncClient(timeout=self._DEVICE_TIMEOUT)
            self._device_generation += 1
        await old.aclose()
```

Replace the body of `_request_device_raw` from `url = ...` to `return resp` with:

```python
        url = self.active_device.local_url.rstrip("/") + path
        headers = {
            "Authorization": auth_header,
            "Date": date_header,
            "User-Agent": "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)",
        }

        started = time.monotonic()
        for attempt in (0, 1):
            generation = self._device_generation
            client = self._device_http
            try:
                resp = await client.request(
                    method,
                    url,
                    content=body.encode() if body else None,
                    headers=headers,
                    follow_redirects=follow_redirects,
                )
            except httpx.TransportError as e:
                # Covers timeouts, connect errors, read errors and pool
                # timeouts: every way a pool of dead keep-alive connections
                # fails. A fresh connection is the fix, which is all that
                # restarting the backend was doing.
                if attempt == 0:
                    await self._reset_device_http(generation)
                    continue
                elapsed = time.monotonic() - started
                raise DeviceUnreachable(
                    f"{method} {path} failed after {elapsed:.1f}s on two"
                    f" connections: {type(e).__name__}"
                ) from e
            resp.raise_for_status()
            return resp
```

Change `patch_device`'s request to use the device client — replace `resp = await self._http.request(` at line 439 with `resp = await self._device_http.request(`.

Add `import time` to the imports at the top of the file if it is not already there. `asyncio` is already imported.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_device_pool.py -v
```

Expected: PASS, all three.

- [ ] **Step 5: Run the whole backend suite**

```bash
cd backend && python -m pytest -q
```

Expected: no new failures against the baseline. Note the baseline count before changing anything if you have not already.

- [ ] **Step 6: Commit**

```bash
git add backend/app/state.py backend/tests/test_device_pool.py
git commit -m "Rebuild the device pool when the link drops under it"
```

---

### Task 5: Merge, build, deploy, verify

**Files:** none modified.

- [ ] **Step 1: Rebase onto current main**

Several sessions share this repo and `main` moves under you.

```bash
git -C /Users/peet/GitHub/tablo-field-accounting fetch origin
git -C /Users/peet/GitHub/tablo-field-accounting rebase origin/main
```

- [ ] **Step 2: Re-run both suites after the rebase**

```bash
cd frontend && npx vitest run && npx tsc -b
cd ../backend && python -m pytest -q
```

Expected: green. A rebase that brings in another session's work can break a test that passed before it.

- [ ] **Step 3: Scan the diff for secrets before it leaves the worktree**

```bash
git -C /Users/peet/GitHub/tablo-field-accounting diff origin/main -- . \
  | grep -inE 'password|tskey-auth|secret|token|api[_-]?key' || echo "clean"
```

Read any hit. Nothing in this change should touch credentials.

- [ ] **Step 4: Merge to main and push**

```bash
git -C /Users/peet/GitHub/tablo-web checkout main
git -C /Users/peet/GitHub/tablo-web pull --ff-only
git -C /Users/peet/GitHub/tablo-web merge --no-ff field-accounting \
  -m "Merge field accounting and device pool recovery"
git -C /Users/peet/GitHub/tablo-web push origin main
```

- [ ] **Step 5: Build and deploy**

**REQUIRED SUB-SKILL:** invoke the `tablo-stack` skill before running any compose command. Its failure mode is silent.

Force recreation. The container has twice served a stale bundle while the health check reported success.

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
```

- [ ] **Step 6: Verify the served bundle is the built bundle**

Do not trust `check-stack.sh` alone on this point — it has reported "runs the image that was last built" while the browser was being served the previous one.

```bash
curl -s http://127.0.0.1:7070/ | grep -oE 'index-[A-Za-z0-9_-]*\.js'
docker run --rm --entrypoint sh tablo-web-frontend:local \
  -c 'ls /usr/share/nginx/html/assets | grep -o "index-[A-Za-z0-9_-]*\.js"'
```

Expected: the two hashes are identical. Then confirm the change is actually in the served asset:

```bash
curl -s "http://127.0.0.1:7070/assets/$(curl -s http://127.0.0.1:7070/ \
  | grep -oE 'index-[A-Za-z0-9_-]*\.js')" | grep -c 'picture held'
```

Expected: at least 1.

- [ ] **Step 7: Restart the backend so the new pool code is live**

The backend runs natively, not in the container, so a compose deploy does not touch it. Restart it the way `backend/run-native.sh` starts it, and confirm a device route answers quickly:

```bash
time curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/devices
```

Expected: `200` in well under a second.

- [ ] **Step 8: Remove the worktree**

```bash
git -C /Users/peet/GitHub/tablo-web worktree remove /Users/peet/GitHub/tablo-field-accounting
git -C /Users/peet/GitHub/tablo-web branch -d field-accounting
```

- [ ] **Step 9: Report what was not verified**

State plainly which of these were exercised against the real device and which were only exercised against tests. As of writing, nothing in Task 4 has been tested against an actual dropped Tailscale link, and the rollup numbers in Task 3 have never been seen on real playback — reading them is the next session's first job.
