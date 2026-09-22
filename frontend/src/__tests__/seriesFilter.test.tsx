/**
 * The Series tab, narrowed by the topbar's funnel.
 *
 * By title, and by the series title on an upcoming airing: all three segments
 * are lists of shows, so a funnel that worked on two of them would be a funnel
 * that appeared to be broken on the third.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("narrows the upcoming airings too", async () => {
    // The third segment is a list of shows like the other two. A funnel that
    // worked on two of them would look broken here.
    renderSeries("kratts");
    fireEvent.click(await screen.findByRole("radio", { name: /upcoming/i }));

    expect(await screen.findByText(/Wild Kratts/)).toBeInTheDocument();
    expect(screen.queryByText(/NFL Football/)).toBeNull();
  });
});
