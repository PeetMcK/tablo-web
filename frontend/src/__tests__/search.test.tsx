import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSearch } from "../hooks/useSearch";
import { api } from "../api/tablo";
import type { SearchResponse } from "../api/tablo";

const EMPTY: SearchResponse = {
  query: "", coverage: { since: null, last_sync: null }, groups: [],
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useSearch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not call the server for a query too short to mean anything", async () => {
    const spy = vi.spyOn(api, "search").mockResolvedValue(EMPTY);
    renderHook(() => useSearch("b"), { wrapper });
    await new Promise(r => setTimeout(r, 300));
    expect(spy).not.toHaveBeenCalled();
  });

  it("searches once the query is long enough", async () => {
    const spy = vi.spyOn(api, "search").mockResolvedValue({ ...EMPTY, query: "broncos" });
    const { result } = renderHook(() => useSearch("broncos"), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => expect(result.current.data?.query).toBe("broncos"));
  });

  it("debounces a query being typed", async () => {
    const spy = vi.spyOn(api, "search").mockResolvedValue(EMPTY);
    const { rerender } = renderHook(({ q }) => useSearch(q), {
      wrapper, initialProps: { q: "bro" },
    });
    rerender({ q: "bron" });
    rerender({ q: "bronc" });
    rerender({ q: "broncos" });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // Only the settled query reaches the server, not each keystroke.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("broncos", expect.anything());
  });
});

import { render, screen, fireEvent } from "@testing-library/react";
import { SearchResultRow } from "../components/SearchResultRow";
import type { SearchItem } from "../api/tablo";

const ITEM: SearchItem = {
  kind: "airing", ref: "ch1|x", title: "Broncos at Chiefs",
  subtitle: "Week 1", channel: "8.1 CBS",
  start_epoch: 1_760_000_000, duration: 3600,
  target: { tab: "grid", at: "2026-10-09T10:13:20Z" }, recorded: null,
};

describe("SearchResultRow", () => {
  it("shows the title, station and subtitle", () => {
    render(<SearchResultRow item={ITEM} selected={false} onActivate={() => {}} />);
    expect(screen.getByText("Broncos at Chiefs")).toBeInTheDocument();
    expect(screen.getByText("8.1 CBS")).toBeInTheDocument();
    expect(screen.getByText(/Week 1/)).toBeInTheDocument();
  });

  it("says a past airing was recorded, so you know you did not miss it", () => {
    render(
      <SearchResultRow
        item={{ ...ITEM, recorded: { object_id: 80888 } }}
        selected={false}
        onActivate={() => {}}
      />,
    );
    expect(screen.getByText(/recorded/i)).toBeInTheDocument();
  });

  it("activates on click", () => {
    const onActivate = vi.fn();
    render(<SearchResultRow item={ITEM} selected={false} onActivate={onActivate} />);
    fireEvent.click(screen.getByRole("option"));
    expect(onActivate).toHaveBeenCalledWith(ITEM);
  });

  it("marks the selected row for assistive tech, not just visually", () => {
    render(<SearchResultRow item={ITEM} selected onActivate={() => {}} />);
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
  });
});

import { parseRoute, writeRoute } from "../lib/route";

describe("search route", () => {
  it("round-trips a query through the hash", () => {
    expect(parseRoute("#/search?q=broncos")).toEqual({
      tab: "search", watch: null, q: "broncos",
    });
  });

  it("encodes a query with spaces", () => {
    writeRoute({ tab: "search", watch: null, q: "denver broncos" });
    expect(window.location.hash).toContain("q=denver%20broncos");
  });

  it("leaves the other tabs alone", () => {
    expect(parseRoute("#/library/rec/80888")).toEqual({
      tab: "library", watch: { kind: "recording", id: 80888 }, q: undefined,
    });
  });
});

import { SearchDropdown } from "../components/SearchDropdown";

const GROUPED: SearchResponse = {
  query: "broncos",
  coverage: { since: "2026-09-01T00:00:00Z", last_sync: "2026-09-15T18:00:00Z" },
  groups: [
    { kind: "recording", total: 1, items: [{ ...ITEM, kind: "recording", ref: "1" }] },
    { kind: "airing", total: 7, items: [ITEM] },
  ],
};

describe("SearchDropdown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("groups results by kind", async () => {
    vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchDropdown query="broncos" onActivate={() => {}} onSeeAll={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/recordings/i)).toBeInTheDocument();
    expect(await screen.findByText(/guide/i)).toBeInTheDocument();
  });

  it("offers the rest when a group is truncated", async () => {
    vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchDropdown query="broncos" onActivate={() => {}} onSeeAll={() => {}} />
      </QueryClientProvider>,
    );
    // 7 matched, 1 shown.
    expect(await screen.findByText(/6 more/i)).toBeInTheDocument();
  });

  it("says nothing was found rather than showing an empty box", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ ...EMPTY, query: "zzzz" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SearchDropdown query="zzzz" onActivate={() => {}} onSeeAll={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
  });
});

import { ChannelGrid } from "../components/ChannelGrid";

function mockChannelGridApis() {
  vi.spyOn(api, "status").mockResolvedValue({
    authenticated: true, email: "viewer@example.com", devices: [], active_sid: null, direct_origin: null,
  });
  // Neither stream matters to these tests — emptied out so mounting the Guide
  // tab (reached by activating the "airing" result below) does not fire a
  // real, unmocked `fetch`.
  vi.spyOn(api, "guideStream").mockImplementation(async function* () {});
  vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {});
}

function renderChannelGrid() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChannelGrid onLogout={() => {}} />
    </QueryClientProvider>,
  );
}

describe("ChannelGrid search wiring", () => {
  beforeEach(() => {
    // The route hash persists across tests in jsdom; pin it so every test
    // here starts on Live TV regardless of what an earlier test left behind.
    window.history.replaceState(null, "", "#/live");
  });

  afterEach(() => vi.restoreAllMocks());

  it("reopens the dropdown after activating a result, once a new query is typed", async () => {
    mockChannelGridApis();
    vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    renderChannelGrid();

    const input = screen.getByPlaceholderText(/search programs, channels/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "broncos" } });

    // Both groups' items share this title; take the airing one (index 1),
    // whose target is a plain tab switch and needs no channel data in hand.
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    fireEvent.click(options[1]);

    // Closes on activation. Getting here at all exercises the bug that
    // shipped: the dropdown's own mousedown guard keeps the input
    // DOM-focused through this click (so `onActivate` beats `onBlur`), which
    // previously left React's "open" flag desynced from the DOM's focus
    // state — nothing would ever true it back up.
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());

    // Typing a new query, with no intervening click or focus event, must
    // bring the dropdown back.
    fireEvent.change(input, { target: { value: "chiefs" } });
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("closes the dropdown on Escape", async () => {
    mockChannelGridApis();
    vi.spyOn(api, "search").mockResolvedValue(GROUPED);
    renderChannelGrid();

    const input = screen.getByPlaceholderText(/search programs, channels/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "broncos" } });
    await screen.findByRole("listbox");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

import { CommandPalette } from "../components/CommandPalette";

function palette(onActivate = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CommandPalette open onClose={() => {}} onActivate={onActivate} />
    </QueryClientProvider>,
  );
  return onActivate;
}

describe("CommandPalette", () => {
  afterEach(() => vi.restoreAllMocks());

  it("moves the selection with the arrow keys and activates with Enter", async () => {
    vi.spyOn(api, "search").mockResolvedValue({
      ...EMPTY,
      groups: [{
        kind: "airing", total: 2,
        items: [ITEM, { ...ITEM, ref: "ch1|y", title: "Second" }],
      }],
    });
    const onActivate = palette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "broncos" } });
    await screen.findByText("Broncos at Chiefs");

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ title: "Second" }));
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CommandPalette open onClose={onClose} onActivate={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CommandPalette open={false} onClose={() => {}} onActivate={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
