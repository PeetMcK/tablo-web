/**
 * Opening a show's panel from an episode of it.
 *
 * The hook takes whichever path the caller has: a guide airing knows the show
 * as `/guide/series/{id}` or `/guide/sports/{id}`, a recording knows it as
 * `/recordings/…`. Both are on the same index card, and only the second
 * survives the airing leaving the guide — which for a game is days.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useSeriesDrawer } from "../lib/useSeriesDrawer";
import { api } from "../api/tablo";
import type { SeriesCard, SeriesDetail } from "../api/tablo";

const NFL: SeriesCard = {
  recordings_path: "/recordings/sports/63558",
  identifier: "C191277_SPORTS_SH000031280000",
  guide_path: "/guide/sports/38763",
  kind: "sports",
  title: "NFL Football",
  cover_image_id: 38765,
  rule: "all",
  keep: { rule: "none", count: null },
  offsets: { start: 0, end: 0, source: "none" },
  episode_count: 5,
  unwatched_count: 4,
  protected_count: 0,
  failed_count: 0,
  scheduled_count: 0,
  conflict: false,
  recording_now: false,
};

function detailFor(): SeriesDetail {
  return {
    meta: { title: "NFL Football", genres: ["Football"],
            description: "Football action from around the National Football League.",
            cover_image_id: 38765, kind: "sports",
            guide_path: "/guide/sports/38763" },
    settings: { identifier: NFL.identifier, rule: "all",
                keep: { rule: "none", count: null },
                offsets: { start: 0, end: 0, source: "none" },
                channel_path: null },
    counts: {},
    episodes: [
      { object_id: 66220, title: "Green Bay Packers at Minnesota Vikings",
        season_number: null, episode_number: null, orig_air_date: null,
        datetime: "2026-09-13T20:25Z", duration: 12915, size: null,
        state: "finished", snapshot_image: null, position: 0, watched: false,
        protected: false, is_recording: false,
        channel_identifier: "S34654_008_01" },
    ],
  };
}

/** A button that opens the panel for `path`, plus the panel itself. */
function Harness({ path }: { path: string }) {
  const { openSeries, drawer } = useSeriesDrawer();
  return (
    <>
      <button onClick={() => void openSeries(path, "NFL Football")}>open</button>
      {drawer}
    </>
  );
}

function renderHarness(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness path={path} />
    </QueryClientProvider>,
  );
}

describe("the series drawer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finds a sport by its guide path", async () => {
    vi.spyOn(api.series, "index").mockResolvedValue({ series: [NFL] });
    const detail = vi.spyOn(api.series, "detail").mockResolvedValue(detailFor());
    renderHarness("/guide/sports/38763");

    fireEvent.click(screen.getByRole("button", { name: "open" }));

    // Read by the path the panel's episode list lives under, not the one it
    // was opened by: the card carries both.
    await waitFor(() =>
      expect(detail).toHaveBeenCalledWith("/recordings/sports/63558"));
    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
  });

  it("finds the same show by its recordings path", async () => {
    // What a recording's sheet has, and all it has once the game has been
    // played and its airing has left the guide.
    vi.spyOn(api.series, "index").mockResolvedValue({ series: [NFL] });
    const detail = vi.spyOn(api.series, "detail").mockResolvedValue(detailFor());
    renderHarness("/recordings/sports/63558");

    fireEvent.click(screen.getByRole("button", { name: "open" }));

    await waitFor(() =>
      expect(detail).toHaveBeenCalledWith("/recordings/sports/63558"));
    expect(await screen.findByText(/Green Bay Packers/)).toBeInTheDocument();
  });

  it("opens the moment it is asked, not when the index answers", async () => {
    // The index is a round trip over every series on the box. Waiting for it
    // before drawing anything left a click that did nothing for as long as it
    // took, which reads as a dead control rather than a slow one.
    let land: (v: { series: SeriesCard[] }) => void = () => {};
    vi.spyOn(api.series, "index").mockReturnValue(
      new Promise(resolve => { land = resolve; }));
    vi.spyOn(api.series, "detail").mockResolvedValue(detailFor());
    renderHarness("/guide/sports/38763");

    fireEvent.click(screen.getByRole("button", { name: "open" }));

    // On screen already, with the title the caller handed over and a word
    // about what it is waiting for.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("NFL Football").length).toBeGreaterThan(0);
    expect(screen.getByText(/Fetching series information/i)).toBeInTheDocument();

    land({ series: [NFL] });

    // And once the card lands, the panel reads the episode list from the
    // recordings path only the index knew.
    await waitFor(() =>
      expect(api.series.detail).toHaveBeenCalledWith("/recordings/sports/63558"));
  });

  it("opens on what the sheet knew when the index has no card", async () => {
    // The index is an optimisation. A show missing from it — or a listing that
    // failed — still opens, on the one path the caller handed over.
    vi.spyOn(api.series, "index").mockRejectedValue(new Error("nope"));
    const detail = vi.spyOn(api.series, "detail").mockResolvedValue(detailFor());
    renderHarness("/recordings/sports/63558");

    fireEvent.click(screen.getByRole("button", { name: "open" }));

    await waitFor(() =>
      expect(detail).toHaveBeenCalledWith("/recordings/sports/63558"));
  });
});
