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
