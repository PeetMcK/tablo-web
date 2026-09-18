import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SeriesEndCard } from "../components/SeriesEndCard";
import { api } from "../api/tablo";
import type { Recording } from "../api/tablo";

/** A recording, with everything absent unless a test asks for it. */
function rec(over: Partial<Recording> & { object_id: number }): Recording {
  return {
    identifier: over.object_id,
    path: `/recordings/series/episodes/${over.object_id}`,
    title: "Carl the Collector",
    subtitle: null,
    description: null,
    start: "2026-09-17T17:00:00Z",
    series_path: "/recordings/series/86119",
    season_number: null,
    episode_number: null,
    orig_air_date: null,
    duration: 1800,
    recorded_seconds: null,
    expected_seconds: null,
    recording_started: null,
    slot_seconds: 1800,
    thumbnail: null,
    width: null,
    height: null,
    state: "finished",
    error: null,
    watched: false,
    position: 0,
    cache_state: "absent",
    cache_progress: 0,
    pinned: false,
    offline_only: false,
    paused: false,
    cached_seconds: 0,
    rate: { mbps: 0, realtime: 0 },
    channel: null,
    scan: null,
    interlaced: false,
    ...over,
  };
}

function show(finished: Recording, all: Recording[], onPlay = vi.fn(), onClose = vi.fn()) {
  vi.spyOn(api, "recordings").mockResolvedValue({
    recordings: all, returned: all.length, total: all.length, offline_only: 0,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <SeriesEndCard finished={finished} onPlay={onPlay} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onPlay, onClose };
}

const EP5 = rec({ object_id: 1, season_number: 1, episode_number: 5, subtitle: "The Tools" });
const EP30 = rec({ object_id: 2, season_number: 1, episode_number: 30, subtitle: "The Sticks" });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "recordingSeries").mockResolvedValue({
    series_path: "/recordings/series/86119",
    title: "Carl the Collector",
    cover_image: 9345,
  });
});

describe("the card at the end of a recording", () => {
  it("lists the show in order, oldest first", async () => {
    show(EP5, [EP30, EP5]);
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("The Tools"),
      expect.stringContaining("The Sticks"),
    ]);
  });

  it("marks the one just watched in its place, rather than hiding it", async () => {
    // The card is the show with your place marked in it. Removing the episode
    // just finished takes away the only thing that says where that is.
    show(EP5, [EP30, EP5]);
    expect(await screen.findByText("Just watched")).toBeTruthy();
  });

  it("does not offer to replay the one just watched", async () => {
    const { onPlay } = show(EP5, [EP30, EP5]);
    const rows = await screen.findAllByRole("listitem");
    fireEvent.click(rows[0].querySelector("button")!);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("plays the one that is picked", async () => {
    const { onPlay } = show(EP5, [EP30, EP5]);
    const rows = await screen.findAllByRole("listitem");
    fireEvent.click(rows[1].querySelector("button")!);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ object_id: 2 }));
  });

  it("says which of the others have been watched", async () => {
    show(EP5, [{ ...EP30, watched: true }, EP5]);
    expect(await screen.findByText("Watched")).toBeTruthy();
  });

  it("does not call the one just watched 'Watched' as well", async () => {
    // It is about to be, and the device is being told so — but saying it here
    // leaves the viewer hunting for their own row among several alike.
    show({ ...EP5, watched: true }, [{ ...EP30, watched: true }, { ...EP5, watched: true }]);
    await screen.findByText("Just watched");
    expect(screen.getAllByText("Watched")).toHaveLength(1);
  });

  it("leads with the series cover", async () => {
    show(EP5, [EP30, EP5]);
    await waitFor(() => {
      const img = document.querySelector("img");
      expect(img?.getAttribute("src")).toBe("/api/channels/image/9345");
    });
  });

  it("shows sport with no cover at all, which is ordinary", async () => {
    // Sport has no series record to ask, so there is nothing to lead with. The
    // list is the point; the poster is the dressing.
    vi.spyOn(api, "recordingSeries").mockResolvedValue({
      series_path: null, title: null, cover_image: null,
    });
    const game = (object_id: number, start: string) => rec({
      object_id, title: "NFL Football", subtitle: null,
      series_path: null, start,
    });
    const first = game(1, "2026-09-13T17:00:00Z");
    const second = game(2, "2026-09-15T00:15:00Z");
    show(first, [second, first]);

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(document.querySelector("img")).toBeNull();
  });

  it("offers a way out and nothing else for a one-off", async () => {
    // A movie, or the only recording of its show. Nothing to list is not a
    // failure and must not read as one.
    const only = rec({ object_id: 1, series_path: null, title: "Some Film" });
    const { onClose } = show(only, [only]);
    const back = await screen.findByText("Back to Library");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from the corner", async () => {
    const { onClose } = show(EP5, [EP30, EP5]);
    fireEvent.click(await screen.findByLabelText("Back to Library"));
    expect(onClose).toHaveBeenCalled();
  });
});
