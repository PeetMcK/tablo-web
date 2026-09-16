import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LibraryView } from "../components/LibraryView";
import { api } from "../api/tablo";
import type { Recording, RecordingList } from "../api/tablo";

const REC: Recording = {
  object_id: 80888,
  identifier: 80888,
  path: "/recordings/sports/events/80888",
  title: "NFL Football",
  subtitle: "Denver Broncos at Kansas City Chiefs",
  description: "AFC West matchup at Arrowhead Stadium.",
  start: "2026-09-15T00:15:00Z",
  duration: 12615,
  thumbnail: "/api/recordings/80888/thumbnail",
  width: 1280,
  height: 720,
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
  // Matches the real recording: ABC broadcasts 720p60 progressive.
  channel: { call_sign: "KTMFABC", network: "ABC", number: "23.1" },
  scan: "720p",
  interlaced: false,
};

function list(overrides: Partial<RecordingList> = {}): RecordingList {
  return { recordings: [REC], returned: 1, total: 1, offline_only: 0, ...overrides };
}

function renderLibrary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LibraryView />
    </QueryClientProvider>,
  );
}

describe("LibraryView", () => {
  beforeEach(() => {
    // The player writes its location into the hash, which jsdom keeps between
    // tests. Clear it so one test cannot restore another's playback.
    window.history.replaceState(null, "", "/");
    // jsdom has no media stack; the player mounts but never decodes.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders recording metadata from the enriched payload", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    renderLibrary();

    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
    expect(screen.getByText("Denver Broncos at Kansas City Chiefs")).toBeInTheDocument();
    expect(screen.getByText("AFC West matchup at Arrowhead Stadium.")).toBeInTheDocument();
  });

  it("formats the recorded duration in hours, not the scheduled slot", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    renderLibrary();
    // 12615s = 3h 30m, not the 10800s (3h) scheduled slot.
    //
    // Lowercase on purpose: uppercased beside a transfer rate, "3H 35M" reads
    // as megabytes when it means minutes - and the same uppercasing turned
    // "Mb/s" into "MB/S", displaying megabits spelled as megabytes.
    expect(await screen.findByText("3h 30m")).toBeInTheDocument();
  });

  it("starts playback with the recording's object_id when play is clicked", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    const watch = vi.spyOn(api, "watchRecording").mockResolvedValue({
      object_id: 80888,
      stream_url: "/api/recordings/80888/cache/playlist.m3u8",
      state: "complete",
      progress: 1,
      duration: 12615,
      cached_seconds: 12615,
      cached_ranges: [[0, 12615]],
    });

    renderLibrary();
    const buttons = await screen.findAllByRole("button", { name: /play nfl football/i });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(watch).toHaveBeenCalledWith(80888));
  });

  it("heartbeats the server with the playhead while watching", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    vi.spyOn(api, "watchRecording").mockResolvedValue({
      object_id: 80888,
      stream_url: "/api/recordings/cache/80888/playlist.m3u8",
      state: "partial",
      progress: 0.42,
      duration: 12615,
      cached_seconds: 5298,
      cached_ranges: [[0, 5298]],
    });
    const status = vi.spyOn(api, "recordingStatus").mockResolvedValue({
      object_id: 80888, state: "partial", progress: 0.42, duration: 12615,
      cached_seconds: 5298, cached_ranges: [[0, 5298]], encoding: null, error: null,
    });

    renderLibrary();
    fireEvent.click((await screen.findAllByRole("button", { name: /play nfl football/i }))[0]);
    await waitFor(() => expect(api.watchRecording).toHaveBeenCalled());

    // The poll doubles as "someone is still watching", which is what stops the
    // server transcoding a whole game after playback ends.
    await vi.advanceTimersByTimeAsync(3500);
    expect(status).toHaveBeenCalledWith(80888, expect.any(Number));
    vi.useRealTimers();
  });

  it("shows the station and scan type", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    renderLibrary();
    expect(await screen.findByText("23.1 ABC")).toBeInTheDocument();
    expect(screen.getByText("720p")).toBeInTheDocument();
  });

  it("flags an interlaced source, since it is the one that costs something", async () => {
    // CBS and NBC broadcast 1080i; it must be deinterlaced on the way to H.264,
    // which halves throughput and roughly doubles the cached size.
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [{ ...REC, channel: { call_sign: "KPAX", network: "CBS", number: "8.1" },
                     scan: "1080i", interlaced: true }],
    }));
    renderLibrary();
    const badge = await screen.findByText("1080i");
    expect(badge).toHaveAttribute("title", expect.stringMatching(/deinterlac/i));
  });

  it("shows the start time, not just the date", async () => {
    // Several games share a date and channel; kickoff is what tells them apart.
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    renderLibrary();
    const when = new Date(REC.start);
    const expected = `${when.toLocaleDateString()} ` +
      when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it("offers an MP4 export only once the cache is complete", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [{ ...REC, cache_state: "complete", cache_progress: 1, pinned: true }],
    }));
    renderLibrary();
    const link = await screen.findByRole("link", { name: /save .* as an mp4/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("/api/recordings/80888/download"));
  });

  it("hides the MP4 export while the cache is still partial", async () => {
    // Exporting a partial cache yields a file with the gaps simply missing.
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [{ ...REC, cache_state: "partial", cache_progress: 0.5, pinned: true }],
    }));
    renderLibrary();
    await screen.findByText("NFL Football");
    expect(screen.queryByRole("link", { name: /as an mp4/i })).toBeNull();
  });

  it("reports truncation instead of silently dropping recordings", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list({ returned: 50, total: 213 }));
    renderLibrary();
    expect(await screen.findByText(/Showing 50 of 213/)).toBeInTheDocument();
  });

  it("does not offer playback for an in-progress recording", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({ recordings: [{ ...REC, state: "recording" }] }),
    );
    const watch = vi.spyOn(api, "watchRecording");

    renderLibrary();
    const buttons = await screen.findAllByRole("button", { name: /play nfl football/i });
    buttons.forEach((b) => expect(b).toBeDisabled());
    fireEvent.click(buttons[0]);
    expect(watch).not.toHaveBeenCalled();
  });

  it("marks a copy the Tablo no longer has, and keeps it playable", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({
        recordings: [{ ...REC, offline_only: true, pinned: true, state: null,
                      cache_state: "complete", cache_progress: 1 }],
        offline_only: 1,
      }),
    );
    renderLibrary();
    expect(await screen.findByText(/Only here/i)).toBeInTheDocument();
    expect(await screen.findByText(/Offline/i)).toBeInTheDocument();
    // Device state is irrelevant for an offline copy — it must still play.
    const play = await screen.findAllByRole("button", { name: /play nfl football/i });
    expect(play[0]).not.toBeDisabled();
  });

  it("confirms in-app before dropping an offline-only copy", async () => {
    const unkeep = vi.spyOn(api, "unkeepRecording");
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({ recordings: [{ ...REC, offline_only: true, pinned: true }] }),
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /stop keeping/i }));

    // An app dialog, not the browser's confirm().
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/cannot be remade/i);
    expect(unkeep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(unkeep).not.toHaveBeenCalled();
  });

  it("carries out the removal once confirmed", async () => {
    const unkeep = vi.spyOn(api, "unkeepRecording").mockResolvedValue({ pinned: false });
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({ recordings: [{ ...REC, pinned: true }] }),
    );
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /stop keeping/i }));

    // Confirm from within the dialog, not the card button that opened it.
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /stop keeping/i }));
    await waitFor(() => expect(unkeep).toHaveBeenCalledWith(80888));
  });

  it("starts keeping a recording offline when asked", async () => {
    const keep = vi.spyOn(api, "keepRecording").mockResolvedValue({ pinned: true, progress: 0 });
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /keep nfl football offline/i }));
    await waitFor(() => expect(keep).toHaveBeenCalledWith(80888));
  });

  it("renders the empty state when there are no recordings", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list({ recordings: [], returned: 0, total: 0 }));
    renderLibrary();
    expect(await screen.findByText(/No Recordings Found/i)).toBeInTheDocument();
  });
});
