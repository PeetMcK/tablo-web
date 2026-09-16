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
