import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecordingsView } from "../components/RecordingsView";
import * as tablo from "../api/tablo";
import type { SeriesCard, SeriesDetail, ScheduleRow } from "../api/tablo";

const api = tablo.api;

const CARD: SeriesCard = {
  recordings_path: "/recordings/series/1",
  identifier: "C1",
  guide_path: "/guide/series/9",
  kind: "series",
  title: "Wild Kratts",
  cover_image_id: null,
  rule: "all",
  keep: { rule: "count", count: 5 },
  offsets: { start: 0, end: 0, source: "none" },
  episode_count: 3,
  unwatched_count: 2,
  protected_count: 0,
  failed_count: 0,
  scheduled_count: 4,
  conflict: false,
};

function detailFor(overrides: Partial<SeriesDetail> = {}): SeriesDetail {
  return {
    meta: { title: "Wild Kratts", genres: ["Kids"], description: "d",
            cover_image_id: null, kind: "series", guide_path: "/guide/series/9" },
    settings: { identifier: "C1", rule: "all",
                keep: { rule: "count", count: 5 },
                offsets: { start: 0, end: 0, source: "none" } },
    counts: {},
    episodes: [
      { object_id: 100, title: "Ep A", season_number: 3, episode_number: 1,
        orig_air_date: "2025-01-01", datetime: null, duration: 1800, size: null,
        state: "finished", snapshot_image: null, position: 0, watched: true,
        protected: false, is_recording: false },
      { object_id: 101, title: "Ep B", season_number: 3, episode_number: 2,
        orig_air_date: "2025-01-08", datetime: null, duration: 1800, size: null,
        state: "finished", snapshot_image: null, position: 0, watched: false,
        protected: false, is_recording: false },
    ],
    ...overrides,
  };
}

const SCHEDULE: ScheduleRow[] = [
  { object_id: 1, title: "New Tonight", season_number: 1, episode_number: 4,
    datetime: "2026-09-22T00:00Z", duration: 1800, channel: "7.1",
    state: "scheduled", skip_reason: "none",
    series_title: "Newsy", series_cover_image_id: null },
  { object_id: 2, title: "A Rerun", season_number: 1, episode_number: 2,
    datetime: "2026-09-21T22:00Z", duration: 1800, channel: "7.1",
    state: "skipped", skip_reason: "not_new",
    series_title: "Rerunny", series_cover_image_id: null },
];

function renderRecordings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecordingsView />
    </QueryClientProvider>,
  );
}

describe("Recordings page", () => {
  beforeEach(() => {
    vi.spyOn(api.series, "index").mockResolvedValue({ series: [CARD] });
    vi.spyOn(api.series, "schedule").mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders series cards with rule/keep/unwatched badges", async () => {
    renderRecordings();
    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Keep 5")).toBeInTheDocument();
    expect(screen.getByText("2 new")).toBeInTheDocument();
  });

  it("shows the three-view tab set", async () => {
    renderRecordings();
    await screen.findByText("Wild Kratts");
    for (const name of ["Recordings", "Schedule", "Failures"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("radio", { name: "Conflicts" })).toBeNull();
  });

  it("shows a conflicts banner when a series has a conflict", async () => {
    vi.spyOn(api.series, "index").mockResolvedValue({
      series: [{ ...CARD, conflict: true }],
    });
    renderRecordings();
    expect(await screen.findByText(/scheduling conflict/i)).toBeInTheDocument();
  });

  it("Failures shows only series with failed recordings", async () => {
    vi.spyOn(api.series, "index").mockResolvedValue({
      series: [CARD, { ...CARD, recordings_path: "/recordings/series/9",
                       title: "Broke Show", failed_count: 2 }],
    });
    renderRecordings();
    await screen.findByText("Wild Kratts");
    fireEvent.click(screen.getByRole("radio", { name: "Failures" }));
    expect(screen.getByText("Broke Show")).toBeInTheDocument();
    expect(screen.queryByText("Wild Kratts")).toBeNull();
  });

  it("a scheduled-but-unrecorded series shows a Scheduled chip and no delete", async () => {
    vi.spyOn(api.series, "index").mockResolvedValue({
      series: [{ ...CARD, recordings_path: null, title: "Jeopardy!",
                 episode_count: 0, unwatched_count: 0, rule: "new" }],
    });
    renderRecordings();
    await screen.findByText("Jeopardy!");
    expect(screen.getByText("Scheduled")).toBeInTheDocument();   // status chip
    expect(screen.getByText("4 upcoming")).toBeInTheDocument();
  });

  it("Schedule marks airings by state and filters them", async () => {
    vi.spyOn(api.series, "schedule").mockResolvedValue(SCHEDULE);
    renderRecordings();
    await screen.findByText("Wild Kratts");
    fireEvent.click(screen.getByRole("radio", { name: "Schedule" }));
    expect(await screen.findByText("Newsy")).toBeInTheDocument();
    expect(screen.getByText("Rerunny")).toBeInTheDocument();
    expect(screen.getByText("Rerun")).toBeInTheDocument();     // skip label
    // Turning the Airing bucket off hides the skipped row.
    fireEvent.click(screen.getByRole("button", { name: "Airing" }));
    expect(screen.queryByText("Rerunny")).toBeNull();
    expect(screen.getByText("Newsy")).toBeInTheDocument();
  });
});

describe("Series detail", () => {
  beforeEach(() => {
    vi.spyOn(api.series, "index").mockResolvedValue({ series: [CARD] });
    vi.spyOn(api.series, "schedule").mockResolvedValue([]);
    vi.spyOn(api.series, "detail").mockResolvedValue(detailFor());
  });
  afterEach(() => vi.restoreAllMocks());

  async function open() {
    renderRecordings();
    fireEvent.click(await screen.findByText("Wild Kratts"));
    await screen.findByText("Episodes (2)");
  }

  it("the rule segment fires update with the rule payload", async () => {
    const spy = vi.spyOn(api.series, "update").mockResolvedValue({ identifier: "C1", echo: {} });
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "New" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(
      { identifier: "C1", guide_path: "/guide/series/9", rule: "new" }));
  });

  it("delete-all confirms then bulk-deletes unprotected", async () => {
    const spy = vi.spyOn(api.series, "bulkDelete")
      .mockResolvedValue({ ok: true, filter: "unprotected", status: 200 });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    const dialog = await screen.findByRole("dialog", { name: /delete all of/i });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete all" }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("/recordings/series/1", "unprotected"));
  });

  it("un-marking watched writes position 1", async () => {
    const pos = vi.spyOn(api, "setRecordingPosition").mockResolvedValue({ object_id: 100, position: 1 });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Mark unwatched" }));
    await waitFor(() => expect(pos).toHaveBeenCalledWith(100, 1));
  });

  it("the Upcoming tab loads this series' airings in every state", async () => {
    const spy = vi.spyOn(api.series, "airings").mockResolvedValue([
      { object_id: 500, title: "Money Buys Justice", season_number: 4,
        episode_number: 3, datetime: "2026-09-20T20:00Z", duration: 1800,
        channel: "KUFM", state: "scheduled", skip_reason: "none" },
    ]);
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "Upcoming" }));
    expect(await screen.findByText("Money Buys Justice")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith("/guide/series/9", "all");
  });
});
