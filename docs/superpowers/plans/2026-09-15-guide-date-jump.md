# Guide Date Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A day × daypart grid that jumps the guide to "Thursday evening" in one click, and a NOW pill that always brings it back to the live edge.

**Architecture:** The arithmetic — which days, which dayparts, what each cell is worth — is a pure module with no React in it. `GuideJump` renders it. `GuideGridView` owns the scrollers and gains one `scrollToTime`, which drives the lanes it already keeps in a ref.

**Tech Stack:** React 19, TypeScript, Tailwind, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-15-guide-date-jump-design.md`

## Global Constraints

- **Scrolling stays in refs.** `GuideGridView` deliberately keeps the shared offset in `offset.current` and not in state, because the handler runs on every scroll frame. The jump control needs a label that follows the scroll — derive it, but only `setState` when the label's *value* changes, never per frame.
- **The grid starts at the current hour** and runs forward. Nothing before `startTime` is reachable; cells that fall entirely there are inert, not hidden.
- **Coverage comes from the listings already in memory.** No new fetch, no new endpoint.
- **Tokens, not hex.** `bg-accent`, `text-white/50`, `bg-surface-overlay` — the brand blue moved once already this week, and anything hard-coded misses the next move.
- Frontend tests: `npx vitest run` from `frontend/`. Lint only files you touch.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/guideJump.ts` (create) | Dayparts, the day×part model, the label for a position |
| `src/components/GuideJump.tsx` (create) | The NOW pill, the trigger button, the popover |
| `src/components/GuideGridView.tsx` (modify) | `scrollToTime`, coverage, the tracked label, mount the control |
| `src/__tests__/guideJump.test.ts` (create) | The pure model |
| `src/__tests__/guideGrid.test.tsx` (modify) | The control in place: jumping moves the lanes |

---

## Task 1: The model

**Files:** create `frontend/src/lib/guideJump.ts`, `frontend/src/__tests__/guideJump.test.ts`

**Interfaces:**

```ts
export interface Daypart { id: string; label: string; hour: number }
export const DAYPARTS: Daypart[]            // Morning 6, Afternoon 12, Prime 19, Late 23

export type CellState = "past" | "empty" | "live" | "listed";
export interface JumpCell { part: Daypart; at: number; state: CellState; label: string }
export interface JumpDay { key: string; label: string; date: string; cells: JumpCell[] }

/** Rows for the popover: one per day the guide covers. */
export function jumpDays(opts: {
  startTime: number;        // grid origin (current hour)
  totalHours: number;       // how far the guide runs
  covered: Set<number>;     // hour-epochs that have an airing over them
  now: number;
}): JumpDay[]

/** Hour-epochs covered by these airings, for `covered` above. */
export function coveredHours(airings: { start: string; duration: number }[]): Set<number>

/** What the trigger button says for a scroll position, e.g. "Thu · Prime". */
export function positionLabel(startTime: number, offsetPx: number, hourWidth: number): string
```

- [ ] **Step 1: Write the failing tests**

Cover: a daypart wholly before `startTime` is `past`; the one containing `now` is `live`; one with no covered hour is `empty`; the rest are `listed` and carry the hour they land on. `coveredHours` marks every hour an airing touches, including one that starts mid-hour and one that spans three. `positionLabel` names the day and part under a given scroll offset, and says "Today" for the first day.

- [ ] **Step 2: Implement**

Local time throughout — a daypart is a wall-clock idea. Build days from `startTime`'s calendar day up to `startTime + totalHours`.

- [ ] **Step 3: Verify** — `npx vitest run src/__tests__/guideJump.test.ts`

---

## Task 2: The control

**Files:** create `frontend/src/components/GuideJump.tsx`

**Interfaces:**
- Props: `{ days: JumpDay[]; label: string; onJump(at: number): void; onNow(): void }`.
- Renders: the NOW pill, then the trigger button, then the popover when open.

- [ ] **Step 1: Build it**

Match the filter chips it sits beside — `rounded-full`, `text-xs font-bold`, `glass` for the button, `px-3 py-1.5`. The NOW pill carries the now-line's red (`bg-red-500/10`, `text-red-300`, a `bg-red-500` dot) so it reads as the same thing as the line it returns to.

Popover: absolutely positioned under the button, `bg-surface-overlay`, one `grid-cols-[76px_repeat(4,minmax(0,1fr))]`. Inert cells are `disabled` buttons, not divs — a real disabled control is what tells a screen reader the jump is not available.

- [ ] **Step 2: Make it dismissable**

Escape closes it, a click outside closes it, and choosing a cell closes it. Bind the outside-click listener only while open.

- [ ] **Step 3: Verify** — `npx tsc --noEmit`, `npx eslint`

---

## Task 3: Wire it to the scrollers

**Files:** modify `frontend/src/components/GuideGridView.tsx`

- [ ] **Step 1: `scrollToTime(at: number)`**

`px = ((at - startTime) / 3600_000) * HOUR_WIDTH`, clamped at 0. Write it to `offset.current` and to every registered lane, exactly as `syncLanes` does — this is the same operation from the other direction.

- [ ] **Step 2: The tracked label**

In `syncLanes`, compute `positionLabel` and `setState` **only when the string changes**. Guard it: this runs on every scroll frame, and the file's own comment explains why that must not re-render the guide.

- [ ] **Step 3: NOW**

Scroll to `now - 15 minutes` (spec: "Where now lands"), so the programme in progress is not clipped at the left edge.

- [ ] **Step 4: Mount it**

Into the filter row, after a `flex-1` spacer, so it takes the empty right-hand end the chips already leave. Feed it `coveredHours(every airing in the grid)`, memoized on `grid`.

- [ ] **Step 5: Verify** — `npx vitest run`, then look at the real guide: jump to a day, jump back with NOW, check the button's label follows a manual scroll.

---

## Task 4: Regression test in the grid

**Files:** modify `frontend/src/__tests__/guideGrid.test.tsx`

- [ ] Render the grid with listings spanning a few days; click the trigger, click a listed cell, assert every lane's `scrollLeft` moved to that hour's offset. Then click NOW and assert it comes back to the live edge less the lead.
- [ ] Assert a past cell renders `disabled` — the grid cannot scroll there, and a control that looks live but does nothing is worse than one that says so.

---

## Task 5: Review

- [ ] `/code-review` over the branch diff; fix what it confirms.
- [ ] Check the guide still scrolls in step (header against rows) after a jump — the lanes are the one thing this feature reaches into.
