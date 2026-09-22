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
  protected: false,
  cache_state: "absent",
  cache_progress: 0,
  pinned: false,
  offline_only: false,
  paused: false,
  cached_seconds: 0,
  rate: { mbps: 0, realtime: 0 },
  // Matches the real recording: ABC broadcasts 720p60 progressive.
  channel: { identifier: "S34654_008_01", call_sign: "KTMFABC", network: "ABC", number: "23.1", kind: "ota" },
  scan: "720p",
  interlaced: false,
  image_url: null, cover_frame: null,
  kind: "sport", genres: ["Football"],
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
      cached_seconds: 5298, cached_ranges: [[0, 5298]], encoding: null,
      preview: "ready", error: null,
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
      recordings: [{ ...REC, channel: { identifier: "S34654_008_01", call_sign: "KPAX", network: "CBS", number: "8.1", kind: "ota" },
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
    // Its entry points are the in-progress card's own chips - Live, Resume,
    // From start - rather than a plain Play: the action row's round control is
    // Information now, and the picture keeps the Play.
    for (const name of [/^live$/i, /^from start$/i]) {
      expect(await screen.findByRole("button", { name })).toBeEnabled();
    }
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
    // The offline badge is now an icon-only status chip (no "Only here" text),
    // matched by its label rather than visible text.
    expect(await screen.findByLabelText(/the Tablo no longer has/i)).toBeInTheDocument();
    expect(screen.queryByText(/Only here/i)).toBeNull();
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

    for (const name of [/^Information about NFL Football$/,
                        /^Keep NFL Football offline$/,
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
               network: "CBS", number: "8.1", kind: "ota" },
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

  it("offers exactly one way into the sheet, in the card's action row", async () => {
    // The row ended in a second Play, which the hover overlay already offers
    // across the whole picture. Information had no such twin - it was a 16px
    // glyph beside the title - so the row is where it belongs, and there is
    // one of it rather than two.
    const airing = vi.spyOn(api, "airingDetail").mockRejectedValue(new Error("no"));
    vi.spyOn(api, "recordingDetail").mockRejectedValue(new Error("no"));
    renderWith(withChannel());
    await screen.findByText("NFL Football");

    // One Play, on the picture, where a pointer already expects it.
    expect(screen.getAllByRole("button", { name: /^play /i })).toHaveLength(1);

    const info = screen.getAllByRole("button", { name: /information about/i });
    expect(info).toHaveLength(1);
    fireEvent.click(info[0]);

    await waitFor(() => expect(airing).toHaveBeenCalled());
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
                                        network: "CBS", number: "8.1", kind: "ota" } }));
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

    // No watched *coverage* on the strip (title is "watched 15:00"); the
    // "Mark watched" toggle button is a separate control and may be present.
    expect(screen.queryByTitle(/^watched \d/i)).toBeNull();
  });

  const FINISHED = {
    ...REC, state: "finished", start: "2026-09-17T17:00:00Z",
    duration: 3600, slot_seconds: 3600,
    recording_started: "2026-09-17T17:00:00Z", recorded_seconds: 3600,
  };

  it("shows a NEW chip for a recording never started", async () => {
    renderWith({ ...FINISHED, object_id: 90200, watched: false, position: 0 });
    expect(await screen.findByText("New")).toBeInTheDocument();
  });

  it("drops the NEW chip once started or watched", async () => {
    renderWith({ ...FINISHED, object_id: 90201, watched: false, position: 120 });
    await screen.findByText("NFL Football");
    expect(screen.queryByText("New")).toBeNull();
  });

  it("shows a Watched chip for a watched recording", async () => {
    renderWith({ ...FINISHED, object_id: 90210, watched: true, position: 0 });
    expect(await screen.findByText("Watched")).toBeInTheDocument();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("the watched toggle marks the recording watched", async () => {
    const spy = vi.spyOn(api, "setRecordingWatched")
      .mockResolvedValue({ object_id: 90202, watched: true });
    renderWith({ ...FINISHED, object_id: 90202, watched: false, position: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Mark watched" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(90202, true));
  });

  it("un-marking watched writes position 1, not watched:false (avoids New)", async () => {
    const pos = vi.spyOn(api, "setRecordingPosition")
      .mockResolvedValue({ object_id: 90205, position: 1 });
    const watched = vi.spyOn(api, "setRecordingWatched");
    renderWith({ ...FINISHED, object_id: 90205, watched: true, position: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Mark unwatched" }));
    await waitFor(() => expect(pos).toHaveBeenCalledWith(90205, 1));
    expect(watched).not.toHaveBeenCalled();
  });

  it("the position-1 sentinel offers no Resume (and no New chip)", async () => {
    renderWith({ ...FINISHED, object_id: 90206, watched: false, position: 1 });
    await screen.findByText("NFL Football");
    expect(screen.queryByText(/^Resume/)).toBeNull();
    expect(screen.queryByText("New")).toBeNull();
    // Collapsed to the single full-picture Play (no Resume/From-start pair).
    expect(screen.queryByText("From start")).toBeNull();
  });

  it("a genuine sub-30s position still offers Resume", async () => {
    renderWith({ ...FINISHED, object_id: 90207, watched: false, position: 10 });
    expect(await screen.findByText(/Resume 0:10/)).toBeInTheDocument();
  });

  it("the protect toggle protects the recording", async () => {
    const spy = vi.spyOn(api, "setProtected")
      .mockResolvedValue({ object_id: 90203, protected: true });
    renderWith({ ...FINISHED, object_id: 90203, protected: false });
    fireEvent.click(
      await screen.findByRole("button", { name: "Protect from deletion" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledWith(90203, true));
  });

  it("draws the eye the recording is in, not the one the click makes", async () => {
    // Watched wears an open eye; unwatched wears the struck-through one. Same
    // rule as the lock beside it, and as the series panel's episode rows.
    renderWith({ ...FINISHED, object_id: 90213, watched: true });

    const toggle = await screen.findByRole("button", { name: "Mark unwatched" });
    expect(toggle.querySelector(".lucide-eye")).toBeTruthy();
    expect(toggle.querySelector(".lucide-eye-off")).toBeNull();
  });

  it("draws a struck-through eye on one not yet watched", async () => {
    renderWith({ ...FINISHED, object_id: 90214, watched: false });

    expect((await screen.findByRole("button", { name: "Mark watched" }))
      .querySelector(".lucide-eye-off")).toBeTruthy();
  });

  it("draws the lock the recording is in, not the one the click makes", async () => {
    // A protected recording wears a CLOSED lock. Drawing the act instead — an
    // open lock, because clicking opens it — reads at a glance as
    // "unprotected", which is the opposite of the truth.
    renderWith({ ...FINISHED, object_id: 90211, protected: true });

    const toggle = await screen.findByRole("button", { name: "Remove protection" });
    expect(toggle.querySelector(".lucide-lock")).toBeTruthy();
    expect(toggle.querySelector(".lucide-lock-open")).toBeNull();
  });

  it("draws an open lock on one that is not protected", async () => {
    renderWith({ ...FINISHED, object_id: 90212, protected: false });

    const toggle = await screen.findByRole("button", { name: "Protect from deletion" });
    expect(toggle.querySelector(".lucide-lock-open")).toBeTruthy();
  });

  it("a downloading keep shows a cancel control that cancels", async () => {
    const cancel = vi.spyOn(api, "cancelKeep")
      .mockResolvedValue({ pinned: false, canceled: true });
    renderWith({
      ...FINISHED, object_id: 90300, pinned: true, cache_state: "partial",
      cache_progress: 0.5, paused: false, cached_seconds: 100,
      rate: { mbps: 2.5, realtime: 0.5 },
    });
    fireEvent.click(await screen.findByRole("button", { name: /cancel download/i }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(90300));
  });

  it("a failed keep shows Download failed + a Resume that restarts it", async () => {
    const resume = vi.spyOn(api, "resumeKeep").mockResolvedValue({ paused: false });
    renderWith({
      ...FINISHED, object_id: 90301, pinned: true, cache_state: "failed",
      cache_progress: 0.9,
    });
    expect(await screen.findByText(/download failed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith(90301));
  });

  it("shows season and episode inline when both are present", async () => {
    renderWith({
      ...FINISHED, object_id: 90204, title: "Wild Kratts",
      season_number: 3, episode_number: 23,
    });
    expect(await screen.findByText(/S3 E23/)).toBeInTheDocument();
  });

  it("offers a clear-custom-image button only when a custom image exists", async () => {
    renderWith({ ...FINISHED, object_id: 90220, cover_frame: 42 });
    await screen.findByText("NFL Football");
    expect(screen.getByRole("button", { name: /remove custom image/i }))
      .toBeInTheDocument();
  });

  it("hides the clear-custom-image button when there is no custom image", async () => {
    renderWith({ ...FINISHED, object_id: 90221, cover_frame: null });
    await screen.findByText("NFL Football");
    expect(screen.queryByRole("button", { name: /remove custom image/i })).toBeNull();
  });

  it("the clear-custom-image button clears the custom image", async () => {
    const spy = vi.spyOn(api, "clearRecordingCover")
      .mockResolvedValue({ object_id: 90222, cover_frame: null });
    renderWith({ ...FINISHED, object_id: 90222, cover_frame: 42 });
    fireEvent.click(
      await screen.findByRole("button", { name: /remove custom image/i }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledWith(90222));
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


/**
 * The Library's own toolbar: a search field and the content filter, above the
 * first day's rule.
 *
 * Both narrow what is already loaded. The header's search is a route — a
 * results page across the whole library — where these two are a lens on the
 * page in front of you, which is why neither touches the URL.
 */
describe("the Library toolbar", () => {
  const KRATTS: Recording = {
    ...REC, object_id: 90001, identifier: 90001,
    path: "/recordings/series/episodes/90001",
    title: "Wild Kratts", subtitle: "The Fourth Bald Eagle",
    description: "Martin and Chris help out when a bald eagle goes missing.",
    kind: "episode", genres: ["Children", "Documentary"],
  };
  const FILM: Recording = {
    ...REC, object_id: 90002, identifier: 90002,
    path: "/recordings/movies/episodes/90002",
    title: "Knives Out", subtitle: null, description: null,
    kind: "movie", genres: [],
  };

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [REC, KRATTS, FILM], returned: 3, total: 3,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  /** The filter field, addressed the way a viewer addresses it. */
  const field = () => screen.getByRole("searchbox", { name: /filter recordings/i });

  async function openFilter() {
    const menu = within(document.querySelector<HTMLElement>("[data-library-toolbar]")!);
    fireEvent.click(await menu.findByRole("button", { name: /All/ }));
    return menu;
  }

  it("filters the cards by title as it is typed", async () => {
    renderLibrary();
    await screen.findByText("Wild Kratts");

    fireEvent.change(field(), { target: { value: "knives" } });

    expect(screen.getByText("Knives Out")).toBeInTheDocument();
    expect(screen.queryByText("Wild Kratts")).not.toBeInTheDocument();
    expect(screen.queryByText("NFL Football")).not.toBeInTheDocument();
  });

  it("looks in the episode title and the blurb, not only the show", async () => {
    // An episode is as often remembered by what it was about as by what the
    // show is called.
    renderLibrary();
    await screen.findByText("Wild Kratts");

    fireEvent.change(field(), { target: { value: "bald eagle" } });
    expect(screen.getByText("Wild Kratts")).toBeInTheDocument();

    fireEvent.change(field(), { target: { value: "arrowhead" } });
    expect(screen.getByText("NFL Football")).toBeInTheDocument();
    expect(screen.queryByText("Wild Kratts")).not.toBeInTheDocument();
  });

  it("empties on Escape rather than merely losing focus", async () => {
    // The field holds the only thing standing between the viewer and the whole
    // library, so the way out of it is the way back to everything.
    renderLibrary();
    await screen.findByText("Wild Kratts");
    fireEvent.change(field(), { target: { value: "knives" } });

    fireEvent.keyDown(field(), { key: "Escape" });

    expect(screen.getByText("Wild Kratts")).toBeInTheDocument();
    expect(field()).toHaveValue("");
  });

  it("files a film under Movies without asking the device anything", async () => {
    // A film carries no genres - there is no show record behind it - so the
    // filter reads `kind`, which its own path already said.
    renderLibrary();
    await screen.findByText("Knives Out");
    const menu = await openFilter();

    fireEvent.click(menu.getByRole("menuitemradio", { name: /Movies/ }));

    expect(screen.getByText("Knives Out")).toBeInTheDocument();
    expect(screen.queryByText("Wild Kratts")).not.toBeInTheDocument();
  });

  it("files a game under Sports the same way", async () => {
    renderLibrary();
    await screen.findByText("NFL Football");
    const menu = await openFilter();

    fireEvent.click(menu.getByRole("menuitemradio", { name: /Sports/ }));

    expect(screen.getByText("NFL Football")).toBeInTheDocument();
    expect(screen.queryByText("Knives Out")).not.toBeInTheDocument();
  });

  it("filters by the genres of the show an episode belongs to", async () => {
    // The recording carries none of its own; the listing goes and gets them.
    renderLibrary();
    await screen.findByText("Wild Kratts");
    const menu = await openFilter();

    fireEvent.click(menu.getByRole("menuitemradio", { name: /Documentary/ }));

    expect(screen.getByText("Wild Kratts")).toBeInTheDocument();
    expect(screen.queryByText("Knives Out")).not.toBeInTheDocument();
  });

  it("says nothing matches, and offers the way back", async () => {
    // A library that holds things and a toolbar that finds none of them are
    // two different states; one message for both reads as "your recordings are
    // gone".
    renderLibrary();
    await screen.findByText("Wild Kratts");

    fireEvent.change(field(), { target: { value: "zzzz" } });
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
    expect(screen.queryByText(/no recordings found/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));

    expect(screen.getByText("Wild Kratts")).toBeInTheDocument();
    expect(field()).toHaveValue("");
  });

  it("keeps an empty library's own message", async () => {
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [], returned: 0, total: 0,
    }));
    renderLibrary();

    expect(await screen.findByText(/no recordings found/i)).toBeInTheDocument();
  });

  it("leaves the URL alone", async () => {
    // Unlike the header's search, which names a page anyone can link to. The
    // page's own route is all the hash ever holds here.
    renderLibrary();
    await screen.findByText("Wild Kratts");
    const before = window.location.hash;

    fireEvent.change(field(), { target: { value: "knives" } });

    expect(window.location.hash).toBe(before);
  });
});


/**
 * The Library's layout menus: what the cards are grouped under, and in what
 * order.
 *
 * Unlike the search box and the content filter beside them, these two are
 * remembered — and server-side, so the answer follows the viewer to the next
 * machine rather than living in one browser's site data.
 */
describe("the Library's grouping and sort", () => {
  const KRATTS: Recording = {
    ...REC, object_id: 90001, identifier: 90001,
    path: "/recordings/series/episodes/90001",
    title: "Wild Kratts", subtitle: "Temple of Tigers", description: null,
    start: "2026-09-20T15:00:00Z",
    series_path: "/recordings/series/900", sport_path: null,
    kind: "episode", genres: [],
    channel: { identifier: "S1_007_01", call_sign: "PBS", network: "PBS",
               number: "7.1", kind: "ota" },
  };
  const GAME: Recording = {
    ...REC, object_id: 90002, identifier: 90002,
    title: "NFL Football", subtitle: "Giants at Rams",
    start: "2026-09-21T22:15:00Z",
    series_path: null, sport_path: "/recordings/sports/63558",
    kind: "sport", genres: ["Football"],
  };

  function mockLibrary(prefs: Record<string, string> = {}) {
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [GAME, KRATTS], returned: 2, total: 2,
    }));
    vi.spyOn(api, "prefs").mockResolvedValue(prefs);
    return vi.spyOn(api, "putPref").mockResolvedValue({ ok: true });
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  /** Open one of the two layout menus and return it, scoped. */
  async function openMenu(name: RegExp) {
    const menus = within(document.querySelector<HTMLElement>("[data-layout-menus]")!);
    fireEvent.click(await menus.findByRole("button", { name }));
    return menus;
  }

  /** Every group heading on the page, in the order it is drawn. */
  function headings(): string[] {
    return [...document.querySelectorAll("[data-library-heading]")]
      .map(el => el.textContent ?? "");
  }

  it("opens grouped by day, newest first", async () => {
    mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    expect(headings()).toEqual(["Monday 9/21", "Sunday 9/20"]);
  });

  it("regroups under one heading per show", async () => {
    mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    const menus = await openMenu(/group by/i);
    fireEvent.click(menus.getByRole("menuitemradio", { name: /Show/ }));

    await waitFor(() => expect(headings()).toEqual(["NFL Football", "Wild Kratts"]));
  });

  it("regroups by station, named as the card names it", async () => {
    mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    const menus = await openMenu(/group by/i);
    fireEvent.click(menus.getByRole("menuitemradio", { name: /Channel/ }));

    await waitFor(() => expect(headings()).toEqual(["23.1 KTMFABC", "7.1 PBS"]));
  });

  it("turns the days around for Oldest", async () => {
    mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    const menus = await openMenu(/sort by/i);
    fireEvent.click(menus.getByRole("menuitemradio", { name: /Oldest/ }));

    await waitFor(() => expect(headings()).toEqual(["Sunday 9/20", "Monday 9/21"]));
  });

  it("offers episode order, and reads a show forwards under it", async () => {
    // The games have no numbering at all, so they fall back to their dates —
    // which is the whole reason this order exists rather than one that only
    // understands numbers.
    const put = mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    const group = await openMenu(/group by/i);
    fireEvent.click(group.getByRole("menuitemradio", { name: /Show/ }));
    const sort = await openMenu(/sort by/i);
    fireEvent.click(sort.getByRole("menuitemradio", { name: /Episode/ }));

    // Shows in name order — S1E1 before S1E2 says nothing about which show
    // comes first.
    await waitFor(() => expect(headings()).toEqual(["NFL Football", "Wild Kratts"]));
    await waitFor(() => expect(put).toHaveBeenCalledWith("library.sort", "episode"));
  });

  it("remembers a choice for next time", async () => {
    const put = mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    const menus = await openMenu(/group by/i);
    fireEvent.click(menus.getByRole("menuitemradio", { name: /Show/ }));

    await waitFor(() => expect(put).toHaveBeenCalledWith("library.group", "show"));
  });

  it("opens on what was chosen last time", async () => {
    mockLibrary({ "library.group": "channel", "library.sort": "title" });
    renderLibrary();
    await screen.findByText("NFL Football");

    await waitFor(() =>
      expect(headings()).toEqual(["23.1 KTMFABC", "7.1 PBS"]));
  });

  it("falls back to its own layout when nothing has been chosen", async () => {
    // And when the preference cannot be read at all: a page that will not draw
    // because a preference request failed is a worse answer than the default.
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
    vi.spyOn(api, "recordings").mockResolvedValue(list({
      recordings: [GAME, KRATTS], returned: 2, total: 2,
    }));
    vi.spyOn(api, "prefs").mockRejectedValue(new Error("offline"));
    renderLibrary();

    await screen.findByText("NFL Football");
    expect(headings()).toEqual(["Monday 9/21", "Sunday 9/20"]);
  });

  it("ignores a stored value the menu no longer offers", async () => {
    // Rows outlive options. A layout the page cannot draw must not be what it
    // opens on.
    mockLibrary({ "library.group": "genre" });
    renderLibrary();
    await screen.findByText("NFL Football");

    expect(headings()).toEqual(["Monday 9/21", "Sunday 9/20"]);
  });

  it("draws cards until told otherwise", async () => {
    mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    // The description is a card's, and a row has no room for one.
    expect(screen.getByText("AFC West matchup at Arrowhead Stadium."))
      .toBeInTheDocument();
  });

  it("draws rows when the stored layout says so", async () => {
    mockLibrary({ "library.layout": "list" });
    renderLibrary();

    expect(await screen.findByRole("button", { name: /Play NFL Football/ }))
      .toBeInTheDocument();
    expect(screen.queryByText("AFC West matchup at Arrowhead Stadium.")).toBeNull();
  });

  it("keeps its headings whichever layout is drawing", async () => {
    // The grouping, the rule and the storage readout are the page's landmarks.
    // Switching layout must not move them.
    mockLibrary({ "library.layout": "list" });
    renderLibrary();
    await screen.findByRole("button", { name: /Play NFL Football/ });

    expect(headings()).toEqual(["Monday 9/21", "Sunday 9/20"]);
  });

  it("remembers the layout the moment it is switched", async () => {
    const putPref = mockLibrary();
    renderLibrary();
    await screen.findByText("NFL Football");

    fireEvent.click(screen.getByRole("button", { name: /List/ }));

    // The page rearranges in the same beat the switch was clicked; the write
    // that remembers it follows.
    await waitFor(() =>
      expect(screen.queryByText("AFC West matchup at Arrowhead Stadium.")).toBeNull());
    await waitFor(() =>
      expect(putPref).toHaveBeenCalledWith("library.layout", "list"));
  });
});

/** Answer `(max-width: 639px)` — and only that query — with `matches`. */
function stubPhone(matches: boolean) {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matches && query === "(max-width: 639px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = real; };
}

/**
 * The Library's filter at phone width.
 *
 * The same move the topbar search makes, for the same reason: a full-width
 * field and two menus cannot share a 400px row, and the field is the one of
 * the three that is empty most of the time.
 */
describe("the Library's filter at phone width", () => {
  let restoreMedia = () => {};

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(api, "storage").mockResolvedValue({
      pinned_bytes: 0, cache_bytes: 0, total_bytes: 0,
      budget_bytes: 250 * 1024 ** 3, free_bytes: 1024 ** 4, pinned_count: 0,
    });
    vi.spyOn(api, "recordings").mockResolvedValue(list());
    vi.spyOn(api, "prefs").mockResolvedValue({});
    vi.spyOn(api, "putPref").mockResolvedValue({ ok: true });
  });
  afterEach(() => { restoreMedia(); vi.restoreAllMocks(); });

  const field = () => screen.getByPlaceholderText(/filter recordings/i);

  it("is an icon, not a field, until it is asked for", async () => {
    restoreMedia = stubPhone(true);
    renderLibrary();
    await screen.findByText("NFL Football");

    expect(screen.getByRole("button", { name: "Filter recordings" }))
      .toBeInTheDocument();
    // Hidden rather than unmounted: the input's value IS the filter, and
    // unmounting it would drop the query every time the row narrowed.
    expect(field().parentElement!.className).toMatch(/\bhidden\b/);
  });

  it("opens into the field when the icon is tapped", async () => {
    restoreMedia = stubPhone(true);
    renderLibrary();
    await screen.findByText("NFL Football");

    fireEvent.click(screen.getByRole("button", { name: "Filter recordings" }));

    expect(field().parentElement!.className).not.toMatch(/\bhidden\b/);
    expect(field()).toHaveFocus();
  });

  it("gives the row back, and drops the query with it", async () => {
    restoreMedia = stubPhone(true);
    renderLibrary();
    await screen.findByText("NFL Football");
    fireEvent.click(screen.getByRole("button", { name: "Filter recordings" }));
    fireEvent.change(field(), { target: { value: "kratts" } });

    fireEvent.click(screen.getByRole("button", { name: "Close filter" }));

    // A filter left behind an icon is a library missing recordings for no
    // reason anyone can see.
    expect(screen.getByRole("button", { name: "Filter recordings" }))
      .toBeInTheDocument();
    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
  });

  it("is simply the field on anything wider", async () => {
    restoreMedia = stubPhone(false);
    renderLibrary();
    await screen.findByText("NFL Football");

    expect(screen.queryByRole("button", { name: "Filter recordings" })).toBeNull();
    expect(field().parentElement!.className).not.toMatch(/\bhidden\b/);
  });

  it("drops the words in front of the two menus", async () => {
    // "Group Day" and "Sort Episode" are what makes the pair readable at a
    // glance on a wide row. On a narrow one the words are the first thing
    // that can go: the icons say which menu is which, and the value is the
    // part being read.
    restoreMedia = stubPhone(true);
    renderLibrary();
    await screen.findByText("NFL Football");

    expect(screen.getByRole("button", { name: "Group by: Day" }))
      .toHaveTextContent(/^Day$/);
    expect(screen.getByRole("button", { name: "Sort by: Newest" }))
      .toHaveTextContent(/^Newest$/);
  });

  it("keeps the words once there is room for them", async () => {
    restoreMedia = stubPhone(false);
    renderLibrary();
    await screen.findByText("NFL Football");

    expect(screen.getByRole("button", { name: "Group by: Day" }))
      .toHaveTextContent(/Group\s*Day/);
    expect(screen.getByRole("button", { name: "Sort by: Newest" }))
      .toHaveTextContent(/Sort\s*Newest/);
  });
});
