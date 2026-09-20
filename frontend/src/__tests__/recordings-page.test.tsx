import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RecordingsView } from "../components/RecordingsView";
import * as tablo from "../api/tablo";
import type { SeriesCard, SeriesDetail, UpcomingAiring } from "../api/tablo";

const api = tablo.api;

const CARD: SeriesCard = {
  recordings_path: "/recordings/series/1",
  identifier: "C1",
  kind: "series",
  title: "Wild Kratts",
  cover_image_id: null,
  rule: "all",
  keep: { rule: "count", count: 5 },
  offsets: { start: 0, end: 0, source: "none" },
  episode_count: 3,
  unwatched_count: 2,
  protected_count: 0,
  conflict: false,
};

function detailFor(overrides: Partial<SeriesDetail> = {}): SeriesDetail {
  return {
    meta: { title: "Wild Kratts", genres: ["Kids"], description: "d",
            cover_image_id: null, kind: "series" },
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

const UPCOMING: UpcomingAiring[] = [
  { identifier: "LH-CEP1-S1_008_06-T1789923600",
    schedule: { state: "scheduled", qualifier: "show", skip_reason: "none",
                skip_detail: null, offsets: { start: 0, end: 0, source: "none" } } },
  { identifier: "LH-CEP2-S2_011_05-T1789930800",
    schedule: { state: "scheduled", qualifier: "show", skip_reason: "conflict",
                skip_detail: null, offsets: { start: 0, end: 0, source: "none" } } },
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
    vi.spyOn(api.series, "upcoming").mockResolvedValue(UPCOMING);
    vi.spyOn(api.series, "conflicts").mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders series cards with rule/keep/unwatched badges", async () => {
    renderRecordings();
    expect(await screen.findByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getByText("Keep 5")).toBeInTheDocument();
    expect(screen.getByText("2 new")).toBeInTheDocument();
  });

  it("hides the Conflicts segment when there are none", async () => {
    renderRecordings();
    await screen.findByText("Wild Kratts");
    expect(screen.queryByRole("radio", { name: "Conflicts" })).toBeNull();
  });

  it("shows a conflicts banner and the segment when conflicts exist", async () => {
    vi.spyOn(api.series, "conflicts").mockResolvedValue(UPCOMING);
    renderRecordings();
    expect(await screen.findByText(/recordings? conflict/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Conflicts" })).toBeInTheDocument();
  });

  it("groups upcoming airings by day and shows time + channel", async () => {
    renderRecordings();
    await screen.findByText("Wild Kratts");
    fireEvent.click(screen.getByRole("radio", { name: "Upcoming" }));
    // channels parsed from the lineup handles
    expect(await screen.findByText("8.6")).toBeInTheDocument();
    expect(screen.getByText("11.5")).toBeInTheDocument();
    // the skip reason surfaces as a badge
    expect(screen.getByText("conflict")).toBeInTheDocument();
  });
});

describe("Series detail", () => {
  beforeEach(() => {
    vi.spyOn(api.series, "index").mockResolvedValue({ series: [CARD] });
    vi.spyOn(api.series, "upcoming").mockResolvedValue([]);
    vi.spyOn(api.series, "conflicts").mockResolvedValue([]);
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
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ identifier: "C1", rule: "new" }));
  });

  it("keep Number fires a keep count payload", async () => {
    const spy = vi.spyOn(api.series, "update").mockResolvedValue({ identifier: "C1", echo: {} });
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "Number" }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ identifier: "C1", keep: { rule: "count", count: 5 } }));
  });

  it("padding wires seconds, start early is negative", async () => {
    const spy = vi.spyOn(api.series, "update").mockResolvedValue({ identifier: "C1", echo: {} });
    await open();
    const start = screen.getByLabelText("Start padding minutes");
    fireEvent.change(start, { target: { value: "-2" } });
    fireEvent.blur(start);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ identifier: "C1", offsets: { start: -120, end: 0 } }));
  });

  it("delete-all confirms then bulk-deletes unprotected", async () => {
    const spy = vi.spyOn(api.series, "bulkDelete")
      .mockResolvedValue({ ok: true, filter: "unprotected", status: 200 });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    // The confirm button shares the label; scope to the dialog for it.
    const dialog = await screen.findByRole("dialog", { name: /delete all of/i });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete all" }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("/recordings/series/1", "unprotected"));
  });

  it("a per-row protect toggle calls setProtected", async () => {
    const spy = vi.spyOn(api, "setProtected").mockResolvedValue({ object_id: 100, protected: true });
    await open();
    fireEvent.click(screen.getAllByRole("button", { name: "Protect from deletion" })[0]);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(100, true));
  });

  it("un-marking watched writes position 1", async () => {
    const pos = vi.spyOn(api, "setRecordingPosition").mockResolvedValue({ object_id: 100, position: 1 });
    await open();
    // Ep A is watched → its control is "Mark unwatched".
    fireEvent.click(screen.getByRole("button", { name: "Mark unwatched" }));
    await waitFor(() => expect(pos).toHaveBeenCalledWith(100, 1));
  });

  it("multi-select delete loops deleteRecording", async () => {
    const del = vi.spyOn(api, "deleteRecording").mockResolvedValue({ ok: true } as never);
    await open();
    fireEvent.click(screen.getByLabelText("Select Ep A"));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(100));
  });
});
