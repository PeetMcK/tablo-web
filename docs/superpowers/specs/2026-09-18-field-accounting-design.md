# Counting what the picture loses, and not wedging on a dead link

**Date:** 2026-09-18
**Status:** approved

Three changes that share a theme: a failure currently has no number attached to
it, so every discussion of it is an argument rather than an arithmetic.

---

## 1. Fields leave the queue three ways and only two are counted

`presenter.tick()` draws at most one field per animation frame. `selectFrame`
(`frameQueue.ts:72`) returns the newest field that is due, plus `drop` — every
field it passed over on the way. `presenter.ts:135` destructures
`{ present, keep }`. **`drop` is discarded uncounted.**

So a field exits the queue by one of:

| exit | counter |
|---|---|
| drawn | `presentedCount` |
| refused at admission, queue full | `droppedCount` |
| **skipped by `selectFrame`** | **none** |

`presentedCount` therefore counts *ticks that drew*, not fields consumed.
Dividing it by elapsed audio time yields draws per second, and the resulting
figures — 19/s on 1080i, 3.1/s on 480i, against an offered 59.94 — were read
last night as "the presenter is drawing a fraction of what it should". That
reading cannot be supported by the number: the number never measured it.

The 3.1/s figure is, to one decimal, the pre-fix measurement already recorded at
`frameQueue.ts:95` from the old evict-from-the-front bug in `admit`. That log
predates the fix. It is stale and should not be reasoned from.

What remains true is that 19 draws a second is 19 motion updates a second, which
is visible judder, and nothing on hand says why. The decomposition does:

```
offered = presented + skipped + refused + queued
```

an exact invariant, with each term attributable:

- **skipped high** — ticks are arriving below the field rate. Animation frames
  throttled, main thread busy, an occluded window.
- **refused high** — the transport feeds further ahead than the cap holds.
- **offered low** — the decoder is not producing.

### Decision

Count `drop.length` as `skippedCount`, count entries to `tick()` as `tickCount`,
expose both, assert the invariant in a test, and emit a periodic rollup so the
answer appears in a console paste without anyone calling `tabloDebug()`.

The rollup is deliberate. Every real finding in this area came from a number the
user pasted; every wrong one came from reasoning about a log that lacked it.

Rollup every 5s while playing, as deltas over the interval:

```
fields  drawn 57/s  skipped 2/s  refused 0/s  ticks 59/s  queued 118
```

Not added: a frames-per-second gauge in the UI. Nobody asked for one and it
would need a design.

---

## 2. A freeze holding a full queue leaves no trace

`waiting for fields` fires on the edge of `queued === 0` (`session.ts:759`). A
hole in the middle of a segment does not empty the queue — it leaves it full of
fields whose timestamps are still in the future. The clock runs, nothing is due,
the picture holds, and nothing is logged until the 6s `FROZEN_MS` watchdog gives
up and falls the session back. That is the exact shape of a short stutter you
can hear and never find.

### Decision

Measure it where both quantities live in one clock. The presenter compares field
pts against `deps.now()`, which `open.ts` supplies as `audio.clockSeconds` — the
*raw sink clock*. The session's `mediaClock()` is that plus `ptsOffset`.
Comparing `presenter.oldestPts` against `mediaClock()` from the session would
repeat precisely the mistake that produced a phantom three-second clock jump
last night.

So the presenter computes it: `nothingDueMs`, milliseconds since the last draw
during which the clock has been running and the queue has been non-empty. Zero
whenever a draw happens, and zero whenever the queue is empty — that case is
already `waiting for fields` and does not need a second name.

The session logs the rising edge past 100ms as `picture held`, with the same
context block the stall line carries.

---

## 3. The device pool wedges on a dropped link

`state.py:156` is a single `httpx.AsyncClient(timeout=30)` shared by device and
cloud calls, with the default keep-alive pool and no retry. The Tablo is reached
over Tailscale at ~100ms RTT. When that link drops, the pooled connections are
dead but still handed out, so every device call sits for the full 30 seconds and
raises `ReadTimeout` — whose `str()` is the **empty string**, surfacing to the
viewer as `Device error: ` and, in the browser, as
`AbortError: BodyStreamBuffer was aborted`. Database-backed routes answer in 2ms
throughout, which is the giveaway and was how it was found. Restarting the
backend clears it.

### Decisions

**A separate client for the device.** The cloud client keeps its 30s timeout and
its pool untouched. Resetting a shared pool would abort in-flight cloud requests
to fix a device problem, and the observed failure was device-only.

**Split timeouts:** connect 5s, read 10s, write 10s, pool 5s. A device call that
has not answered in ten seconds is not going to.

**Reset then one retry.** On a transport failure — `httpx.TransportError` covers
timeouts, connect errors, read errors and pool timeouts — close the device pool,
build a new client, retry once. A dead pool is the failure; a fresh connection is
the fix, and that is what restarting the backend was doing by hand.

**One reset under concurrency.** A guide build fails a dozen calls at once.
Rebuilds are guarded by a generation counter under a lock: the first failure
swaps the client and bumps the generation; the rest see a generation that has
already moved and reuse the new client rather than churning it.

**A message that says something.** The second failure raises `DeviceUnreachable`
with the method, path and elapsed seconds, so `Device error: ` stops being the
whole sentence.

Not doing: a circuit breaker, backoff, or health polling. One retry on a fresh
connection covers the observed failure; the rest is speculative.
