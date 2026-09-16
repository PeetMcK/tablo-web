# Live Programme Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live scrubber spans the airing being watched, with the DVR window drawn as a band inside it — joining an 8:00–9:00 show at 8:15 puts the playhead a quarter along.

**Architecture:** One anchor ties media time to wall clock, established when the first playlist lands. Pure conversion helpers in `lib/playback.ts` turn an airing into a bar domain in media seconds; the existing bar code keeps working in media seconds and only changes what it scales by. Rollover reads upcoming airings for one channel from the SQLite guide mirror through a new read-only endpoint.

**Tech Stack:** Python 3.14, FastAPI, SQLite, pytest. React 19, TypeScript, react-query, Tailwind, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-15-live-program-bar-design.md`

## Global Constraints

- **The DVR window stays the seek clamp.** The bar's domain is the airing; what playback may reach is still `[rangeStart, rangeEnd]` from `video.seekable`. Widening the domain must never widen what a seek or a skip is allowed to hit.
- **Anchor once, never per render.** `{ wallMs, media }` is captured the first time `seekable.end > 0` and then left alone. Recomputing it from `Date.now()` on each render makes the bar jitter and the thumb fight the playhead.
- **No schedule means no change.** An airing that is missing, undated or zero-length falls back to the DVR bar exactly as it renders today. Every helper returns `null` rather than a guessed window.
- **Wall-clock maths is local.** Airing `start` arrives as an ISO stamp; compare in epoch milliseconds, never by string.
- Backend tests run with `backend/.venv/bin/python -m pytest`. Frontend with `npx vitest run` from `frontend/`.
- `main` already fails ruff with pre-existing errors. Lint only files you touch.

---

## File Structure

**Backend**

| File | Responsibility |
|---|---|
| `app/store.py` (modify) | `channel_airings(identifier, now)` — one channel's airings from the mirror |
| `app/routes/channels.py` (modify) | `GET /api/channels/{identifier}/airings` |
| `tests/test_guide_sync.py` (modify) | Store query: window, ordering, unknown channel |
| `tests/test_channels.py` (modify) | Endpoint: auth, shape |

**Frontend**

| File | Responsibility |
|---|---|
| `src/lib/playback.ts` (modify) | `liveAnchor`, `programWindow`, `clockLabel` — pure conversions |
| `src/api/tablo.ts` (modify) | `api.channelAirings()` + type |
| `src/components/VideoPlayer.tsx` (modify) | Anchor, current airing, bar domain, labels, snap-forward |
| `src/__tests__/playback.test.ts` (modify) | Window maths, rollover selection, fallbacks |

---

## Task 1: One channel's airings, from the mirror

**Files:**
- Modify: `backend/app/store.py:493` (beside `load_guide`)
- Test: `backend/tests/test_guide_sync.py`

**Interfaces:**
- Consumes: `db.query()`, table `guide_airing` (`channel_id`, `start`, `duration`, `end_epoch`, `title`, `subtitle`, `description`, `genres`, `kind`).
- Produces: `store.channel_airings(identifier: str, now: float | None = None) -> list[dict]` — airings for that channel that have not ended, oldest first, same dict shape `load_guide` builds.

- [ ] **Step 1: Write the failing test**

In `backend/tests/test_guide_sync.py`, save a guide holding one channel with three airings — one finished, one in progress, one upcoming — then assert `channel_airings` returns the in-progress and upcoming ones in start order, that a finished airing is excluded, and that an unknown identifier returns `[]`.

- [ ] **Step 2: Implement**

Query `guide_airing WHERE channel_id = ? AND end_epoch >= ? ORDER BY start`. Reuse the row-to-dict shape from `load_guide` rather than inventing a second one — extract it to a module-level `_airing_row(a)` helper and call it from both.

- [ ] **Step 3: Verify** — `backend/.venv/bin/python -m pytest tests/test_guide_sync.py -q`

---

## Task 2: The endpoint

**Files:**
- Modify: `backend/app/routes/channels.py:129` (above `list_channels`)
- Test: `backend/tests/test_channels.py`

**Interfaces:**
- Consumes: `store.channel_airings`, `state.is_authenticated`.
- Produces: `GET /api/channels/{identifier}/airings` → `{"airings": [...]}`.

- [ ] **Step 1: Write the failing test**

Add the path to `PROTECTED_GETS` in `backend/tests/test_channels.py` so it is covered by the existing auth assertion.

- [ ] **Step 2: Implement**

401 when unauthenticated, to match every other route in the file. Read through `_run_sync` — this is an async handler and the store is synchronous SQLite; a direct call blocks the event loop, which is the bug `38908ad` just fixed elsewhere. Do not fall back to the device: a miss returns `{"airings": []}` and the player keeps the airing it was opened with.

- [ ] **Step 3: Verify** — `backend/.venv/bin/python -m pytest -q`

---

## Task 3: Anchor and window, as pure functions

**Files:**
- Modify: `frontend/src/lib/playback.ts`
- Test: `frontend/src/__tests__/playback.test.ts`

**Interfaces:**

```ts
/** Ties the media timeline to wall clock. Captured once, when a playlist first exists. */
export interface LiveAnchor { wallMs: number; media: number }

/** Media-time of a wall-clock instant. */
export function mediaAt(wallMs: number, anchor: LiveAnchor): number

/** Bar domain in media seconds for an airing, or null when it cannot be known. */
export function programWindow(
  airing: { start?: string | null; duration?: number | null } | null | undefined,
  anchor: LiveAnchor | null,
): [number, number] | null

/** The airing covering `wallMs`, or null. Airings need not be sorted. */
export function airingAt<T extends { start?: string | null; duration?: number | null }>(
  airings: T[], wallMs: number,
): T | null
```

- [ ] **Step 1: Write the failing tests**

Anchor `{ wallMs: 8:15 PM, media: 900 }` for an 8:00 PM airing of 3600s gives `[0, 3600]`, so media 900 is a quarter along. `programWindow` returns `null` for a null anchor, a missing or unparseable `start`, and a duration of zero or less. `airingAt` picks the airing containing the instant, is half-open at the end boundary (9:00:00 belongs to the 9:00 airing, not the 8:00 one), and returns `null` when nothing covers it.

- [ ] **Step 2: Implement**

Half-open comparisons throughout, matching `readyRange`. Epoch milliseconds only.

- [ ] **Step 3: Verify** — `npx vitest run` from `frontend/`

---

## Task 4: The player draws the programme

**Files:**
- Modify: `frontend/src/api/tablo.ts` (client + type), `frontend/src/components/VideoPlayer.tsx`

**Interfaces:**
- Consumes: `api.channelAirings(identifier)`, the Task 3 helpers, existing `rangeStart` / `rangeEnd` / `span` / `pct` / `readyBands` / `timeAtX`.
- Produces: no new exports; the bar renders over the airing when one is known.

- [ ] **Step 1: Anchor**

A ref, set on the first `sync()` where `video.seekable.end > 0`, cleared in the start effect beside `liveTranscoded` / `liveEncoded` — a new session is a new timeline, and carrying the old anchor over would place the programme in the wrong century.

- [ ] **Step 2: Current airing**

`useQuery(["channel-airings", identifier])` for live sources only, `staleTime` 5 min, refetch every 10 min. Pick with `airingAt(airings, now)`, falling back to `source.program` when the list is empty or covers nothing. `now` already ticks every 20s for the "48m left" line, which is what re-picks the airing at a boundary.

- [ ] **Step 3: Domain**

```ts
const [barStart, barEnd] = programWindow(airing, anchor) ?? [rangeStart, rangeEnd];
```

Everything downstream keeps working in media seconds. Extend `barEnd` to `Math.max(barEnd, rangeEnd)` so an airing that runs long does not push the live edge off the end of its own bar.

- [ ] **Step 4: Ready band**

`readyBands` for live becomes `[[rangeStart, rangeEnd]]` clipped to the domain — it is already that expression, so this is the clip alone. The band is what the viewer reads as "on disk".

- [ ] **Step 5: Seeking stays clamped — the trap in this whole change**

The domain is now *wider than what exists*: most of an 8:00–9:00 bar at 8:15 is future. Two separate clamps have to keep pointing at the DVR window and not follow the domain.

`timeAtX` maps a pointer to the *domain*; `seekTo` clamps to `[rangeStart, rangeEnd]`, which it already does. A click left of the band therefore snaps to the earliest cached moment, as the spec asks.

`skip` clamps through `readyRange`, which for live must keep returning the **seekable** range — `[rangeStart, rangeEnd]`, ending at the live edge — never `[barStart, barEnd]`. Forward 30 near the live edge lands just inside it and plays; it must not run into the not-yet-broadcast part of the hour, where it would stall and raise the transcoding overlay. Add a regression test that a skip cannot leave the seekable range even when the bar domain extends well past it.

- [ ] **Step 6: Labels**

Ends read as clock times when a programme is known (`8:00 PM` / `9:00 PM`), the hover and scrub readout reads the clock time under the pointer, and both fall back to today's elapsed-duration form without one. Reuse the existing `clockTime` helper.

- [ ] **Step 7: Verify**

`npx tsc --noEmit`, `npx vitest run`, then watch a live channel: the bar spans the hour, the thumb sits where the clock says, pausing grows the band rightwards, and an OTT channel still shows `0:00 … LIVE`.

---

## Task 5: Review pass

- [ ] Run `/code-review` over the branch diff and fix what it confirms.
- [ ] Confirm the fallback path renders identically to `main` for a channel with no guide data — that is the regression this change is most likely to cause.
