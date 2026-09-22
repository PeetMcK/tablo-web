/**
 * The panel for a series that no longer exists.
 *
 * "Turn off & delete all" deletes the last thing holding the series together:
 * the device drops `/recordings/series/{id}` once its episodes are gone, and
 * every read of it afterwards is a 404. That 404 is the action succeeding, and
 * the panel used to treat it as a failed fetch — React Query retried it three
 * times on the default policy, and the drawer stayed open listing episodes out
 * of the cache that the device no longer had.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SeriesDetail } from "../components/SeriesDetail";
import { ApiError, api } from "../api/tablo";
import type { SeriesCard, SeriesDetail as SeriesDetailData } from "../api/tablo";

const CARD: SeriesCard = {
  recordings_path: "/recordings/series/96305",
  identifier: "C1",
  guide_path: "/guide/series/9",
  kind: "series",
  title: "The Open Mind",
  cover_image_id: null,
  rule: "all",
  keep: { rule: "none", count: null },
  offsets: { start: 0, end: 0, source: "none" },
  episode_count: 1,
  unwatched_count: 1,
  protected_count: 0,
  failed_count: 0,
  scheduled_count: 0,
  conflict: false,
  recording_now: false,
};

function detailFor(): SeriesDetailData {
  return {
    meta: { title: "The Open Mind", genres: ["Talk"], description: "d",
            cover_image_id: null, kind: "series", guide_path: "/guide/series/9" },
    settings: { identifier: "C1", rule: "all",
                keep: { rule: "none", count: null },
                offsets: { start: 0, end: 0, source: "none" },
                channel_path: null },
    counts: {},
    episodes: [
      { object_id: 94867, title: "Michelle Bachelet", season_number: 45,
        episode_number: 25, orig_air_date: "2026-08-09", datetime: null,
        duration: 1080, size: 298_000_000, state: "finished",
        snapshot_image: null, position: 0, watched: false, protected: false,
        is_recording: false, channel_identifier: "S34654_008_01" },
    ],
  };
}

function renderPanel(onClose: () => void) {
  // The app's own defaults, minus the wait: a retry that would happen has to
  // happen inside the test rather than a second later.
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  return render(
    <QueryClientProvider client={qc}>
      <SeriesDetail card={CARD} onClose={onClose} />
    </QueryClientProvider>,
  );
}

describe("a series that is gone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("closes the panel when the device no longer has the series", async () => {
    let gone = false;
    const detail = vi.spyOn(api.series, "detail").mockImplementation(async () => {
      if (gone) throw new ApiError(404, "Series /recordings/series/96305 not found");
      return detailFor();
    });
    vi.spyOn(api.series, "update").mockResolvedValue({ ok: true } as never);
    vi.spyOn(api.series, "bulkDelete").mockImplementation(async () => {
      gone = true;
      return { ok: true, filter: "unprotected", status: 200 };
    });
    vi.spyOn(api.series, "airings").mockResolvedValue([]);
    vi.spyOn(api.series, "channels").mockResolvedValue([]);
    vi.spyOn(api, "recordings").mockResolvedValue(
      { recordings: [], returned: 0, total: 0, offline_only: 0 } as never);
    const onClose = vi.fn();

    renderPanel(onClose);
    await screen.findByText("Michelle Bachelet");

    fireEvent.click(screen.getByRole("button", { name: "Turn off & delete all" }));
    const dialog = await screen.findByRole("dialog", { name: /delete all episodes/i });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Turn off & delete all" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // And it was asked exactly three times: once to open the panel, then once
    // per mutation settling - the rule write and the delete. A 404 is an
    // answer, not a flake, so none of those is re-asked. Without that, the
    // default policy spent three retries on each failure and read a deleted
    // series six times.
    await new Promise((r) => setTimeout(r, 200));
    expect(detail).toHaveBeenCalledTimes(3);
  });
});
