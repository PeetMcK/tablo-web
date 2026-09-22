/**
 * The Library's filter, across a reload.
 *
 * It used to be deliberately momentary, on the reasoning that restoring it
 * tomorrow would open the page on a question nobody asked. A refresh is not
 * tomorrow: it is the same sitting, usually after a change on screen, and
 * losing the filter there means retyping it to get back to where you were.
 *
 * In this browser rather than on the server, unlike grouping and order: those
 * are how a person reads the page and should follow them between machines,
 * while this is where one pair of eyes happens to be looking right now.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LibraryView } from "../components/LibraryView";
import { api } from "../api/tablo";
import type { Recording, RecordingList } from "../api/tablo";

const REC: Recording = {
  object_id: 80888, identifier: 80888, path: "/recordings/sports/events/80888",
  title: "NFL Football", subtitle: "Giants at Rams", description: "d",
  start: "2026-09-21T00:15:00Z", series_path: null, sport_path: null,
  season_number: null, episode_number: null, orig_air_date: null,
  duration: 12615, recorded_seconds: null, expected_seconds: null,
  recording_started: null, slot_seconds: 10800,
  thumbnail: null, width: 1280, height: 720, state: "finished", error: null,
  watched: false, position: 0, protected: false, cache_state: "absent",
  cache_progress: 0, pinned: false, offline_only: false, paused: false,
  cached_seconds: 0, cached_ranges: [], rate: { mbps: 0, realtime: 0 },
  channel: { identifier: "S1", call_sign: "ABC", network: "ABC", number: "23.1", kind: "ota" },
  scan: "720p", interlaced: false, codec: "mpeg2", size: null, kind: "sport",
  has_preview: false, image_url: null, cover_frame: null, genres: [],
} as unknown as Recording;

const OTHER: Recording = { ...REC, object_id: 99, title: "Wild Kratts", subtitle: "Bugs" };

function list(): RecordingList {
  return { recordings: [REC, OTHER], returned: 2, total: 2, offline_only: 0 } as RecordingList;
}

function renderLibrary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LibraryView />
    </QueryClientProvider>,
  );
}

describe("the Library filter across a reload", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    vi.spyOn(api, "storage").mockResolvedValue(
      { pinned_bytes: 0, cache_bytes: 0, free_bytes: 0 } as never);
    vi.spyOn(api, "prefs").mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it("comes back to a filter that was left in the box", async () => {
    localStorage.setItem("tablo:library.filter", "kratts");

    renderLibrary();

    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.queryByText("NFL Football")).toBeNull();
  });

  it("remembers what was typed", async () => {
    renderLibrary();
    await screen.findByText("NFL Football");

    fireEvent.change(screen.getByLabelText("Filter recordings"), {
      target: { value: "kratts" },
    });

    await waitFor(() =>
      expect(localStorage.getItem("tablo:library.filter")).toBe("kratts"));
  });

  it("forgets it when the box is cleared", async () => {
    localStorage.setItem("tablo:library.filter", "kratts");
    renderLibrary();
    await screen.findByText("Wild Kratts");

    fireEvent.change(screen.getByLabelText("Filter recordings"), {
      target: { value: "" },
    });

    await waitFor(() =>
      expect(localStorage.getItem("tablo:library.filter")).toBeNull());
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

    renderLibrary();
    await screen.findByText("NFL Football");

    expect(() => fireEvent.change(screen.getByLabelText("Filter recordings"), {
      target: { value: "kratts" },
    })).not.toThrow();
  });

  it("offers a way to empty the box without selecting the text", async () => {
    // Escape does it for a keyboard, and the phone layout has a collapse - but
    // a pointer on a desktop had nothing to aim at, and a filter is the one
    // control that hides things until it is cleared.
    localStorage.setItem("tablo:library.filter", "kratts");
    renderLibrary();
    await screen.findByText("Wild Kratts");

    fireEvent.click(screen.getByRole("button", { name: /clear filter/i }));

    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
    expect(localStorage.getItem("tablo:library.filter")).toBeNull();
  });

  it("offers nothing to clear when the box is empty", async () => {
    renderLibrary();
    await screen.findByText("NFL Football");

    expect(screen.queryByRole("button", { name: /clear filter/i })).toBeNull();
  });
});
