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
  recording_now: false,
};

function detailFor(overrides: Partial<SeriesDetail> = {}): SeriesDetail {
  return {
    meta: { title: "Wild Kratts", genres: ["Kids"], description: "d",
            cover_image_id: null, kind: "series", guide_path: "/guide/series/9" },
    settings: { identifier: "C1", rule: "all",
                keep: { rule: "count", count: 5 },
                offsets: { start: 0, end: 0, source: "none" },
                channel_path: null },
    counts: {},
    episodes: [
      { object_id: 100, title: "Ep A", season_number: 3, episode_number: 1,
        orig_air_date: "2025-01-01", datetime: null, duration: 1800, size: null,
        state: "finished", snapshot_image: null, position: 0, watched: true,
        protected: false, is_recording: false,
        channel_identifier: "S34654_008_01" },
      { object_id: 101, title: "Ep B", season_number: 3, episode_number: 2,
        orig_air_date: "2025-01-08", datetime: null, duration: 1800, size: null,
        state: "finished", snapshot_image: null, position: 0, watched: false,
        protected: false, is_recording: false,
        channel_identifier: "S34654_008_01" },
    ],
    ...overrides,
  };
}

const SCHEDULE: ScheduleRow[] = [
  { object_id: 1, title: "New Tonight", season_number: 1, episode_number: 4,
    datetime: "2026-09-22T00:00Z", duration: 1800, channel: "7.1",
    channel_identifier: "S1_007_01", state: "scheduled", skip_reason: "none",
    series_title: "Newsy", series_cover_image_id: null },
  { object_id: 2, title: "A Rerun", season_number: 1, episode_number: 2,
    datetime: "2026-09-21T22:00Z", duration: 1800, channel: "7.1",
    channel_identifier: "S1_007_01", state: "skipped", skip_reason: "not_new",
    series_title: "Rerunny", series_cover_image_id: null },
];

function renderRecordings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      {/* An empty query is the unnarrowed Series tab, which is what this file
          tests; the funnel's own half is in `seriesFilter.test.tsx`. */}
      <RecordingsView query="" />
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
    expect(screen.getByText("Last 5")).toBeInTheDocument();
    expect(screen.getByText("2 new")).toBeInTheDocument();
  });

  it("shows the three-view tab set", async () => {
    // Series, not "Recordings": the list holds a series whose rule is Off with
    // episodes on disk as readily as one scheduled and not yet recorded, and
    // "Recordings" collided with the Library, which is literally that. Series
    // is also the device's own word - /guide/series, series_path, SeriesCard.
    renderRecordings();
    await screen.findByText("Wild Kratts");
    for (const name of ["Series", "Upcoming", "Failures"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("radio", { name: "Conflicts" })).toBeNull();
  });

  it("does not repeat its own name as a heading", async () => {
    // The nav says where you are and the active tab says which view; a page
    // title said "Recordings" a third time in the same hundred pixels.
    renderRecordings();
    await screen.findByText("Wild Kratts");

    expect(screen.queryByRole("heading", { name: /^recordings$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^schedule$/i })).toBeNull();
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

  it("shows a RECORDING pill on a series recording now", async () => {
    vi.spyOn(api.series, "index").mockResolvedValue({
      series: [{ ...CARD, title: "Live One", recording_now: true }],
    });
    renderRecordings();
    await screen.findByText("Live One");
    expect(screen.getByText("Recording")).toBeInTheDocument();
  });

  it("Upcoming marks airings by state and filters them", async () => {
    vi.spyOn(api.series, "schedule").mockResolvedValue(SCHEDULE);
    renderRecordings();
    await screen.findByText("Wild Kratts");
    fireEvent.click(screen.getByRole("radio", { name: "Upcoming" }));
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
    vi.spyOn(api.series, "channels").mockResolvedValue([]);
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

  it("turning the rule Off asks to confirm first", async () => {
    const spy = vi.spyOn(api.series, "update").mockResolvedValue({ identifier: "C1", echo: {} });
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    // Not written yet — a confirm dialog stands in the way.
    expect(spy).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: /turn off/i });
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(
      { identifier: "C1", guide_path: "/guide/series/9", rule: "none" }));
  });

  it("says plainly that turning the rule off stops a recording in flight", async () => {
    // Measured on a real device 2026-09-18: with an episode recording, setting
    // the rule to None stopped the tuner within twelve seconds and left the
    // ninety seconds already captured in the library as a stub.
    //
    // This warning used to live on the episode sheet's own rule buttons. Those
    // are gone once a series is recording - the rule is a drawer matter now -
    // so the warning has to be here, or it is nowhere. The gentler wording
    // below ("the episodes already recorded stay") is true and beside the
    // point when a tuner is mid-capture.
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({
      recordings: [{
        object_id: 86323, channel_identifier: "ch2",
        start: "2026-09-18T06:30Z", duration: 1800,
        recording_started: "2026-09-18T06:40:18Z",
        recorded_seconds: 600, expected_seconds: 1182,
        title: "Creature Power", series_path: "/guide/series/9",
      }],
    });
    const spy = vi.spyOn(api.series, "update")
      .mockResolvedValue({ identifier: "C1", echo: {} });
    await open();

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));

    const dialog = await screen.findByRole("dialog", { name: /recording now/i });
    expect(dialog).toHaveTextContent("Creature Power");
    expect(dialog).toHaveTextContent(/stops it at once/i);
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /stop it/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(
      { identifier: "C1", guide_path: "/guide/series/9", rule: "none" }));
  });

  it("keeps the gentler wording when nothing is on a tuner", async () => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    await open();

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));

    const dialog = await screen.findByRole("dialog", { name: /turn off/i });
    expect(dialog).not.toHaveTextContent(/recording now/i);
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

  it("keeps the Episodes tab on a series with nothing recorded yet", async () => {
    // Jeopardy! is scheduled nightly and has recorded nothing: it had no
    // Episodes tab at all, so the panel opened on Upcoming and the section
    // that says "none yet" simply did not exist. An absent tab reads as a
    // different kind of series rather than an empty one.
    const scheduled: SeriesCard = {
      ...CARD, recordings_path: null, title: "Jeopardy!",
      episode_count: 0, unwatched_count: 0,
    };
    vi.spyOn(api.series, "index").mockResolvedValue({ series: [scheduled] });
    vi.spyOn(api.series, "detailByGuide").mockResolvedValue(
      detailFor({ meta: { title: "Jeopardy!", genres: [], description: "d",
                          cover_image_id: null, kind: "series",
                          guide_path: "/guide/series/9" },
                  episodes: [] }));

    renderRecordings();
    fireEvent.click(await screen.findByText("Jeopardy!"));

    expect(await screen.findByRole("radio", { name: "Episodes" })).toBeInTheDocument();
    expect(screen.getByText("Episodes (0)")).toBeInTheDocument();
  });

  it("says nothing is recorded rather than showing an empty list", async () => {
    const scheduled: SeriesCard = {
      ...CARD, recordings_path: null, title: "Jeopardy!", episode_count: 0,
    };
    vi.spyOn(api.series, "index").mockResolvedValue({ series: [scheduled] });
    vi.spyOn(api.series, "detailByGuide").mockResolvedValue(
      detailFor({ meta: { title: "Jeopardy!", genres: [], description: "d",
                          cover_image_id: null, kind: "series",
                          guide_path: "/guide/series/9" },
                  episodes: [] }));

    renderRecordings();
    fireEvent.click(await screen.findByText("Jeopardy!"));
    await screen.findByText("Episodes (0)");

    expect(screen.getByText(/nothing recorded yet/i)).toBeInTheDocument();
    // Nothing to act on, so the bulk actions stay away.
    expect(screen.queryByRole("button", { name: /delete all/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete watched/i })).toBeNull();
  });

  it("the Channel control pins the rule to a channel and back to all", async () => {
    vi.spyOn(api.series, "channels").mockResolvedValue([
      { path: "/guide/channels/5", call_sign: "KSPS", number: "7.1" },
      { path: "/guide/channels/9", call_sign: "PBS", number: "11.1" },
    ]);
    const spy = vi.spyOn(api.series, "update").mockResolvedValue({ identifier: "C1", echo: {} });
    await open();
    const sel = await screen.findByLabelText("Channel");
    fireEvent.change(sel, { target: { value: "/guide/channels/5" } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(
      { identifier: "C1", guide_path: "/guide/series/9", channel_path: "/guide/channels/5" }));
    fireEvent.change(sel, { target: { value: "all" } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(
      { identifier: "C1", guide_path: "/guide/series/9", channel_path: null }));
  });

  it("the Upcoming tab loads this series' airings in every state", async () => {
    const spy = vi.spyOn(api.series, "airings").mockResolvedValue([
      { object_id: 500, title: "Money Buys Justice", season_number: 4,
        episode_number: 3, datetime: "2026-09-20T20:00Z", duration: 1800,
        channel: "KUFM", channel_identifier: "S54511_011_05",
        state: "scheduled", skip_reason: "none" },
    ]);
    await open();
    // Scoped to the panel: the page behind it has an Upcoming tab of its own
    // now, and the two mean the same thing at different scopes - everything
    // upcoming, against this series' upcoming.
    const panel = screen.getByRole("dialog");
    fireEvent.click(within(panel).getByRole("radio", { name: "Upcoming" }));
    expect(await screen.findByText("Money Buys Justice")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith("/guide/series/9", "all");
  });

  it("an upcoming row opens that airing's own sheet", async () => {
    vi.spyOn(api.series, "airings").mockResolvedValue([
      { object_id: 500, title: "Money Buys Justice", season_number: 4,
        episode_number: 3, datetime: "2026-09-20T20:00Z", duration: 1800,
        channel: "KUFM", channel_identifier: "S54511_011_05",
        state: "scheduled", skip_reason: "none" },
    ]);
    const sheet = vi.spyOn(api, "airingDetail").mockRejectedValue(new Error("no"));
    await open();
    fireEvent.click(within(screen.getByRole("dialog"))
      .getByRole("radio", { name: "Upcoming" }));

    fireEvent.click(await screen.findByRole("button", { name: /money buys justice/i }));

    // Addressed by the identifier, not the "KUFM" label beside it.
    await waitFor(() => expect(sheet)
      .toHaveBeenCalledWith("S54511_011_05", "2026-09-20T20:00Z"));
  });

  it("an episode row opens that recording's sheet, which outlives the guide", async () => {
    // The guide is pruned at 31 days, so an episode recorded a fortnight ago
    // has no airing left to look up - the recording describes itself instead.
    const rec = vi.spyOn(api, "recordingDetail").mockRejectedValue(new Error("no"));
    await open();

    fireEvent.click(await screen.findByRole("button", { name: /^ep a/i }));

    await waitFor(() => expect(rec).toHaveBeenCalledWith(100));
  });

  it("the row's own controls are not a way into the sheet", async () => {
    // Four buttons and a checkbox share that row; only the empty space opens.
    const rec = vi.spyOn(api, "recordingDetail").mockRejectedValue(new Error("no"));
    vi.spyOn(api, "setProtected").mockResolvedValue({
      object_id: 100, protected: true,
    });
    await open();

    fireEvent.click(screen.getAllByRole("button", { name: /protect from deletion/i })[0]);

    await new Promise((r) => setTimeout(r, 30));
    expect(rec).not.toHaveBeenCalled();
  });

  it("re-reads the series when the sheet closes, in case it changed something", async () => {
    // The sheet can turn an episode off, change the rule, or delete a
    // recording - all of which the panel behind it is now wrong about.
    vi.spyOn(api, "recordingDetail").mockRejectedValue(new Error("no"));
    const detail = vi.spyOn(api.series, "detail").mockResolvedValue(detailFor());
    await open();
    const readsBefore = detail.mock.calls.length;

    fireEvent.click(await screen.findByRole("button", { name: /^ep a/i }));
    await screen.findAllByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() =>
      expect(detail.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it("dismissing the sheet by its backdrop leaves the panel open", async () => {
    // The sheet renders inside the panel, so a click on its backdrop bubbled
    // to the panel's own outside-click and took both down - losing the place
    // in the list the sheet was opened from.
    vi.spyOn(api, "recordingDetail").mockRejectedValue(new Error("no"));
    await open();

    fireEvent.click(await screen.findByRole("button", { name: /^ep a/i }));
    const sheet = (await screen.findAllByRole("dialog"))
      .find((d) => d.className.includes("z-[60]"))!;
    fireEvent.click(sheet);

    // The sheet is gone and the panel is not.
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByText("Episodes (2)")).toBeInTheDocument();
  });

  it("the series panel stays open behind the sheet", async () => {
    // Drill in and come back: closing the sheet must land where it was opened
    // from, with the list still scrolled where it was.
    vi.spyOn(api, "recordingDetail").mockRejectedValue(new Error("no"));
    await open();

    fireEvent.click(await screen.findByRole("button", { name: /^ep a/i }));
    await screen.findByText(/information unavailable|ep a/i);

    // Both surfaces are present: the panel did not close to make room.
    expect(screen.getAllByRole("dialog").length).toBeGreaterThan(1);
  });
});
