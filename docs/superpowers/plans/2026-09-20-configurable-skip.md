# Configurable Skip Forward/Back — Spec + Plan

**Date:** 2026-09-20
**Goal:** Let the viewer set skip-forward and skip-back durations (seconds) in Settings. Defaults: forward 30, back 10. Every skip path — on-screen buttons, keyboard, tap zones, and OS media controls (seek + next/previous track) — reads the same setting, so nothing can skip by a stale amount.

## Why / shape
Skip length is a per-device viewer preference (like volume), not a fact about a recording — so it lives in `localStorage`, not on the device. No Tablo API involved.

Today the amounts are hardcoded (30 fwd / 10 back) in **six** places in `VideoPlayer.tsx`: media-session `seekforward`/`seekbackward` (1483-4), `nexttrack`/`previoustrack` (1490-1), tap zones (2018-9), keyboard arrows (2115-6), on-screen buttons (2905/2927). The fix funnels all of them through one config read **at skip time** so a mid-session change is always honoured.

## Global constraints
- Worktree; TDD; `tsc -b` + vitest green; ruff N/A (frontend). Deploy via tablo-stack; push when told (user said push).
- Read the amount **fresh at each skip invocation** (not cached at mount), so no window/handler can skip stale. Media-session handlers register once but call the loaders inside, so they always see the current value.
- Clamp to a sane range; reject non-finite/≤0.

## Task 1 — `frontend/src/lib/skip.ts`
- Keys `tablo:skipForward`, `tablo:skipBack`. Defaults `SKIP_FORWARD_DEFAULT = 30`, `SKIP_BACK_DEFAULT = 10`.
- `clampSkip(n)`: finite, integer, `1..600`; fallback to default per direction.
- `loadSkipForward()`, `loadSkipBack()`, `saveSkipForward(n)`, `saveSkipBack(n)` — mirror `lib/volume.ts` (try/catch, SSR guard).
- Save also dispatches `window.dispatchEvent(new CustomEvent("tablo:skipconfig"))` so a live-mounted player can refresh its labels (same-tab `storage` events don't fire).
- **Test** `frontend/src/__tests__/skip.test.ts`: defaults when unset; round-trip; clamp (0→default, 999→600, NaN→default, "12.5"→12).

## Task 2 — Settings UI (`SettingsModal.tsx`)
- New **Playback** section (icon: lucide `FastForward` or `Rewind`; reuse the section shell used by others). Two labelled number inputs: "Skip forward (seconds)" and "Skip back (seconds)", seeded from `loadSkipForward()/loadSkipBack()`, `min=1 max=600 step=5`. On change (valid) → `saveSkipForward/back`. Local component state so typing feels immediate; persist on change/blur.
- Client-only; no device call, no overview dependency.
- **Test** (`settingsModal.test.tsx`): rendering the section shows both inputs seeded from storage; changing an input calls save / writes localStorage.

## Task 3 — Wire `VideoPlayer.tsx` through the config
- Import `loadSkipForward`, `loadSkipBack`.
- Replace every hardcoded skip amount:
  - `seekforward`: `skip(d.seekOffset ?? loadSkipForward())`; `seekbackward`: `skip(-(d.seekOffset ?? loadSkipBack()))`.
  - `nexttrack`: `skip(loadSkipForward())`; `previoustrack`: `skip(-loadSkipBack())`.
  - tap zones: forward `skip(loadSkipForward())`, back `skip(-loadSkipBack())`.
  - keyboard: ArrowRight `skip(loadSkipForward())`, ArrowLeft `skip(-loadSkipBack())`.
  - on-screen buttons: `onClick` uses the loaders; **labels/titles/aria dynamic** ("Back {back}s", "Forward {fwd}s").
- Labels come from state seeded at mount from the loaders; a `useEffect` subscribes to the `tablo:skipconfig` event (and `storage`) and re-reads so labels update live. Skip **amounts** never rely on that state — they call the loaders directly, so correctness doesn't depend on the subscription.
- **Test** (`mediaSession.test.tsx` or `playerChrome.test.tsx`): with `localStorage` set to fwd 45 / back 5, firing the `nexttrack` handler skips +45 and `previoustrack` −5 (assert via the surface `currentTime`/`seekTo`, or spy on the skip path). At minimum assert the on-screen button labels reflect stored values.

## Task 4 — gate + ship
- Full FE vitest + `tsc -b` + `npm run build`; eslint on changed files (no new errors).
- Merge `--no-ff`; deploy frontend (build + force-recreate; check-stack 0; bundle hash changed); push.

## Notes
- The media-session `setPositionState` and metadata are unaffected.
- Range clamping still happens in `planSkip`/`commitSkip`; this only changes the requested delta.
