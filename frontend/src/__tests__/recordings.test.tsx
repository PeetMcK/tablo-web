import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LibraryView } from "../components/LibraryView";
import { formatAired } from "../lib/format";
import { api } from "../api/tablo";
import { saveResume, __resetResumeForTests } from "../lib/resume";
import type { Recording, RecordingList } from "../api/tablo";

const NBSP = "\u00a0";

describe("formatAired", () => {
  const WHEN = new Date("2026-09-13T21:25:00Z");

  it("breaks only between the date and the time", () => {
    // The card is narrow enough to wrap this stamp, and between the two halves
    // is the only sensible place to do it. Breaking inside the time stranded
    // "PM" alone on a line of its own.
    const out = formatAired(WHEN.toISOString());
    expect((out.match(/ /g) ?? []).length).toBe(1);
  });

  it("ties together every space the locale puts inside either half", () => {
    // Not only the meridiem: a locale spelling the date "13 Sep 2026" must not
    // come apart either.
    const date = WHEN.toLocaleDateString();
    const time = WHEN.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(formatAired(WHEN.toISOString())).toBe(
      `${date.replace(/\s/g, NBSP)} ${time.replace(/\s/g, NBSP)}`,
    );
  });

  it("returns nothing for an unparseable stamp", () => {
    expect(formatAired("not a date")).toBe("");
  });
});

const REC: Recording = {
  object_id: 80888,
  identifier: 80888,
  path: "/recordings/sports/events/80888",
  title: "NFL Football",
  subtitle: "Denver Broncos at Kansas City Chiefs",
  description: "AFC West matchup at Arrowhead Stadium.",
  start: "2026-09-15T00:15:00Z",
  // Sport: no series record and no episode numbers, which is what makes
  // the end card group by title and order by date.
  series_path: null, sport_path: null, season_number: null, episode_number: null,
  orig_air_date: null,
  duration: 12615,
  recorded_seconds: null,
  expected_seconds: null,
  recording_started: null,
  slot_seconds: 10800,
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
  channel: { identifier: "S34654_008_01", call_sign: "KTMFABC", network: "ABC", number: "23.1" },
  scan: "720p",
  interlaced: false,
  image_url: null, cover_frame: null,
  has_preview: false,
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
      recordings: [{ ...REC, channel: { identifier: "S34654_008_01", call_sign: "KPAX", network: "CBS", number: "8.1" },
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

  it("shows how much of an unkept recording is already cached", async () => {
    // Watching transcodes as it goes, so a recording nobody asked to keep can
    // still be substantially on disk. The badge only ever appeared for pinned
    // copies, so those cards said nothing at all about the work already done.
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [{ ...REC, cache_state: "partial", cache_progress: 0.27, pinned: false }],
    }));
    renderLibrary();
    expect(await screen.findByText("27% cached")).toBeInTheDocument();
  });

  it("claims no cache for a recording that has none", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());   // cache_state absent
    renderLibrary();
    await screen.findByText("NFL Football");
    expect(screen.queryByText(/cached/i)).toBeNull();
  });

  it("keeps the kept badge distinct from a merely cached one", async () => {
    // Both badges now say "cached", so the wording alone no longer separates a
    // copy that is kept from one that merely happens to be on disk. A kept copy
    // in progress shows its bare percentage beside the tick; only the
    // incidental one spells out "% cached".
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [{ ...REC, cache_state: "partial", cache_progress: 0.42, pinned: true }],
    }));
    renderLibrary();
    expect(await screen.findByText("42%")).toBeInTheDocument();
    expect(screen.queryByText(/42% cached/)).toBeNull();
  });

  it("reports truncation instead of silently dropping recordings", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list({ returned: 50, total: 213 }));
    renderLibrary();
    expect(await screen.findByText(/Showing 50 of 213/)).toBeInTheDocument();
  });

  it("offers playback for a recording that is still being written", async () => {
    // The device serves an in-progress recording as HLS from the first moment,
    // which is how its own app lets you start a show that is still recording.
    // Verified against a real one - `state: recording`, `duration: 0` - which
    // still answered `POST .../watch` with a playlist. Refusing them here made
    // the one thing the device is best at the one thing this could not do.
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({ recordings: [{ ...REC, state: "recording" }] }),
    );

    renderLibrary();
    const buttons = await screen.findAllByRole("button", { name: /play nfl football/i });
    buttons.forEach((b) => expect(b).toBeEnabled());
  });

  it("will not keep a recording that is still being written", async () => {
    // Unlike playback, an offline copy really does need a finished recording:
    // caching copies the whole thing, and the whole thing does not exist yet.
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({ recordings: [{ ...REC, state: "recording" }] }),
    );

    renderLibrary();
    await screen.findByText("NFL Football");
    expect(screen.getByRole("button", { name: /^Keep NFL Football offline$/ }))
      .toBeDisabled();
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
    expect(await screen.findByText(/^Cached$/i)).toBeInTheDocument();
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

describe("the library's controls answer the pointer", () => {
  beforeEach(() => {
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * The same two-part answer the Live TV card settled on: a control grows and
   * lifts under the pointer, and presses in when it is clicked. Here every
   * control is its own mark, so both belong to the button itself — except the
   * play puck on the artwork, which is a mark inside a much larger target and
   * takes the press from that whole target.
   *
   * jsdom renders no CSS, so this is a class contract. It holds the variants
   * that make the three surfaces behave alike; dropping one is silent
   * otherwise.
   */
  async function controls() {
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({ recordings: [{ ...REC, cache_state: "complete", cache_progress: 1 }] }));
    const view = renderLibrary();
    await screen.findByText("NFL Football");
    return view;
  }

  it("grows each round control under the pointer and presses it on click", async () => {
    await controls();

    // The artwork carries the same label as the round play control, so the
    // last match is the one in the button row.
    for (const name of [/^Play NFL Football$/, /^Keep NFL Football offline$/,
                        /^Delete cached video of NFL Football$/]) {
      const button = screen.getAllByRole("button", { name }).at(-1)!;
      expect(button.className).toMatch(/enabled:hover:scale-110/);
      expect(button.className).toMatch(/enabled:active:scale-95/);
    }
    // The MP4 save is a plain link — the browser owns the download — so it
    // cannot be disabled and answers unconditionally.
    const save = screen.getByRole("link", { name: /^Save NFL Football as an MP4 file$/ });
    expect(save.className).toMatch(/hover:scale-110/);
    expect(save.className).toMatch(/active:scale-95/);
  });

  it("does not move a control it has disabled", async () => {
    // A disabled button still matches `:hover` in CSS, so an unguarded
    // `hover:scale-110` makes a control that does nothing grow as if it would.
    vi.spyOn(api, "recordings").mockResolvedValue(
      list({ recordings: [{ ...REC, state: "recording" }] }));
    renderLibrary();
    await screen.findByText("NFL Football");

    // The keep button, which an in-progress recording really does disable.
    const keep = screen.getByRole("button", { name: /^Keep NFL Football offline$/ });
    expect(keep).toBeDisabled();
    expect(keep.className).not.toMatch(/(?<!enabled:)hover:scale-110/);
  });

  it("presses the artwork's play puck from anywhere on the artwork", async () => {
    const { container } = await controls();

    const art = screen.getAllByRole("button", { name: /^Play NFL Football$/ })[0];
    // `group/art` sits on the artwork wrapper rather than the button itself: a
    // recording in progress puts two buttons inside that wrapper, and a button
    // inside a button is invalid. `:active` still reaches the wrapper from the
    // button, so the puck's press response is unchanged.
    expect(art.closest(".group\\/art")).not.toBeNull();
    expect(art.className).toMatch(/absolute inset-0/);

    const puck = container.querySelector<HTMLElement>(".accent-gradient")!;
    expect(puck.className).toMatch(/group-active\/art:scale-95/);
    // And it answers its own hover, the way the card's info mark does.
    expect(puck.className).toMatch(/hover:scale-110/);
    expect(puck.className).toMatch(/hover:brightness-110/);
  });
});

describe("a recording still being written", () => {
  const IN_PROGRESS: Recording = {
    ...REC,
    object_id: 86108,
    title: "Today 3rd Hour",
    state: "recording",
    // The device reports the scheduled slot until it finishes; the server
    // estimates what exists so far from the wall clock.
    // Booked for an hour at 15:00Z; the tuner began 15 seconds early, which is
    // what `recorded_offsets` reports and why the expected length is 3615.
    duration: 3600,
    slot_seconds: 3600,
    recorded_seconds: 1920,
    expected_seconds: 3615,
    recording_started: "2026-09-17T14:59:45Z",
    cache_state: "absent",
    cache_progress: 0,
  };

  const progressList = () => ({
    recordings: [IN_PROGRESS], returned: 1, total: 1, offline_only: 0,
  });

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("says how much exists, not just how long the slot is", async () => {
    // "1h 0m" on something half an hour old promised a scrubber that was not
    // there, which is what sent someone looking for a bug in the timeline.
    vi.spyOn(api, "recordings").mockResolvedValue(progressList());
    renderLibrary();

    expect(await screen.findByText("32m of 1h 0m")).toBeInTheDocument();
  });

  it("marks itself as recording", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(progressList());
    renderLibrary();

    expect(await screen.findByText("Recording")).toBeInTheDocument();
  });

  it("offers both a beginning and a live edge to start from", async () => {
    // They are genuinely different places for something still being written,
    // and guessing either one is wrong half the time.
    vi.spyOn(api, "recordings").mockResolvedValue(progressList());
    renderLibrary();

    expect(await screen.findByRole("button", { name: /from start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^live$/i })).toBeInTheDocument();
  });

  it("offers no such choice once it has finished", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    renderLibrary();

    await screen.findByText("NFL Football");
    expect(screen.queryByRole("button", { name: /from start/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^live$/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Recording")).not.toBeInTheDocument();
  });

  it("cannot be kept offline while it is still growing", async () => {
    // The copy would be of something that does not exist yet. The control is
    // present but refuses, rather than vanishing — a button that disappears
    // between visits reads as a missing feature.
    vi.spyOn(api, "recordings").mockResolvedValue(progressList());
    renderLibrary();

    await screen.findByText("Today 3rd Hour");
    expect(screen.getByRole("button", { name: /^Keep Today 3rd Hour offline$/ })).toBeDisabled();
  });
});

describe("a recording whose tuner started late", () => {
  // Good Morning America, 2026-09-17: booked 13:00Z for two hours, the tuner
  // began at 14:03:06Z, and the finished recording was 3473s — 57.9 minutes.
  const LATE: Recording = {
    ...REC,
    object_id: 86105,
    title: "Good Morning America",
    state: "recording",
    duration: 7200,
    slot_seconds: 7200,
    expected_seconds: 3473,
    recorded_seconds: 1794,
    recording_started: "2026-09-17T14:03:06Z",
  };

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
    vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [LATE], returned: 1, total: 1, offline_only: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("counts against what the recording will be, not the slot it was booked in", async () => {
    // Against the two-hour slot this would read "30m of 2h 0m" and the bar
    // could never fill, because the recording will only ever be 58 minutes.
    renderLibrary();

    expect(await screen.findByText("30m of 58m")).toBeInTheDocument();
    expect(screen.queryByText(/of 2h 0m/)).not.toBeInTheDocument();
  });

  it("says on hover where the figure comes from", async () => {
    // It is the one number on the card that is not simply reported: the device
    // gives the start and the expected length, and elapsed is inferred.
    renderLibrary();

    const badge = await screen.findByText("30m of 58m");
    expect(badge).toHaveAttribute("title", expect.stringMatching(/recording began at/i));
    expect(badge).toHaveAttribute("title", expect.stringMatching(/derived/i));
  });
});

describe("the progress bar on a recording in progress", () => {
  // Let's Make a Deal, 2026-09-17: booked 16:00Z for an hour, started by hand
  // at 16:20:59Z, so a third of the show was never captured.
  const LATE_START: Recording = {
    ...REC,
    object_id: 86113,
    title: "Let's Make a Deal",
    state: "recording",
    start: "2026-09-17T16:00:00Z",
    duration: 3600,
    slot_seconds: 3600,
    recording_started: "2026-09-17T16:20:59Z",
    recorded_seconds: 1020,          // 17 minutes in
    expected_seconds: 2341,          // 3600 - 1259
  };

  const bar = (c: HTMLElement) =>
    c.querySelector<HTMLElement>(".bg-danger.absolute");

  function renderWith(rec: Recording) {
    vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [rec], returned: 1, total: 1, offline_only: 0,
    });
    return renderLibrary();
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("starts the fill where recording actually began, not at the left edge", async () => {
    // 1259s into a 3600s slot is 35% along. Flush left, this card would be
    // indistinguishable from one that caught the show from the top — which is
    // the single most useful thing to know before pressing play.
    const { container } = renderWith(LATE_START);
    await screen.findByText("Let's Make a Deal");

    const fill = bar(container)!;
    expect(parseFloat(fill.style.left)).toBeCloseTo(34.97, 1);
  });

  it("spans only what has been captured so far", async () => {
    // 1020s of a 3600s slot is 28.3% wide, ending at 63.3%.
    const { container } = renderWith(LATE_START);
    await screen.findByText("Let's Make a Deal");

    const fill = bar(container)!;
    expect(parseFloat(fill.style.width)).toBeCloseTo(28.33, 1);
  });

  it("sits at the left edge when the tuner started early", async () => {
    // `recorded_offsets.start` is signed — one recording began 15s early — and
    // a negative offset must not push the fill off the strip.
    const { container } = renderWith({
      ...LATE_START,
      recording_started: "2026-09-17T15:59:45Z",
      recorded_seconds: 600,
    });
    await screen.findByText("Let's Make a Deal");

    expect(parseFloat(bar(container)!.style.left)).toBe(0);
  });

  it("never runs past the end of the slot", async () => {
    // End padding pushes a recording past its booked hour; the strip is the
    // hour, so the fill stops at it rather than overflowing the card.
    const { container } = renderWith({ ...LATE_START, recorded_seconds: 9999 });
    await screen.findByText("Let's Make a Deal");

    const fill = bar(container)!;
    const end = parseFloat(fill.style.left) + parseFloat(fill.style.width);
    expect(end).toBeLessThanOrEqual(100.01);
  });

  it("explains on hover that the strip is the scheduled slot", async () => {
    const { container } = renderWith(LATE_START);
    await screen.findByText("Let's Make a Deal");

    const strip = container.querySelector<HTMLElement>(".bg-ink\\/60")!;
    expect(strip).toHaveAttribute("title", expect.stringMatching(/scheduled 1h 0m/i));
  });
});

describe("a finished recording's coverage", () => {
  const finished = (over: Partial<Recording>): Recording => ({
    ...REC, state: "finished", recorded_seconds: null, expected_seconds: null, ...over,
  });

  const strip = (c: HTMLElement) => c.querySelector<HTMLElement>(".bg-ink\\/60");
  const fill = (c: HTMLElement) =>
    c.querySelector<HTMLElement>(".bg-ink\\/60 > div:first-child");

  function renderWith(rec: Recording) {
    vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [rec], returned: 1, total: 1, offline_only: 0,
    });
    return renderLibrary();
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("shows what a recording missed, after the fact", async () => {
    // Saturday Night Live: the tuner began 916s into its hour, so the first
    // fifteen minutes are gone. Nothing said so before this bar.
    const { container } = renderWith(finished({
      title: "Saturday Night Live", start: "2026-09-17T07:00:00Z",
      slot_seconds: 3600, duration: 2684,
      recording_started: "2026-09-17T07:15:16Z",
    }));
    await screen.findByText("Saturday Night Live");

    expect(parseFloat(fill(container)!.style.left)).toBeCloseTo(25.4, 0);
  });

  it("marks where the slot ended when a recording overran it", async () => {
    // NFL pads by thirty minutes deliberately. Without the tick the bar just
    // looks full, and the padding is invisible.
    const { container } = renderWith(finished({
      slot_seconds: 10800, duration: 12615,
      recording_started: "2026-09-15T00:14:45Z", start: "2026-09-15T00:15:00Z",
    }));
    await screen.findByText("NFL Football");

    const tick = container.querySelector<HTMLElement>(".w-px");
    expect(tick).not.toBeNull();
    expect(parseFloat(tick!.style.left)).toBeCloseTo(85.6, 0);
  });

  it("calls a four-second recording incomplete, because the device will not", async () => {
    // `error` is null and `warnings` empty on all three measured failures, so
    // the card has to work it out from how little of the slot exists.
    renderWith(finished({
      title: "First Civilizations", start: "2026-09-16T02:00:00Z",
      slot_seconds: 3600, duration: 8,
      recording_started: "2026-09-16T02:56:41Z",
    }));

    expect(await screen.findByText("Incomplete")).toBeInTheDocument();
  });

  it("leaves a recording that merely started late alone", async () => {
    renderWith(finished({
      slot_seconds: 3600, duration: 2684,
      recording_started: "2026-09-15T00:30:16Z", start: "2026-09-15T00:15:00Z",
    }));
    await screen.findByText("NFL Football");

    expect(screen.queryByText("Incomplete")).toBeNull();
  });

  it("gives the strip to coverage rather than to the download", async () => {
    // Cache progress keeps the corner badge, the percentage row and the rate;
    // it was the only bar with a duplicate, and coverage has none.
    const { container } = renderWith(finished({
      slot_seconds: 10800, duration: 10800, cache_progress: 0.4,
      cache_state: "partial", recording_started: "2026-09-15T00:15:00Z",
    }));
    await screen.findByText("NFL Football");

    // Full coverage, not the 40% a cache bar would draw.
    expect(parseFloat(fill(container)!.style.width)).toBeCloseTo(100, 0);
    expect(strip(container)).toHaveAttribute("title", expect.stringMatching(/scheduled/i));
  });
});

describe("reaching a recording's information", () => {
  const withChannel = (over: Partial<Recording> = {}): Recording => ({
    ...REC,
    channel: { identifier: "S34654_008_01", call_sign: "KPAX",
               network: "CBS", number: "8.1" },
    ...over,
  });

  function renderWith(rec: Recording) {
    vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [rec], returned: 1, total: 1, offline_only: 0,
    });
    return renderLibrary();
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens the show's information from the card", async () => {
    // The sheet already holds the artwork, the synopsis and the record
    // controls; the Library was the one view with no way into it.
    const airing = vi.spyOn(api, "airingDetail").mockResolvedValue({
      title: "NFL Football", episode_title: null, season_number: null,
      episode_number: null, description: null, start: REC.start, duration: 10800,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false, schedulable: true, scheduled: false, past: true,
      schedule_state: "none", skip_reason: null, series: null, recording_id: null,
      channel: { identifier: "S34654_008_01", call_sign: "KPAX", major: 8,
                 minor: 1, network: "CBS", logo_url: null, kind: "ota" },
    });

    renderWith(withChannel());
    fireEvent.click(await screen.findByRole("button", { name: /information about/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Keyed by the identifier and the scheduled start, which is how the guide
    // addresses the very same airing.
    expect(airing).toHaveBeenCalledWith("S34654_008_01", REC.start);
  });

  it("drops the card the moment delete is confirmed, not when the Tablo answers", async () => {
    // Same beat as the sheet closing. The listing takes a device round trip to
    // re-read, and leaving the card sitting there in the meantime reads as a
    // delete that did not work.
    vi.spyOn(api, "airingDetail").mockResolvedValue({
      title: "NFL Football", episode_title: null, season_number: null,
      episode_number: null, description: null, start: REC.start, duration: 10800,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false, schedulable: true, scheduled: true, past: true,
      schedule_state: "none", skip_reason: null, series: null,
      recording_id: REC.object_id,
      channel: { identifier: "S34654_008_01", call_sign: "KPAX", major: 8,
                 minor: 1, network: "CBS", logo_url: null, kind: "ota" },
    });
    // Never answers, so anything that happens is the app's own doing.
    vi.spyOn(api, "deleteRecording").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });

    renderWith(withChannel());
    fireEvent.click(await screen.findByRole("button", { name: /information about/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText("NFL Football")).toBeNull());
  });

  it("does not re-read the listing until the delete has actually landed", async () => {
    // Measured against a real device: the listing fired alongside the DELETE,
    // read the library before the delete landed, and put the card straight
    // back - where it sat until the next poll, fifteen to thirty seconds later.
    // The refetch is the reconciliation, so it has to come second.
    let landed: (v: { object_id: number; deleted: boolean }) => void = () => {};
    vi.spyOn(api, "airingDetail").mockResolvedValue({
      title: "NFL Football", episode_title: null, season_number: null,
      episode_number: null, description: null, start: REC.start, duration: 10800,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false, schedulable: true, scheduled: true, past: true,
      schedule_state: "none", skip_reason: null, series: null,
      recording_id: REC.object_id,
      channel: { identifier: "S34654_008_01", call_sign: "KPAX", major: 8,
                 minor: 1, network: "CBS", logo_url: null, kind: "ota" },
    });
    vi.spyOn(api, "deleteRecording").mockReturnValue(new Promise((res) => { landed = res; }));
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
    const listing = vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [withChannel()], returned: 1, total: 1, offline_only: 0,
    });

    renderWith(withChannel());
    fireEvent.click(await screen.findByRole("button", { name: /information about/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    const readsBefore = listing.mock.calls.length;
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    // The card goes at once...
    await waitFor(() => expect(screen.queryByText("NFL Football")).toBeNull());

    // ...and nothing re-reads the library while the delete is still in flight.
    await new Promise((r) => setTimeout(r, 50));
    expect(listing.mock.calls.length).toBe(readsBefore);

    landed({ object_id: REC.object_id, deleted: true });
    await waitFor(() => expect(listing.mock.calls.length).toBe(readsBefore + 1));
  });

  it("puts the card back and says why when the Tablo refuses", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue({
      title: "NFL Football", episode_title: null, season_number: null,
      episode_number: null, description: null, start: REC.start, duration: 10800,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false, schedulable: true, scheduled: true, past: true,
      schedule_state: "none", skip_reason: null, series: null,
      recording_id: REC.object_id,
      channel: { identifier: "S34654_008_01", call_sign: "KPAX", major: 8,
                 minor: 1, network: "CBS", logo_url: null, kind: "ota" },
    });
    vi.spyOn(api, "deleteRecording")
      .mockRejectedValue(new Error("The Tablo would not delete this recording."));
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });

    renderWith(withChannel());
    fireEvent.click(await screen.findByRole("button", { name: /information about/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/would not delete this recording/i)).toBeInTheDocument();
    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
  });

  it("drops the card as soon as its recording is deleted from the sheet", async () => {
    // The listing polls every fifteen seconds, and a card for something that
    // no longer exists is a card that fails when pressed. The sheet says what
    // it deleted, so the list can re-read at once rather than waiting.
    vi.spyOn(api, "airingDetail").mockResolvedValue({
      title: "NFL Football", episode_title: null, season_number: null,
      episode_number: null, description: null, start: REC.start, duration: 10800,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false, schedulable: true, scheduled: true, past: true,
      schedule_state: "none", skip_reason: null, series: null,
      recording_id: REC.object_id,
      channel: { identifier: "S34654_008_01", call_sign: "KPAX", major: 8,
                 minor: 1, network: "CBS", logo_url: null, kind: "ota" },
    });
    vi.spyOn(api, "deleteRecording").mockResolvedValue({
      object_id: REC.object_id, deleted: true,
    });
    const listing = vi.spyOn(api, "recordings")
      .mockResolvedValueOnce({ recordings: [withChannel()], returned: 1, total: 1,
                               offline_only: 0 })
      .mockResolvedValue({ recordings: [], returned: 0, total: 0, offline_only: 0 });
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });

    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /information about/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(listing).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("NFL Football")).toBeNull());
  });

  it("deletes the recording whose card was opened, not the airing's other one", async () => {
    // One airing can hold two recordings - a capture stopped and restarted
    // leaves both - and the airing lookup can only name one of them. The card
    // knows which one it is, so it says.
    const del = vi.spyOn(api, "deleteRecording").mockResolvedValue({
      object_id: 86462, deleted: true,
    });
    vi.spyOn(api, "airingDetail").mockResolvedValue({
      title: "NFL Football", episode_title: null, season_number: null,
      episode_number: null, description: null, start: REC.start, duration: 10800,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false, schedulable: true, scheduled: true, past: true,
      schedule_state: "none", skip_reason: null, series: null,
      // The other recording of the same slot.
      recording_id: 86406,
      channel: { identifier: "S34654_008_01", call_sign: "KPAX", major: 8,
                 minor: 1, network: "CBS", logo_url: null, kind: "ota" },
    });
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });

    renderWith(withChannel({ object_id: 86462 }));
    fireEvent.click(await screen.findByRole("button", { name: /information about/i }));
    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(86462));
  });

  it("opens the sheet even when the channel is unknown", async () => {
    // This used to offer nothing: the sheet was keyed by the airing, and an
    // offline copy of something the device has since deleted has no airing left
    // to describe. It asks about the recording now, so there is always
    // something to open — and with no identifier, no airing to look up.
    const rec = vi.spyOn(api, "recordingDetail").mockResolvedValue({
      title: "NFL Football", episode_title: null,
      season_number: null, episode_number: null,
      description: "A game.", start: "2026-09-13T20:25Z", duration: 12915,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false, schedulable: false, scheduled: false, past: true,
      schedule_state: null, skip_reason: null, recording_id: 86462,
      series: null,
      channel: { identifier: null, call_sign: "KPAX", major: 8, minor: 1,
                 network: "CBS", logo_url: null, kind: null },
    });
    const air = vi.spyOn(api, "airingDetail");
    renderWith(withChannel({ object_id: 86462,
                             channel: { identifier: null, call_sign: "KPAX",
                                        network: "CBS", number: "8.1" } }));
    await screen.findByText("NFL Football");

    fireEvent.click(screen.getByRole("button", { name: /information about/i }));

    await waitFor(() => expect(rec).toHaveBeenCalledWith(86462));
    expect(air).not.toHaveBeenCalled();
  });
});

describe("what the artwork offers", () => {
  const resumed = (key: string, seconds: number) => saveResume(key, seconds, 3600);

  function renderWith(rec: Recording) {
    vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [rec], returned: 1, total: 1, offline_only: 0,
    });
    return renderLibrary();
  }

  const IN_FLIGHT: Recording = {
    ...REC, object_id: 90001, title: "Carl the Collector", state: "recording",
    start: "2026-09-17T17:00:00Z", duration: 1800, slot_seconds: 1800,
    recording_started: "2026-09-17T17:09:18Z",
    recorded_seconds: 780, expected_seconds: 1242,
  };

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("offers all three places on a recording you have already watched some of", async () => {
    // Resuming, starting over and jumping to the frontier are three different
    // intentions, and while it is still recording all three are available.
    resumed("recording:90001", 300);
    renderWith(IN_FLIGHT);

    expect(await screen.findByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /from start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^live$/i })).toBeInTheDocument();
  });

  it("fills a quarter of the strip for a recording watched to the quarter mark", async () => {
    // The bar is the only place on the card that says how far in you are
    // without opening the recording.
    resumed("recording:90101", 900);
    renderWith({
      ...REC, object_id: 90101, state: "finished",
      start: "2026-09-17T17:00:00Z", duration: 3600, slot_seconds: 3600,
      recording_started: "2026-09-17T17:00:00Z", recorded_seconds: 3600,
    });

    const watched = await screen.findByTitle(/watched 15:00/i);
    expect(watched.style.width).toBe("25%");
  });

  it("marks nothing watched on a recording nobody has opened", async () => {
    renderWith({
      ...REC, object_id: 90102, state: "finished",
      start: "2026-09-17T17:00:00Z", duration: 3600, slot_seconds: 3600,
      recording_started: "2026-09-17T17:00:00Z", recorded_seconds: 3600,
    });
    await screen.findByText("NFL Football");

    expect(screen.queryByTitle(/watched/i)).toBeNull();
  });

  it("drops Resume when there is nothing to resume", async () => {
    renderWith({ ...IN_FLIGHT, object_id: 90002 });

    expect(await screen.findByRole("button", { name: /from start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^live$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("offers Resume and From start on a finished recording you left partway", async () => {
    // No Live: there is no frontier to jump to once it has finished.
    resumed("recording:90003", 900);
    renderWith({ ...REC, object_id: 90003, state: "finished" });

    expect(await screen.findByRole("button", { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /from start/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^live$/i })).toBeNull();
  });

  it("keeps the single play button when a finished recording has no position", async () => {
    renderWith({ ...REC, object_id: 90004, state: "finished" });

    // Two carry that label: the artwork's puck and the footer's small mark.
    expect(await screen.findAllByRole("button", { name: /^Play NFL Football$/ })).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: /from start/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });
});

describe("where Resume opens", () => {
  function renderWith(rec: Recording) {
    vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [rec], returned: 1, total: 1, offline_only: 0,
    });
    return renderLibrary();
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    __resetResumeForTests();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("takes the device's position when the phone got further", async () => {
    // Watched on the phone, opened here. Neither side carries a timestamp, so
    // the further of the two is the only honest answer.
    renderWith({ ...REC, object_id: 91001, state: "finished", position: 1296 });

    expect(await screen.findByRole("button", { name: /resume 21:36/i })).toBeInTheDocument();
  });

  it("keeps ours when we got further", async () => {
    saveResume("recording:91002", 2400, 12615);
    renderWith({ ...REC, object_id: 91002, state: "finished", position: 33 });

    expect(await screen.findByRole("button", { name: /resume 40:00/i })).toBeInTheDocument();
  });

  it("never resumes past what a finished recording actually holds", async () => {
    // A position captured while it was still recording can outrun the media
    // once the recording is cut short, and "greater wins" would enshrine it.
    renderWith({ ...REC, object_id: 91003, state: "finished",
                 duration: 600, position: 99999 });

    expect(await screen.findByRole("button", { name: /resume 10:00/i })).toBeInTheDocument();
  });
});
