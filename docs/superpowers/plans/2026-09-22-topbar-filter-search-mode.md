# Topbar filter/search mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Library's second text box with one topbar box carrying a
strict two-way switch — funnel narrows the page you are on, spyglass searches
everything — with both the mode and the text remembered across a reload.

**Architecture:** `ChannelGrid` already owns the topbar text and hands it to
`SearchResultsView`. It gains a `mode`, resolves the text to a per-tab filter
query (the text in Filter mode, `""` in Search mode), and passes that down to
`LibraryView` and `RecordingsView`, neither of which takes props today. Two new
files: a storage module owning both `localStorage` keys and the one-shot
migration off the Library's old key, and the icon-pair toggle that lives in the
field's left cap.

**Tech Stack:** React 19, TypeScript, Tailwind 3, vitest + @testing-library/react,
lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-09-22-topbar-filter-search-mode-design.md`

## Global Constraints

- **Colour comes from tokens** in `frontend/src/index.css` — never a literal hex,
  never a `dark:` variant. `fill`, `border` and `scrim` are translucent already,
  so they must not take a Tailwind opacity modifier (`bg-fill/60` replaces the
  alpha rather than scaling it); reach for the `-soft` / `-strong` sibling.
- **A glyph shows state, not the act.** The act belongs in the accessible name
  and the tooltip.
- **Comments carry the why**, including the measurement that settled it. Match
  the surrounding density; do not strip existing comments while editing around
  them.
- Storage keys, exactly: `tablo:topbar.mode`, `tablo:topbar.query`, and the
  legacy `tablo:library.filter`.
- Mode values, exactly: `"filter"` and `"search"`. Default `"filter"`.
- Every `localStorage` access is wrapped in `try`/`catch` — private mode throws
  on both `getItem` and `setItem`, and a filter box is not worth a blank page.
- Run all commands from `frontend/`. Test command: `npm test`.

---

### Task 1: What the topbar box remembers

**Files:**
- Create: `frontend/src/lib/topbarMemory.ts`
- Test: `frontend/src/__tests__/topbarMemory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TopbarMode = "filter" | "search"`
  - `useTopbarMode(): [TopbarMode, (next: TopbarMode) => void]`
  - `useTopbarQuery(seed: string): [string, (next: string) => void]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/topbarMemory.test.ts`:

```ts
/**
 * The topbar box's memory: one mode, one string, both in this browser.
 *
 * Local rather than on the server, like the Library filter it replaces: how a
 * person reads a page should follow them between machines, where what they are
 * squinting at this minute should not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useTopbarMode, useTopbarQuery } from "../lib/topbarMemory";

describe("the topbar's remembered mode", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("opens on the filter, which is the one most days want", () => {
    const { result } = renderHook(() => useTopbarMode());
    expect(result.current[0]).toBe("filter");
  });

  it("comes back to the mode last chosen", () => {
    localStorage.setItem("tablo:topbar.mode", "search");
    const { result } = renderHook(() => useTopbarMode());
    expect(result.current[0]).toBe("search");
  });

  it("writes the choice down", () => {
    const { result } = renderHook(() => useTopbarMode());
    act(() => result.current[1]("search"));
    expect(result.current[0]).toBe("search");
    expect(localStorage.getItem("tablo:topbar.mode")).toBe("search");
  });

  it("ignores a value it no longer has a mode for", () => {
    // A key left by an older build, or by a hand in the console.
    localStorage.setItem("tablo:topbar.mode", "telepathy");
    const { result } = renderHook(() => useTopbarMode());
    expect(result.current[0]).toBe("filter");
  });
});

describe("the topbar's remembered text", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("comes back to what was left in the box", () => {
    localStorage.setItem("tablo:topbar.query", "kratts");
    const { result } = renderHook(() => useTopbarQuery(""));
    expect(result.current[0]).toBe("kratts");
  });

  it("lets a deep link win over what was stored", () => {
    // `#/search?q=…` is a statement about what this page should show; the
    // stored value is a guess about what the viewer was last doing.
    localStorage.setItem("tablo:topbar.query", "kratts");
    const { result } = renderHook(() => useTopbarQuery("broncos"));
    expect(result.current[0]).toBe("broncos");
  });

  it("adopts the Library's old key once, then drops it", () => {
    localStorage.setItem("tablo:library.filter", "kratts");
    const { result } = renderHook(() => useTopbarQuery(""));

    expect(result.current[0]).toBe("kratts");
    expect(localStorage.getItem("tablo:library.filter")).toBeNull();
  });

  it("drops the old key even when a deep link wins the text", () => {
    localStorage.setItem("tablo:library.filter", "kratts");
    renderHook(() => useTopbarQuery("broncos"));
    expect(localStorage.getItem("tablo:library.filter")).toBeNull();
  });

  it("forgets the text when the box is emptied", () => {
    localStorage.setItem("tablo:topbar.query", "kratts");
    const { result } = renderHook(() => useTopbarQuery(""));

    act(() => result.current[1](""));

    expect(localStorage.getItem("tablo:topbar.query")).toBeNull();
  });

  it("works where site data is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("site data blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("site data blocked");
    });

    const { result } = renderHook(() => useTopbarQuery(""));
    expect(result.current[0]).toBe("");
    expect(() => act(() => result.current[1]("kratts"))).not.toThrow();
    expect(result.current[0]).toBe("kratts");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/topbarMemory.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/topbarMemory"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/topbarMemory.ts`:

```ts
/**
 * What the topbar's one box remembers between visits: which job it is doing,
 * and what is typed in it.
 *
 * Both in this browser rather than on the server, and for the same reason the
 * Library's filter was: a preference for how a page is laid out should follow
 * a viewer between machines, where the thing they are looking for this minute
 * should not. See `lib/usePref` for the other half of that split.
 *
 * One string for both modes, not one each. Flipping the switch is meant to
 * reinterpret what is already typed — that IS the switch — and a mode that
 * swapped in something typed an hour ago and forgotten would be a different,
 * worse control.
 *
 * Every access is guarded: private mode and browsers set to block site data
 * throw on both `getItem` and `setItem`, and a filter box is not worth a blank
 * page. An empty value is removed rather than stored, so the key does not
 * outlive its usefulness.
 */
import { useCallback, useState } from "react";

export type TopbarMode = "filter" | "search";

const MODE_KEY = "tablo:topbar.mode";
const QUERY_KEY = "tablo:topbar.query";
/** The Library's own box, back when there were two. Read once, then dropped. */
const LEGACY_QUERY_KEY = "tablo:library.filter";

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // The box still works for this visit; it just will not be here on the next.
  }
}

/**
 * The stored text, adopting the Library's old key if that is all there is.
 *
 * Unconditional rather than a fallback, so the dead key goes even on a visit
 * whose text came from a deep link — the same one-shot migration `lib/resume`
 * does for its own legacy key.
 */
function readQuery(): string {
  const current = read(QUERY_KEY);
  const legacy = read(LEGACY_QUERY_KEY);
  if (legacy) {
    try {
      localStorage.removeItem(LEGACY_QUERY_KEY);
    } catch {
      // Then it stays, and is read again next time. Harmless either way.
    }
  }
  return current || legacy;
}

export function useTopbarMode(): [TopbarMode, (next: TopbarMode) => void] {
  // Guarded rather than trusted: a key left by an older build would otherwise
  // put the box in a mode this one has no behaviour for.
  const [mode, setStored] = useState<TopbarMode>(
    () => (read(MODE_KEY) === "search" ? "search" : "filter"),
  );

  const set = useCallback((next: TopbarMode) => {
    setStored(next);
    write(MODE_KEY, next);
  }, []);

  return [mode, set];
}

export function useTopbarQuery(seed: string): [string, (next: string) => void] {
  // Read once, at mount: this is the only moment the stored value is news, and
  // reading on every render would fight the field a viewer is typing in.
  const [query, setStored] = useState(() => {
    // Always read, even when the seed wins, because reading is what retires
    // the legacy key.
    const stored = readQuery();
    return seed || stored;
  });

  const set = useCallback((next: string) => {
    setStored(next);
    write(QUERY_KEY, next);
  }, []);

  return [query, set];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/topbarMemory.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/topbarMemory.ts frontend/src/__tests__/topbarMemory.test.ts
git commit -m "feat(topbar): remember the box's mode and its text"
```

---

### Task 2: The switch in the field's left cap

**Files:**
- Create: `frontend/src/components/SearchModeToggle.tsx`
- Test: `frontend/src/__tests__/searchModeToggle.test.tsx`

**Interfaces:**
- Consumes: `TopbarMode` from `lib/topbarMemory` (Task 1).
- Produces: `SearchModeToggle({ value, onChange, filterDisabled }: { value: TopbarMode; onChange: (next: TopbarMode) => void; filterDisabled: boolean })`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/searchModeToggle.test.tsx`:

```tsx
/**
 * The two-way switch in the topbar field's left cap.
 *
 * A glyph shows state, not the act: the funnel means "this box is narrowing
 * the page", so the act lives in the accessible name and the tooltip.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SearchModeToggle } from "../components/SearchModeToggle";

describe("the filter/search switch", () => {
  it("offers both jobs, and says which one is on", () => {
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled={false} />);

    expect(screen.getByRole("radio", { name: "Filter this page" }))
      .toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Search everything" }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("leaves the spyglass where the single icon always was", () => {
    // The box has worn a spyglass in this spot since it was only a search.
    // Moving it to make room for the funnel would charge everyone a relearn.
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled={false} />);

    const [first, second] = screen.getAllByRole("radio");
    expect(first).toHaveAccessibleName("Search everything");
    expect(second).toHaveAccessibleName("Filter this page");
  });

  it("names the group, so the pair is one control to a screen reader", () => {
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled={false} />);
    expect(screen.getByRole("radiogroup", { name: "Search mode" })).toBeInTheDocument();
  });

  it("reports the choice", () => {
    const onChange = vi.fn();
    render(<SearchModeToggle value="filter" onChange={onChange} filterDisabled={false} />);

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));

    expect(onChange).toHaveBeenCalledWith("search");
  });

  it("greys the funnel where there is nothing to narrow", () => {
    // The Guide and the results page. Disabled rather than hidden: the control
    // should be the same shape on every tab, or its position in the row moves
    // as you navigate.
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled />);

    const funnel = screen.getByRole("radio", { name: "Filter this page" });
    expect(funnel).toBeDisabled();
    // Reads as Search while you are there, without touching the stored mode.
    expect(funnel).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Search everything" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("cannot be talked into a mode it has greyed out", () => {
    const onChange = vi.fn();
    render(<SearchModeToggle value="filter" onChange={onChange} filterDisabled />);

    fireEvent.click(screen.getByRole("radio", { name: "Filter this page" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/searchModeToggle.test.tsx`
Expected: FAIL — `Failed to resolve import "../components/SearchModeToggle"`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/SearchModeToggle.tsx`:

```tsx
/**
 * Which job the topbar's one box is doing.
 *
 * It lives inside the field's left cap, where a lone decorative spyglass used
 * to sit, because the mode belongs to the box and a switch parked beside it
 * would read as a third control on a row that already has too many.
 *
 * The glyph is the state — a funnel means "this is narrowing the page", a
 * spyglass means "this goes and finds things" — so the act is in the
 * accessible name and the tooltip rather than in the icon.
 *
 * `onMouseDown` is prevented on both halves for the same reason the results
 * dropdown does it: the field's own `onBlur` would otherwise land first, take
 * the dropdown down under the pointer and drop the caret out of the box the
 * switch was just aimed at.
 */
import { Funnel, Search } from "lucide-react";

import type { TopbarMode } from "../lib/topbarMemory";

/**
 * Spyglass first, because it is the half that was already here: the box has
 * worn a spyglass in this exact spot since it was only a search, and moving
 * the familiar glyph to make room for the new one would charge everyone a
 * relearn for a feature half of them did not ask for. The funnel is still the
 * default selection — narrowing the page is the more common errand — so the
 * pair opens with its right half lit.
 */
const MODES = [
  {
    value: "search" as const,
    name: "Search everything",
    hint: "Search programs, channels and recordings",
    Icon: Search,
  },
  {
    value: "filter" as const,
    name: "Filter this page",
    hint: "Narrow what is on this page",
    Icon: Funnel,
  },
];

export function SearchModeToggle({
  value, onChange, filterDisabled,
}: {
  value: TopbarMode;
  onChange: (next: TopbarMode) => void;
  /** True on a tab with nothing to narrow, where the funnel greys out. */
  filterDisabled: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Search mode"
      className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5"
    >
      {MODES.map(({ value: mode, name, hint, Icon }) => {
        const disabled = filterDisabled && mode === "filter";
        // Greyed out, the funnel cannot be the checked one even while it is
        // still the stored mode — the box really is searching while you are
        // here, and saying otherwise would be a lie told to a screen reader.
        const checked = filterDisabled ? mode === "search" : value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={name}
            title={hint}
            disabled={disabled}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onChange(mode)}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
                        ${disabled
                          ? "text-fg-subtle cursor-not-allowed"
                          : checked
                            ? "bg-accent-soft text-accent-strong"
                            : "text-fg-muted hover:text-fg-secondary hover:bg-fill"}`}
          >
            <Icon className="w-4 h-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/searchModeToggle.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SearchModeToggle.tsx frontend/src/__tests__/searchModeToggle.test.tsx
git commit -m "feat(topbar): a switch for the box's two jobs"
```

---

### Task 3: Wire the switch into the topbar, strictly

**Files:**
- Modify: `frontend/src/components/ChannelGrid.tsx` (imports ~line 6; state ~line 115; `filtered` ~line 371; topbar field ~lines 553-632)
- Modify: `frontend/src/__tests__/pageChrome.test.tsx` (the phone-expand and clear-button describes)
- Test: `frontend/src/__tests__/topbarMode.test.tsx` (create)

**Interfaces:**
- Consumes: `useTopbarMode`, `useTopbarQuery`, `TopbarMode` (Task 1); `SearchModeToggle` (Task 2).
- Produces: `ChannelGrid` passes `query: string` to `<LibraryView>` and
  `<RecordingsView>` — the text in Filter mode, `""` in Search mode. Those props
  land in Tasks 4 and 5; this task does **not** add them to the JSX yet.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/topbarMode.test.tsx`:

```tsx
/**
 * One box, two jobs, and a switch that means something.
 *
 * Strict: the mode decides the behaviour and nothing leaks across. The topbar
 * text used to filter the Live list locally AND open the dropdown, which made
 * a two-position switch whose positions both did some filtering. Search mode
 * gives that up on purpose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ChannelGrid } from "../components/ChannelGrid";
import { api, type GuideChannel } from "../api/tablo";

function channel(id: string, call: string, name: string): GuideChannel {
  return {
    identifier: id, call_sign: call, network: call, display_name: name,
    number: "1.1", kind: "ota", current_program: null,
  } as unknown as GuideChannel;
}

function mockShell() {
  vi.spyOn(api, "status").mockResolvedValue({
    authenticated: true, email: "viewer@example.com", devices: [],
    active_sid: null, direct_origin: null,
  });
  vi.spyOn(api, "guideStream").mockImplementation(async function* () {
    yield [channel("A", "KUFM", "Montana PBS"), channel("B", "KTMF", "ABC Fox")];
  });
  vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {});
  vi.spyOn(api, "prefs").mockResolvedValue({});
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChannelGrid onLogout={() => {}} />
    </QueryClientProvider>,
  );
}

/** The one text box in the topbar, whatever it is currently called. */
function box(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("header input[type=text]")!;
}

describe("the topbar box's two jobs", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "#/live");
    mockShell();
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens on the filter", async () => {
    renderShell();
    expect(await screen.findByRole("radio", { name: "Filter this page" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("names itself after the page it is narrowing", async () => {
    renderShell();
    await screen.findByRole("radio", { name: "Filter this page" });

    expect(box()).toHaveAttribute("placeholder", "Filter channels...");
  });

  it("narrows the Live list and shows no dropdown", async () => {
    renderShell();
    await screen.findByText("Montana PBS");

    fireEvent.change(box(), { target: { value: "kufm" } });

    await waitFor(() => expect(screen.queryByText("ABC Fox")).toBeNull());
    expect(screen.getByText("Montana PBS")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Search suggestions" })).toBeNull();
  });

  it("leaves the Live list alone in search mode", async () => {
    // The cost of a switch that means something: search searches, and the page
    // under it is the page you were already looking at.
    vi.spyOn(api, "search").mockResolvedValue({ query: "kufm", groups: [] } as never);
    renderShell();
    await screen.findByText("Montana PBS");

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));
    fireEvent.change(box(), { target: { value: "kufm" } });

    expect(await screen.findByText("ABC Fox")).toBeInTheDocument();
    expect(box()).toHaveAttribute("placeholder", "Search programs, channels...");
  });

  it("reinterprets what is already typed when the switch is flipped", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ query: "kufm", groups: [] } as never);
    renderShell();
    await screen.findByText("Montana PBS");

    fireEvent.change(box(), { target: { value: "kufm" } });
    await waitFor(() => expect(screen.queryByText("ABC Fox")).toBeNull());

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));

    expect(box()).toHaveValue("kufm");
    expect(await screen.findByText("ABC Fox")).toBeInTheDocument();
  });

  it("greys the funnel on the Guide, and gives it back on the way out", async () => {
    renderShell();
    await screen.findByRole("radio", { name: "Filter this page" });

    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Filter this page" })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Filter this page" }))
        .toHaveAttribute("aria-checked", "true"));
  });

  it("remembers the mode and the text across a reload", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ query: "kufm", groups: [] } as never);
    const first = renderShell();
    await screen.findByText("Montana PBS");

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));
    fireEvent.change(box(), { target: { value: "kufm" } });
    await waitFor(() =>
      expect(localStorage.getItem("tablo:topbar.query")).toBe("kufm"));
    first.unmount();

    renderShell();

    expect(await screen.findByRole("radio", { name: "Search everything" }))
      .toHaveAttribute("aria-checked", "true");
    expect(box()).toHaveValue("kufm");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/topbarMode.test.tsx`
Expected: FAIL — no radio named "Filter this page" in the document.

- [ ] **Step 3: Swap the state over**

In `frontend/src/components/ChannelGrid.tsx`, extend the lucide import on line 6
and add the two new imports below it:

```tsx
import { Funnel, Inbox, Search, X } from "lucide-react";
```

```tsx
import { SearchModeToggle } from "./SearchModeToggle";
import { useTopbarMode, useTopbarQuery, type TopbarMode } from "../lib/topbarMemory";
```

Replace the `filter` state declaration (~line 115) — keep the comment above it,
which still explains the seed:

```tsx
  const [filter, setFilter] = useTopbarQuery(
    initialRoute.tab === "search" ? initialRoute.q ?? "" : ""
  );
  const [mode, setMode] = useTopbarMode();
```

- [ ] **Step 4: Resolve the mode against the tab**

Add below the `filtered` memo's neighbours, just above `const filtered =`
(~line 371):

```tsx
  /**
   * Which tabs have a list worth narrowing.
   *
   * The Guide is out until it can filter on the whole visible window rather
   * than on whatever happens to be airing this minute — narrowing a grid by
   * `current_program` would hide a channel that has the match forty minutes
   * from now, which is the case people actually want. The results page is out
   * because it already IS the query.
   */
  const filterable = activeTab === "live" || activeTab === "library" || activeTab === "series";
  const effectiveMode: TopbarMode = filterable ? mode : "search";
  /** The text, if it is doing the narrowing job; otherwise nothing is narrowed. */
  const pageFilter = effectiveMode === "filter" ? filter : "";
```

Then make the Live predicate read `pageFilter` instead of `filter` — the two
lines inside `const filtered = channels.filter(...)`:

```tsx
    if (!pageFilter) return true;
    const q = pageFilter.toLowerCase();
```

- [ ] **Step 5: Name the box after the job it is doing**

Add above the `return (` of the component, beside `filterable`:

```tsx
  /**
   * What the box calls itself: the mode AND the tab, because "Filter
   * recordings…" over the Live list would be a lie about what it narrows.
   */
  const boxLabel = effectiveMode === "search"
    ? "Search programs, channels"
    : activeTab === "live" ? "Filter channels"
    : activeTab === "library" ? "Filter recordings"
    : "Filter series";
```

- [ ] **Step 6: Rebuild the field**

In the topbar's search `<div className={...relative flex-1 max-w-sm...}>` block,
replace the lone decorative icon line:

```tsx
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-muted" aria-hidden />
```

with the switch:

```tsx
              <SearchModeToggle
                value={mode}
                onChange={setMode}
                filterDisabled={!filterable}
              />
```

On the `<input>`, replace `placeholder`, `aria-label`, the `onKeyDown` handler
and the left padding in `className`:

```tsx
                onKeyDown={e => {
                  // Enter belongs to the search: it is the one mode with
                  // somewhere else to go. Filtering already happened on the
                  // keystroke before it.
                  if (e.key === "Enter") {
                    if (effectiveMode === "search" && filter.trim()) handleSearchSeeAll();
                    return;
                  }
                  if (e.key !== "Escape") return;
                  // One Escape, one dismissal: on a phone the field IS the
                  // row, so leaving it open with the dropdown gone would hide
                  // the tabs behind an empty box.
                  if (searchExpanded) collapseSearch(); else closeSearch();
                }}
                placeholder={`${boxLabel}...`}
                aria-label={boxLabel}
```

and, in the input's `className`, `pl-10` becomes `pl-[4.5rem]` — two 28px
buttons, a 2px gap and the 6px inset the group sits at, which is 64px of cap
plus the 8px the text always had:

```tsx
                className={`w-full pl-[4.5rem] py-2.5 rounded-xl bg-fill-soft border border-border-subtle
                           text-sm placeholder-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent
                           focus:bg-fill transition shadow-inner ${filter ? "pr-10" : "pr-4"}`}
```

Change the clear button's `title` and `aria-label` to follow the mode:

```tsx
                  title={effectiveMode === "search" ? "Clear search" : "Clear filter"}
                  aria-label={effectiveMode === "search" ? "Clear search" : "Clear filter"}
```

Gate the dropdown on the mode:

```tsx
              {searchOpen && effectiveMode === "search" && activeTab !== "search"
               && filter.trim().length >= 2 && (
```

- [ ] **Step 7: Make the phone icon wear the selected mode**

Replace the collapsed phone button (~line 556) so its glyph and its name are
the mode's, not always the spyglass's:

```tsx
            {phone && !searchExpanded && (
              <button
                onClick={() => setSearchExpanded(true)}
                aria-label={effectiveMode === "search" ? "Search" : "Filter this page"}
                aria-expanded={false}
                className="touch-target shrink-0 flex items-center justify-center p-2.5 rounded-xl bg-fill-soft border border-border-subtle
                           text-fg-muted hover:text-fg-secondary hover:bg-fill transition
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {effectiveMode === "search"
                  ? <Search className="w-4 h-4" aria-hidden />
                  : <Funnel className="w-4 h-4" aria-hidden />}
              </button>
            )}
```

- [ ] **Step 8: Run the new test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/topbarMode.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 9: Repair the topbar tests that named the old box**

Run: `cd frontend && npx vitest run src/__tests__/pageChrome.test.tsx`
Expected: FAIL — the phone-expand button is now named "Filter this page", and
the clear button "Clear filter", because Filter is the default mode.

In `pageChrome.test.tsx`, the two places that click the phone-expand button by
name — `screen.getByRole("button", { name: "Search" })` — become:

```tsx
    fireEvent.click(screen.getByRole("button", { name: "Filter this page" }));
```

In the `describe("emptying the search box")` block, put both tests in Search
mode so they still test what they were written to test, by adding this line at
the top of each test body, before `mockShell()`:

```tsx
    localStorage.setItem("tablo:topbar.mode", "search");
```

and change both `findByLabelText("Search programs, channels")` calls to match —
they will now resolve, since the box is in Search mode.

Re-run: `cd frontend && npx vitest run src/__tests__/pageChrome.test.tsx`
Expected: PASS.

- [ ] **Step 10: Run the whole suite**

Run: `cd frontend && npm test`
Expected: everything except `libraryFilterMemory.test.tsx` passes. That file
still drives the Library's own box, which Task 4 removes — leave it failing and
note the count.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/ChannelGrid.tsx frontend/src/__tests__/topbarMode.test.tsx frontend/src/__tests__/pageChrome.test.tsx
git commit -m "feat(topbar): the switch decides the job, strictly"
```

---

### Task 4: The Library takes the filter it is given

**Files:**
- Modify: `frontend/src/components/LibraryView.tsx` (state ~lines 178-210; toolbar ~lines 681-760)
- Modify: `frontend/src/components/ChannelGrid.tsx` (the `<LibraryView>` render, ~line 748)
- Modify: `frontend/src/__tests__/libraryFilterMemory.test.tsx`

**Interfaces:**
- Consumes: `pageFilter` from Task 3.
- Produces: `LibraryView({ query }: { query: string })`.

- [ ] **Step 1: Retarget the Library filter test**

`libraryFilterMemory.test.tsx` covers a box that is about to stop existing.
Replace its whole `describe` with one that renders the shell, since the box is
now the topbar's. Rewrite the file's body from `function renderLibrary()`
onward as:

```tsx
function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "status").mockResolvedValue({
    authenticated: true, email: "viewer@example.com", devices: [],
    active_sid: null, direct_origin: null,
  });
  vi.spyOn(api, "guideStream").mockImplementation(async function* () {});
  vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {});
  return render(
    <QueryClientProvider client={qc}>
      <ChannelGrid onLogout={() => {}} />
    </QueryClientProvider>,
  );
}

/** The one text box in the topbar, whatever it is currently called. */
function box(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("header input[type=text]")!;
}

describe("the Library filter across a reload", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "#/library");
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    vi.spyOn(api, "storage").mockResolvedValue(
      { pinned_bytes: 0, cache_bytes: 0, free_bytes: 0 } as never);
    vi.spyOn(api, "prefs").mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it("comes back to a filter that was left in the box", async () => {
    localStorage.setItem("tablo:topbar.query", "kratts");

    renderShell();

    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.queryByText("NFL Football")).toBeNull();
  });

  it("adopts the filter left in the Library's own box, before there was one", async () => {
    // One-shot: the old key seeds the new one and is retired, so a viewer
    // mid-session keeps their filter and nobody is left with a dead key.
    localStorage.setItem("tablo:library.filter", "kratts");

    renderShell();

    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(localStorage.getItem("tablo:library.filter")).toBeNull();
  });

  it("remembers what was typed", async () => {
    renderShell();
    await screen.findByText("NFL Football");

    fireEvent.change(box(), { target: { value: "kratts" } });

    await waitFor(() =>
      expect(localStorage.getItem("tablo:topbar.query")).toBe("kratts"));
  });

  it("forgets it when the box is cleared", async () => {
    localStorage.setItem("tablo:topbar.query", "kratts");
    renderShell();
    await screen.findByText("Wild Kratts");

    fireEvent.change(box(), { target: { value: "" } });

    await waitFor(() =>
      expect(localStorage.getItem("tablo:topbar.query")).toBeNull());
    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
  });

  it("works where site data is blocked", async () => {
    // Private mode throws on both ends of this; a filter box is not worth a
    // blank page.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("site data blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("site data blocked");
    });

    renderShell();
    await screen.findByText("NFL Football");

    expect(() => fireEvent.change(box(), { target: { value: "kratts" } })).not.toThrow();
  });

  it("offers a way to empty the box without selecting the text", async () => {
    // Escape does it for a keyboard - but a pointer on a desktop had nothing
    // to aim at, and a filter is the one control that hides things until it is
    // cleared.
    localStorage.setItem("tablo:topbar.query", "kratts");
    renderShell();
    await screen.findByText("Wild Kratts");

    fireEvent.click(screen.getByRole("button", { name: /clear filter/i }));

    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
    expect(localStorage.getItem("tablo:topbar.query")).toBeNull();
  });

  it("offers nothing to clear when the box is empty", async () => {
    renderShell();
    await screen.findByText("NFL Football");

    expect(screen.queryByRole("button", { name: /clear filter/i })).toBeNull();
  });

  it("leaves the Library with one box, not two", async () => {
    // The whole point: two fields forty pixels apart, told apart only by a
    // glyph, and typing in the wrong one said nothing.
    renderShell();
    await screen.findByText("NFL Football");

    expect(document.querySelectorAll("input[type=search]")).toHaveLength(0);
  });
});
```

Update the file's imports to add `ChannelGrid` and drop `LibraryView`:

```tsx
import { ChannelGrid } from "../components/ChannelGrid";
```

Update the file's header comment's last paragraph to say the box is the
topbar's now:

```tsx
 * The box itself moved to the topbar, where it shares one field with the
 * search: two boxes forty pixels apart, told apart only by a glyph, was a
 * choice nobody could make correctly from looking.
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/libraryFilterMemory.test.tsx`
Expected: FAIL — the Library still renders its own `input[type=search]`, and the
topbar's text does not reach it.

- [ ] **Step 3: Take the query as a prop**

In `LibraryView.tsx`, change the signature (line 144) and delete the state that
owned the text. Replace lines 144 and the `const [query, setQuery] = ...`
declaration with:

```tsx
export function LibraryView({ query }: {
  /**
   * What to narrow the library to, decided by the topbar's box.
   *
   * Empty whenever that box is searching rather than filtering, so this
   * component never has to know the mode exists.
   */
  query: string;
}) {
```

Delete the long comment block above the old `useStoredText` call (lines ~160-178
— the one ending "…should not.") along with the call itself: that reasoning now
lives in `lib/topbarMemory`.

Delete these, which only ever served the box:

- `const [filterExpanded, setFilterExpanded] = useState(false);` (line 188)
- `const filterInputRef = useRef<HTMLInputElement>(null);` (line 189)
- the `collapseFilter` callback and its comment (lines ~191-195)
- the focus-follows-expansion effect (lines ~197-202)
- the effect that closes the expansion above 640px (lines ~204-208)

Keep `const phone = useMediaQuery("(max-width: 639px)")` — the Group and Sort
menus still use it — but move its comment, which is about the filter, to say
what it is for now:

```tsx
  /**
   * The width at which the Group and Sort menus drop their prefixes: below
   * 640px the row cannot hold "Group Show" and "Sort Newest" beside the
   * content filter.
   */
  const phone = useMediaQuery("(max-width: 639px)");
```

Remove `useStoredText` from the imports (line 18), and drop `useRef` from the
React import if nothing else in the file uses it (check first: `grep -n "useRef" components/LibraryView.tsx`).

- [ ] **Step 4: Delete the second box**

In the toolbar `<div data-library-toolbar ...>`, delete everything from the
`{phone && !filterExpanded && (` block through the `{phone && filterExpanded && (`
block — the icon button, the field wrapper, the input, the clear button and the
collapse button — leaving `<ContentFilterMenu .../>` as the first child. Replace
the toolbar's leading comment with one that says what is left:

```tsx
      {/* Above the first day's rule, because these narrow every day below them
          and not the one they sit over.

          The text filter is not here any more: it shares the topbar's field
          with the search, which is where the duplicate went. What is left
          groups and orders what that field left behind. */}
      <div data-library-toolbar className="flex flex-wrap items-center gap-3 mb-4">
```

- [ ] **Step 5: Hand it the query**

In `ChannelGrid.tsx`, the Library render becomes:

```tsx
              <LibraryView key={libraryActivation} query={pageFilter} />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/libraryFilterMemory.test.tsx src/__tests__/topbarMode.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the whole suite and fix the fallout**

Run: `cd frontend && npm test`

Other suites render `<LibraryView />` directly and will fail to typecheck or
will filter nothing. Find them with
`grep -rln "LibraryView" frontend/src/__tests__` and give each render
`query=""`, which is what an unfiltered Library was before.

Expected: PASS, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/LibraryView.tsx frontend/src/components/ChannelGrid.tsx frontend/src/__tests__
git commit -m "feat(library): one box, in the topbar"
```

---

### Task 5: Series and the schedule narrow too

**Files:**
- Modify: `frontend/src/components/RecordingsView.tsx` (signature line 136; lists ~lines 142-144; renders ~lines 185-195)
- Modify: `frontend/src/components/ScheduleGrid.tsx` (signature line 82; `visible` memo ~lines 101-108)
- Modify: `frontend/src/components/ChannelGrid.tsx` (the `<RecordingsView>` render, ~line 755)
- Test: `frontend/src/__tests__/seriesFilter.test.tsx` (create)

**Interfaces:**
- Consumes: `pageFilter` from Task 3.
- Produces: `RecordingsView({ query }: { query: string })`, `ScheduleGrid({ query }: { query: string })`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/seriesFilter.test.tsx`:

```tsx
/**
 * The Series tab, narrowed by the topbar's funnel.
 *
 * By title, and by the series title on an upcoming airing: all three segments
 * are lists of shows, so a funnel that worked on two of them would be a funnel
 * that appeared to be broken on the third.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RecordingsView } from "../components/RecordingsView";
import { api, type SeriesCard, type ScheduleRow } from "../api/tablo";

function card(title: string, failed = 0): SeriesCard {
  return {
    recordings_path: `/series/${title}`, identifier: title, guide_path: null,
    kind: "series", title, cover_image_id: null, rule: "all",
    keep: { rule: "all", count: null }, offsets: { start: 0, end: 0, source: "d" },
    episode_count: 1, unwatched_count: 0, protected_count: 0, failed_count: failed,
    scheduled_count: 0, conflict: false,
  } as unknown as SeriesCard;
}

function airing(seriesTitle: string): ScheduleRow {
  return {
    object_id: seriesTitle.length, title: "An episode", season_number: 1,
    episode_number: 1, datetime: "2026-09-23T01:00:00Z", duration: 1800,
    channel: "KUFM", channel_identifier: "A", state: "scheduled",
    skip_reason: null, series_title: seriesTitle, series_cover_image_id: null,
  } as unknown as ScheduleRow;
}

function renderSeries(query: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecordingsView query={query} />
    </QueryClientProvider>,
  );
}

describe("narrowing the Series tab", () => {
  beforeEach(() => {
    vi.spyOn(api.series, "index").mockResolvedValue(
      { series: [card("Wild Kratts"), card("NFL Football", 1)] } as never);
    vi.spyOn(api.series, "schedule").mockResolvedValue(
      [airing("Wild Kratts"), airing("NFL Football")] as never);
    vi.spyOn(api, "prefs").mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows everything when nothing is typed", async () => {
    renderSeries("");
    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.getByText("NFL Football")).toBeInTheDocument();
  });

  it("keeps only the series that match", async () => {
    renderSeries("kratts");
    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.queryByText("NFL Football")).toBeNull();
  });

  it("ignores case and surrounding space, like every other box here", async () => {
    renderSeries("  KRATTS ");
    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.queryByText("NFL Football")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/seriesFilter.test.tsx`
Expected: FAIL — `RecordingsView` takes no props, so TypeScript rejects `query`
and nothing is filtered.

- [ ] **Step 3: Narrow the series lists**

In `RecordingsView.tsx`, add `useMemo` to the React import if it is not there,
change the signature and narrow both lists:

```tsx
export function RecordingsView({ query }: {
  /** What to narrow to, from the topbar's box; empty while it is searching. */
  query: string;
}) {
  const [segment, setSegment] = useState<Segment>("series");
  const [selected, setSelected] = useState<SeriesCard | null>(null);

  const series = useQuery({ queryKey: ["series"], queryFn: api.series.index });

  // By title only: a series card carries counts and a rule, and none of those
  // are what anyone types into a box looking for a show.
  const all = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cards = series.data?.series ?? [];
    if (!needle) return cards;
    return cards.filter(s => s.title.toLowerCase().includes(needle));
  }, [series.data, query]);
  const failed = all.filter((s) => s.failed_count > 0);
```

`conflictCount` must keep counting the whole library, not the narrowed view —
a banner that disappears when you filter is a banner that lies:

```tsx
  // Deliberately over everything rather than over `all`: a conflict does not
  // stop being one because the box is narrowed to something else.
  const conflictCount = (series.data?.series ?? []).filter((s) => s.conflict).length;
```

Hand the query to the upcoming segment:

```tsx
          <ScheduleGrid query={query} />
```

- [ ] **Step 4: Narrow the schedule**

In `ScheduleGrid.tsx`:

```tsx
export function ScheduleGrid({ query }: {
  /** What to narrow to, from the topbar's box; empty while it is searching. */
  query: string;
}) {
```

and fold the needle into the existing `visible` memo, which already owns "what
survives the chips":

```tsx
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      const g = stateMarker(r.state, r.skip_reason).group;
      if (g !== null && !enabled.has(g)) return false; // recording (null) always shown
      if (!needle) return true;
      // The series title and the episode's own: an upcoming airing is as often
      // remembered by the episode as by the show it belongs to.
      return r.series_title.toLowerCase().includes(needle)
        || (r.title?.toLowerCase().includes(needle) ?? false);
    });
  }, [rows, enabled, query]);
```

The existing "Nothing matches these filters." empty state already covers a
needle that matches nothing, since `visible` is what it tests.

- [ ] **Step 5: Hand it the query**

In `ChannelGrid.tsx`:

```tsx
              <RecordingsView query={pageFilter} />
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/seriesFilter.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the whole suite**

Run: `cd frontend && npm test`

Any other suite rendering `<RecordingsView />` or `<ScheduleGrid />` directly
needs `query=""`. Find them with
`grep -rln "RecordingsView\|ScheduleGrid" frontend/src/__tests__`.

Expected: PASS, 0 failures.

- [ ] **Step 8: Typecheck and lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: both clean. `npm run build` runs `tsc -b`, which is the only thing
that catches a prop the tests happen not to exercise.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/RecordingsView.tsx frontend/src/components/ScheduleGrid.tsx frontend/src/components/ChannelGrid.tsx frontend/src/__tests__/seriesFilter.test.tsx
git commit -m "feat(series): the funnel narrows the series tab too"
```

---

### Task 6: See it work

**Files:** none — this is verification in the real app.

- [ ] **Step 1: Bring the stack up on this branch**

Use the `tablo-stack` skill. The frontend is baked into the image at build
time, so this needs a rebuild and a `--force-recreate`, and the backend is a
native host process on `127.0.0.1:8000` that a bare `docker compose up` will
silently replace with a different one.

- [ ] **Step 2: Run the stack check**

Run `check-stack.sh` as the skill describes. Expected: it passes. That is what
"it works" means here.

- [ ] **Step 3: Walk the switch**

At `127.0.0.1:7070`, confirm by eye, in both themes:

- Library shows **one** box, in the topbar, and the toolbar under it starts
  with the content filter.
- Funnel selected, type on Library: recordings narrow, no dropdown.
- Flip to the spyglass with the text still there: the dropdown opens on the
  same words and the Library goes back to whole.
- Live: the funnel narrows channels; the spyglass leaves them alone.
- Series: the funnel narrows series, and the Upcoming segment too.
- Guide: the funnel is greyed; going back to Live gives it back.
- Reload: the mode and the text are both still there.
- Narrow the window below 640px: the collapsed icon is the funnel, not the
  spyglass, while Filter is selected.

The Chrome tab must be the **active** tab for any visual check — a background
tab reports hidden and pauses rAF.

- [ ] **Step 4: Report**

Say what was checked and what was seen. If anything is off, fix it and re-run
`npm test` plus the stack check before claiming the task done.

---

## Self-review

- **Spec coverage:** storage keys and migration → Task 1. The switch, its
  disabled half and the glyph-is-state rule → Task 2. Strict gating, per-tab
  placeholder, Enter, phone icon, Live predicate → Task 3. Library box deleted
  and fed by prop → Task 4. Series and schedule → Task 5. The stale-filter
  hazard is accepted in the spec and needs no code. Guide's schedule-text filter
  is explicitly out of scope and has no task, by design.
- **Type consistency:** `TopbarMode` is the one mode type, exported from
  `lib/topbarMemory` and consumed by `SearchModeToggle` and `ChannelGrid`.
  `query: string` is the prop name on all three of `LibraryView`,
  `RecordingsView` and `ScheduleGrid`; `pageFilter` is the `ChannelGrid` local
  that feeds them.
- **Placeholders:** none. Every code step carries the code.
