# Library List View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Library a dense two-line row layout beside its card grid, chosen from the toolbar and remembered per viewer.

**Architecture:** One new presentational component (`RecordingRow`) and one new control (`LayoutToggle`), fed by the section list the card grid already builds. The layout choice is a third `usePref` key (`library.layout`), which means one line of backend allow-list. Rules the two layouts share (`isRecording`, `isPlayable`, `resumeFor`, `coverageOf`) move out of `LibraryView`'s private scope into `lib/recording.ts`.

**Tech Stack:** React 19 + TypeScript, Tailwind (token colours from `src/index.css`), lucide-react icons, vitest + @testing-library/react, FastAPI + pytest.

**Spec:** `docs/superpowers/specs/2026-09-21-library-list-view-design.md`

## Global Constraints

- Colours come from tokens only — `text-fg-muted`, `bg-fill-soft`, `border-border-subtle`. Never a literal hex, never a `dark:` variant.
- Opacity modifiers are forbidden on the translucent-by-nature tokens (`fill`, `border`, `scrim`): the modifier replaces the theme's alpha rather than scaling it. Use the `-soft` / `-strong` sibling.
- Frontend tests: `cd frontend && npx vitest run <file>`. Backend tests: `cd backend && .venv/bin/python -m pytest <file> -q`.
- Numerals that stack in columns take `tabular-nums`.
- Every interactive element has an accessible name and a visible focus state.
- Commit after each task, conventional-commit subject ≤ 50 chars.

---

### Task 1: `library.layout` is a preference the server accepts

**Files:**
- Modify: `backend/app/store.py` (`PREF_KEYS`, ~line 1682)
- Test: `backend/tests/test_prefs.py`

**Interfaces:**
- Produces: pref key `"library.layout"`, values `("cards", "list")`.

- [ ] **Step 1: Write the failing test**

```python
def test_the_library_layout_is_remembered(monkeypatch):
    """Cards or rows is how this person reads the page, not a question they
    are asking today - so it outlives the visit, like group and sort."""
    _authenticated(monkeypatch)

    assert client.put("/api/prefs",
                      json={"key": "library.layout", "value": "list"}).status_code == 200
    assert client.get("/api/prefs").json()["library.layout"] == "list"


def test_a_layout_nobody_offers_is_refused(monkeypatch):
    _authenticated(monkeypatch)

    r = client.put("/api/prefs", json={"key": "library.layout", "value": "mosaic"})

    assert r.status_code == 422
```

(Use whatever the file's existing auth helper is called; match the
surrounding tests rather than inventing a fixture.)

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_prefs.py -q`
Expected: FAIL, 422 on a value the server has never heard of.

- [ ] **Step 3: Add the key**

```python
PREF_KEYS: dict[str, tuple[str, ...]] = {
    "library.group": ("day", "show", "channel"),
    "library.sort": ("newest", "oldest", "title", "title-desc"),
    "library.layout": ("cards", "list"),
}
```

- [ ] **Step 4: Run the backend suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS, everything.

- [ ] **Step 5: Commit**

```bash
git add backend/app/store.py backend/tests/test_prefs.py
git commit -m "feat(prefs): remember the Library's layout"
```

---

### Task 2: The rules both layouts need leave the view

**Files:**
- Modify: `frontend/src/lib/recording.ts`
- Modify: `frontend/src/components/LibraryView.tsx` (delete the four private helpers, import them instead)
- Test: `frontend/src/__tests__/recordingRules.test.ts` (create)

**Interfaces:**
- Produces:
  - `isRecording(rec: { state: string | null }): boolean`
  - `isPlayable(rec: { offline_only: boolean; error: string | null }): boolean`
  - `resumeFor(rec: Recording): number`
  - `coverageOf(rec: Recording): Coverage`

Move the bodies verbatim, comments included — they carry the measurements that
justify them. `LibraryView` keeps `isKeepable`, which only the card uses.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isRecording, isPlayable } from "../lib/recording";

describe("what a recording is", () => {
  it("is being written while the device says recording", () => {
    expect(isRecording({ state: "recording" })).toBe(true);
    expect(isRecording({ state: "finished" })).toBe(false);
  });

  it("plays an offline copy whatever the device reports", () => {
    // The device may not have it at all any more.
    expect(isPlayable({ offline_only: true, error: "gone" })).toBe(true);
    expect(isPlayable({ offline_only: false, error: "tuner busy" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/recordingRules.test.ts`
Expected: FAIL, no such export.

- [ ] **Step 3: Move the four helpers into `lib/recording.ts`, export them, and import them in `LibraryView.tsx`**

- [ ] **Step 4: Run the whole frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, 951+ tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/recording.ts frontend/src/components/LibraryView.tsx frontend/src/__tests__/recordingRules.test.ts
git commit -m "refactor: the rules two layouts share leave the view"
```

---

### Task 3: The layout is an option list like the others

**Files:**
- Modify: `frontend/src/lib/libraryLayout.ts`
- Test: `frontend/src/__tests__/libraryLayout.test.ts`

**Interfaces:**
- Produces: `type LibraryLayout = "cards" | "list"`, `LIBRARY_LAYOUTS: LayoutOption<LibraryLayout>[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { LIBRARY_LAYOUTS } from "../lib/libraryLayout";

describe("the layouts on offer", () => {
  it("offers cards and rows, cards first", () => {
    expect(LIBRARY_LAYOUTS.map(l => l.id)).toEqual(["cards", "list"]);
  });

  it("names them in words, not icons alone", () => {
    for (const l of LIBRARY_LAYOUTS) expect(l.label).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/libraryLayout.test.ts`

- [ ] **Step 3: Add the list**

```ts
import { LayoutGrid, Rows3 } from "lucide-react";

export type LibraryLayout = "cards" | "list";

/** How the page draws what it holds. Cards is the default and always was. */
export const LIBRARY_LAYOUTS: LayoutOption<LibraryLayout>[] = [
  { id: "cards", label: "Cards", Icon: LayoutGrid },
  { id: "list",  label: "List",  Icon: Rows3 },
];
```

- [ ] **Step 4: Run the file**

Run: `cd frontend && npx vitest run src/__tests__/libraryLayout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/libraryLayout.ts frontend/src/__tests__/libraryLayout.test.ts
git commit -m "feat(library): name the two layouts"
```

---

### Task 4: One row

**Files:**
- Create: `frontend/src/components/RecordingRow.tsx`
- Test: `frontend/src/__tests__/recordingRow.test.tsx` (create)

**Interfaces:**
- Consumes: `cardArt`, `isRecording`, `isPlayable`, `resumeFor`, `coverageOf`, `isIncomplete` from `lib/recording`; `formatDuration` (lift the view's copy into `lib/format` if it is not already there, else import the view's).
- Produces:

```tsx
interface Props {
  rec: Recording;
  /** The row's own click. Resumes, as the card's artwork does. */
  onPlay: () => void;
  /** The ⋮, which opens the sheet that holds everything else. */
  onInfo: () => void;
}
export function RecordingRow({ rec, onPlay, onInfo }: Props): JSX.Element
```

Layout, in one `<div className="relative flex items-center gap-3 border-b border-border-subtle">`:

- `<button onClick={onPlay}>` spanning the frame and both text lines, `disabled={!isPlayable(rec)}`, `aria-label={`Play ${title}`}`.
- The frame: `w-16 h-9 rounded-md bg-surface-sunken overflow-hidden shrink-0`, `<img className="absolute inset-0 w-full h-full object-fill" loading="lazy">` with the card's `onError` fallback to `rec.thumbnail`, else the italic `Tablo` placeholder.
- Title line: title, then `· subtitle` in `text-fg-secondary`, then badges, all `truncate`.
- Meta line: `S{n} E{n}`, `{channel.number} {channel.network ?? call_sign}`, the start time, and the length — `${formatDuration(recorded_seconds)} of ${formatDuration(expected_seconds || duration)}` while recording, `formatDuration(duration)` otherwise — joined with ` · `, skipping absent parts.
- The rail, when `resumeFor(rec) > 0`: `absolute bottom-0 left-0 right-0 h-0.5` with an inner `bg-accent` at `width: ${(resume / duration) * 100}%`.
- `<button onClick={onInfo} aria-label={`Information about ${title}`}>` with the `MoreVertical` icon, `w-8 h-8 rounded-full hover:bg-fill`.

Badges, at most two, in the spec's precedence: `RecordingPill` / Incomplete / Kept / Ready / Only here / New / Protected. Watched rows take `text-fg-subtle` on both lines and no badge.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecordingRow } from "../components/RecordingRow";

function rec(over = {}) {
  return {
    object_id: 1, title: "Jeopardy!", subtitle: null, description: null,
    season_number: 42, episode_number: 6, start: "2026-09-21T22:00:00Z",
    duration: 1875, recorded_seconds: null, expected_seconds: 1875,
    slot_seconds: 1875, recording_started: null, state: "finished",
    watched: false, position: 0, protected: false, error: null,
    channel: { identifier: "c", call_sign: "KPAX", network: "CBS", number: "8.1", kind: "ota" },
    cache_state: "absent", cache_progress: 0, cached_seconds: 0, pinned: false,
    paused: false, offline_only: false, thumbnail: null, image_url: null,
    cover_frame: null, scan: "1080i", interlaced: true, has_preview: false,
    rate: { mbps: 0, realtime: 0 }, genres: [], kind: "episode",
    identifier: 1, path: "/recordings/series/episodes/1",
    series_path: null, sport_path: null, orig_air_date: null, width: 1920, height: 1080,
    ...over,
  } as never;
}

describe("a Library row", () => {
  it("names the recording, its episode and its channel", () => {
    render(<RecordingRow rec={rec()} onPlay={() => {}} onInfo={() => {}} />);

    expect(screen.getByText(/Jeopardy!/)).toBeInTheDocument();
    expect(screen.getByText(/S42 E6/)).toBeInTheDocument();
    expect(screen.getByText(/8\.1 CBS/)).toBeInTheDocument();
  });

  it("plays when the row is clicked", () => {
    const onPlay = vi.fn();
    render(<RecordingRow rec={rec()} onPlay={onPlay} onInfo={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Play Jeopardy!/ }));

    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("opens the sheet from the one control that is not play", () => {
    const onPlay = vi.fn();
    const onInfo = vi.fn();
    render(<RecordingRow rec={rec()} onPlay={onPlay} onInfo={onInfo} />);

    fireEvent.click(screen.getByRole("button", { name: /Information about/ }));

    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("says what exists, not what was promised, while recording", () => {
    render(<RecordingRow rec={rec({ state: "recording", recorded_seconds: 480 })}
                         onPlay={() => {}} onInfo={() => {}} />);

    expect(screen.getByText(/8m of 31m/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Recording/i)).toBeInTheDocument();
  });

  it("says a copy is kept here", () => {
    render(<RecordingRow rec={rec({ pinned: true, cache_state: "complete" })}
                         onPlay={() => {}} onInfo={() => {}} />);

    expect(screen.getByText(/Kept/i)).toBeInTheDocument();
  });

  it("draws how far in the viewer is", () => {
    const { container } = render(
      <RecordingRow rec={rec({ position: 937 })} onPlay={() => {}} onInfo={() => {}} />);

    const rail = container.querySelector("[data-resume-rail] > *") as HTMLElement;
    expect(rail).toBeTruthy();
    expect(parseFloat(rail.style.width)).toBeCloseTo(50, 0);
  });

  it("draws no rail for something never opened", () => {
    const { container } = render(
      <RecordingRow rec={rec()} onPlay={() => {}} onInfo={() => {}} />);

    expect(container.querySelector("[data-resume-rail]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npx vitest run src/__tests__/recordingRow.test.tsx`
Expected: FAIL, no such module.

- [ ] **Step 3: Write `RecordingRow.tsx` to the shape above**

- [ ] **Step 4: Run the file, then the suite**

Run: `cd frontend && npx vitest run src/__tests__/recordingRow.test.tsx && npx vitest run`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/RecordingRow.tsx frontend/src/__tests__/recordingRow.test.tsx
git commit -m "feat(library): a recording as one dense row"
```

---

### Task 5: The switch

**Files:**
- Create: `frontend/src/components/LayoutToggle.tsx`
- Test: `frontend/src/__tests__/layoutToggle.test.tsx` (create)

**Interfaces:**
- Produces: `export function LayoutToggle({ value, onChange }: { value: LibraryLayout; onChange: (next: LibraryLayout) => void })`

A `role="group"` with `aria-label="Layout"` holding one `<button aria-pressed>` per entry of `LIBRARY_LAYOUTS`: icon plus an `sr-only` label, `rounded-lg`, pressed half on `bg-fill-strong text-fg`, the other `text-fg-muted hover:bg-fill`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayoutToggle } from "../components/LayoutToggle";

describe("the layout switch", () => {
  it("offers both layouts as toggles", () => {
    render(<LayoutToggle value="cards" onChange={() => {}} />);

    expect(screen.getByRole("button", { name: /Cards/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /List/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the other one when it is chosen", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="cards" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /List/ }));

    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("says nothing when the current layout is clicked again", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="list" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /List/ }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npx vitest run src/__tests__/layoutToggle.test.tsx`

- [ ] **Step 3: Write `LayoutToggle.tsx`**

- [ ] **Step 4: Run the file**

Run: `cd frontend && npx vitest run src/__tests__/layoutToggle.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LayoutToggle.tsx frontend/src/__tests__/layoutToggle.test.tsx
git commit -m "feat(library): a switch between cards and rows"
```

---

### Task 6: The Library draws either one

**Files:**
- Modify: `frontend/src/components/LibraryView.tsx` — the pref, the toolbar cluster (~line 724), and the section loop (~line 753 onward)

**Interfaces:**
- Consumes: `LIBRARY_LAYOUTS`, `LayoutToggle`, `RecordingRow`, `usePref`.

The pref, beside the two that exist:

```tsx
const [layout, setLayout] = usePref<LibraryLayout>(
  "library.layout", "cards", LAYOUT_IDS);
```

The toolbar gains `<LayoutToggle value={layout} onChange={setLayout} />` as the
last child of the `data-layout-menus` cluster.

The rendering splits at the container, not at the section: headings, the
storage line and both empty states are written once and serve both layouts.
The grid keeps `grid gap-6` with its `repeat(auto-fill, …)` template; the list
is `flex flex-col` with no gap, since the rows carry their own rule. Inside a
section, cards render as they do today and rows render as:

```tsx
<RecordingRow
  key={rec.object_id}
  rec={rec}
  onPlay={() => { setStartMode("resume"); setPlaying(rec); }}
  onInfo={() => setInfoFor(rec)}
/>
```

Section headings in list mode keep `col-span-full` out of their class list —
that class means nothing outside a grid, and leaving it there is how a heading
ends up styled by a rule it no longer sits under.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/__tests__/recordings.test.tsx` (or a new
`libraryLayoutSwitch.test.tsx` if that file has no Library render harness):

```tsx
it("draws rows instead of cards when the layout says so", async () => {
  // prefs answer "list"; the page must render one row per recording and no
  // card artwork well.
  renderLibrary({ prefs: { "library.layout": "list" } });

  expect(await screen.findByRole("button", { name: /Play Jeopardy!/ })).toBeInTheDocument();
  expect(screen.queryByText(/No description available/)).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest run src/__tests__/recordings.test.tsx`

- [ ] **Step 3: Wire the pref, the toggle and the branch into `LibraryView`**

- [ ] **Step 4: Run the whole suite and the type check**

Run: `cd frontend && npx vitest run && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LibraryView.tsx frontend/src/__tests__
git commit -m "feat(library): draw the library as rows"
```

---

### Task 7: It works in the real app

**Files:** none — this task is verification.

- [ ] **Step 1: Build and deploy the frontend**

Run, from the repo root:

```bash
docker compose build frontend
docker compose up -d --force-recreate frontend
.claude/skills/tablo-stack/check-stack.sh
```

Expected: six `ok` lines and "Stack is correct."

- [ ] **Step 2: Switch the layout through the API and read it back**

```bash
curl -s -X PUT http://127.0.0.1:7070/api/prefs \
  -H 'content-type: application/json' \
  -d '{"key":"library.layout","value":"list"}'
curl -s http://127.0.0.1:7070/api/prefs
```

Expected: `{"ok":true}` then a body containing `"library.layout": "list"`.

- [ ] **Step 3: Look at the page**

Open `http://127.0.0.1:7070/#/library`, confirm rows, switch to cards and back,
reload and confirm the choice survived.

- [ ] **Step 4: Put it back to cards if that is what was there before**

- [ ] **Step 5: Commit nothing; report what was seen**

---

## Self-review

- Spec coverage: pref (T1), shared rules (T2), option list (T3), row anatomy and badges (T4), the switch (T5), the view branch (T6), real-app verification (T7). The spec's non-goals add no tasks by construction.
- Types: `LibraryLayout` is defined in T3 and consumed by T5 and T6 under that name; `RecordingRow`'s props are fixed in T4 and used unchanged in T6.
- No placeholders: every step names its command and its expected result.
