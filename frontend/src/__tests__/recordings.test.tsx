import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
};

function list(overrides: Partial<RecordingList> = {}): RecordingList {
  return { recordings: [REC], returned: 1, total: 1, ...overrides };
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
    // jsdom has no media stack; the player mounts but never decodes.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
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
    expect(await screen.findByText("3H 30M")).toBeInTheDocument();
  });

  it("starts playback with the recording's object_id when play is clicked", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    const watch = vi.spyOn(api, "watchRecording").mockResolvedValue({
      object_id: 80888,
      stream_url: "/api/recordings/80888/cache/playlist.m3u8",
      state: "complete",
      progress: 1,
      duration: 12615,
    });

    renderLibrary();
    const buttons = await screen.findAllByRole("button", { name: /play nfl football/i });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(watch).toHaveBeenCalledWith(80888));
  });

  it("shows transcode progress while the cache is still building", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    vi.spyOn(api, "watchRecording").mockResolvedValue({
      object_id: 80888,
      stream_url: "/api/recordings/80888/cache/playlist.m3u8",
      state: "running",
      progress: 0.42,
      duration: 12615,
    });
    vi.spyOn(api, "recordingStatus").mockResolvedValue({
      object_id: 80888, state: "running", progress: 0.42, duration: 12615, error: null,
    });

    renderLibrary();
    fireEvent.click((await screen.findAllByRole("button", { name: /play nfl football/i }))[0]);

    expect(await screen.findByText(/Preparing • 42%/)).toBeInTheDocument();
  });

  it("reports truncation instead of silently dropping recordings", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list({ returned: 50, total: 213 }));
    renderLibrary();
    expect(await screen.findByText(/Showing 50 of 213 recordings/)).toBeInTheDocument();
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

  it("renders the empty state when there are no recordings", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list({ recordings: [], returned: 0, total: 0 }));
    renderLibrary();
    expect(await screen.findByText(/No Recordings Found/i)).toBeInTheDocument();
  });
});
