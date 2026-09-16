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
