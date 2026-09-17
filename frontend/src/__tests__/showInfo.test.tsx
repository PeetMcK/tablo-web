import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShowInfo } from "../components/ShowInfo";
import { api } from "../api/tablo";
import type { AiringDetail } from "../api/tablo";

function detail(over: Partial<AiringDetail> = {}): AiringDetail {
  return {
    title: "Finding Your Roots",
    episode_title: "Rags to Riches",
    season_number: 12, episode_number: 10,
    description: "Mapping the roots of Kate Burton.",
    start: "2026-09-16T08:00Z", duration: 3600,
    orig_air_date: null, genres: ["Documentary"], rating: "tvpg",
    image_url: "/api/channels/image/999", airing_now: true,
    schedulable: true, scheduled: false, past: false,
    schedule_state: "none", skip_reason: null,
    series: { path: "/guide/series/6472", schedule_rule: "none" },
    channel: { identifier: "ch1", call_sign: "KPAX", major: 8, minor: 1,
               network: "PBS", logo_url: null, kind: "ota" },
    ...over,
  };
}

describe("ShowInfo", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows what the guide cell could not", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText("Finding Your Roots")).toBeInTheDocument();
    expect(screen.getByText("Rags to Riches")).toBeInTheDocument();
    expect(screen.getByText(/S12 E10/)).toBeInTheDocument();
    expect(screen.getByText(/TV-PG/i)).toBeInTheDocument();
  });

  it("names the channel once, not twice", async () => {
    // The eyebrow above the title carries network and channel number. The meta
    // row used to repeat both, so every sheet read "LOCALFAST · 7.99" two lines
    // under "7.99 · LOCALFAST".
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Finding Your Roots");
    expect(screen.getAllByText(/PBS/)).toHaveLength(1);
    expect(screen.getAllByText(/8\.1/)).toHaveLength(1);
  });

  it("offers to tune only while the programme is on", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({ airing_now: true }));
    const onTune = vi.fn();
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={onTune} />);

    fireEvent.click(await screen.findByRole("button", { name: /watch live/i }));
    expect(onTune).toHaveBeenCalled();
  });

  it("does not offer to tune to something that is not on", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({ airing_now: false }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Finding Your Roots");
    expect(screen.queryByRole("button", { name: /watch live/i })).toBeNull();
  });

  it("renders a bare airing without empty rows", async () => {
    // 7.4, 7.99, 13.5 and 501.5 carry no EPG data at all.
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      episode_title: null, season_number: null, episode_number: null,
      description: null, rating: null, image_url: null, genres: [],
    }));
    const { container } = render(
      <ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Finding Your Roots");
    expect(screen.queryByText(/S\d+ E\d+/)).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("closes on Escape", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    const onClose = vi.fn();
    render(<ShowInfo channel="ch1" start="s" onClose={onClose} onTune={() => {}} />);

    await screen.findByText("Finding Your Roots");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("offers to record an episode that is not being recorded", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    const schedule = vi.spyOn(api, "scheduleAiring")
      .mockResolvedValue(detail({ scheduled: true, schedule_state: "scheduled" }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /record episode/i }));
    // This airing is on now, so it asks first: recording would start at once
    // and capture only what is left.
    fireEvent.click(await screen.findByRole("button", { name: /^record$/i }));

    await waitFor(() => expect(schedule).toHaveBeenCalledWith("ch1", "s", true));
    expect(await screen.findByRole("button", { name: /don't record episode/i }))
      .toBeInTheDocument();
  });

  it("offers to stop recording one that is", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ scheduled: true, schedule_state: "scheduled" }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /don't record episode/i }))
      .toBeInTheDocument();
    expect(screen.getByText(/this episode only/i)).toBeInTheDocument();
  });

  it("says when a recording comes from the series rule", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      scheduled: true, schedule_state: "scheduled",
      series: { path: "/guide/series/6472", schedule_rule: "all" },
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText(/all episodes/i)).toBeInTheDocument();
  });

  it("sets the series rule", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    const schedule = vi.spyOn(api, "scheduleSeries").mockResolvedValue(detail({
      scheduled: true, schedule_state: "scheduled",
      series: { path: "/guide/series/6472", schedule_rule: "new" },
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /^new$/i }));
    // On-air episode: setting a rule starts recording it, so it asks first.
    fireEvent.click(await screen.findByRole("button", { name: /^set rule$/i }));

    await waitFor(() => expect(schedule).toHaveBeenCalledWith("ch1", "s", "new"));
    expect(await screen.findByRole("button", { name: /^new$/i }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("reverts and explains when the Tablo refuses", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    vi.spyOn(api, "scheduleAiring")
      .mockRejectedValue(new Error("Invalid parameter value"));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /record episode/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^record$/i }));

    expect(await screen.findByText(/invalid parameter value/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /record episode/i })).toBeInTheDocument();
  });

  it("does not offer to record what cannot be recorded", async () => {
    // OTT/FAST: the cloud carries no device path, no schedule block and no
    // series, so nothing can record it.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ schedulable: false, series: null }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Finding Your Roots");
    expect(screen.queryByRole("button", { name: /record episode/i })).toBeNull();
    expect(screen.getByText(/isn't available on this channel/i)).toBeInTheDocument();
  });

  it("keeps the series control on a programme that has already aired", async () => {
    // Nothing can record what has finished, but setting a rule from an old
    // listing is meaningful — it is about every episode still to come.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ airing_now: false, past: true }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record episode/i })).toBeNull();
  });

  it("still offers to record something merely upcoming", async () => {
    // `airing_now` is false for everything upcoming, which is the main thing
    // anyone records — gating on it would have hidden the button for all of it.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ airing_now: false, past: false }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /record episode/i }))
      .toBeInTheDocument();
  });

  /**
   * A channel the guide has no listing for at all.
   *
   * There is no airing to ask the device about, so the sheet has almost
   * nothing to say — and says it, rather than the guide tuning the moment a
   * blank row is brushed. Every other row in the guide opens this sheet; this
   * one used to be the exception that jumped straight into playback.
   */
  describe("with no listing to show", () => {
    it("asks the device for nothing", async () => {
      const airingDetail = vi.spyOn(api, "airingDetail");
      render(<ShowInfo channel="ch1" start={null} channelLabel="THENEST 13.5"
                       onClose={() => {}} onTune={() => {}} />);

      await screen.findByRole("dialog");
      expect(airingDetail).not.toHaveBeenCalled();
    });

    it("names the channel and says why it is empty", async () => {
      render(<ShowInfo channel="ch1" start={null} channelLabel="THENEST 13.5"
                       onClose={() => {}} onTune={() => {}} />);

      expect(await screen.findByText("THENEST 13.5")).toBeInTheDocument();
      expect(screen.getByText(/no programme information/i)).toBeInTheDocument();
    });

    it("still offers to watch it", async () => {
      // The whole point of the row: the channel is live and tunable, it is
      // only its listings that are missing.
      const onTune = vi.fn();
      render(<ShowInfo channel="ch1" start={null} channelLabel="THENEST 13.5"
                       onClose={() => {}} onTune={onTune} />);

      fireEvent.click(await screen.findByRole("button", { name: /watch live/i }));
      expect(onTune).toHaveBeenCalled();
    });
  });
});

describe("a recording in progress, from the sheet", () => {
  const SLOT = "2026-09-17T16:00:00Z";
  const LIVE = {
    object_id: 86113, channel_identifier: "ch1", start: SLOT, duration: 3600,
    recording_started: "2026-09-17T16:20:59Z",
    recorded_seconds: 1020, expected_seconds: 2341, title: "Let's Make a Deal",
  };

  const airing = (over = {}) => detail({
    title: "Let's Make a Deal", start: SLOT, duration: 3600,
    airing_now: true, scheduled: true, past: false,
    series: { path: "/guide/series/1", schedule_rule: "none" },
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [LIVE] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("says it is recording now, and how much exists", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText(/recording now/i)).toBeInTheDocument();
    expect(screen.getByText(/17m of 39m/i)).toBeInTheDocument();
  });

  it("draws the same coverage bar the other views draw", async () => {
    // 1259s into a 3600s slot: the tuner started 21 minutes late, and that gap
    // is the single most useful thing on this sheet.
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing());
    const { container } = render(
      <ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);
    await screen.findByText(/recording now/i);

    const fill = container.querySelector<HTMLElement>(".bg-danger.inset-y-0");
    expect(parseFloat(fill!.style.left)).toBeCloseTo(34.97, 1);
  });

  it("offers to stop it, and asks first", async () => {
    // Stopping keeps what was captured but does not resume - measured on a
    // real recording - so it is not something to do by a stray click.
    const stop = vi.spyOn(api, "scheduleAiring").mockResolvedValue(airing());
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    expect(stop).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /^stop$/i })).toBeInTheDocument();
  });

  it("shows no recording block when nothing is recording this airing", async () => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Let's Make a Deal");
    expect(screen.queryByText(/recording now/i)).toBeNull();
  });
});

describe("starting a recording is confirmed", () => {
  const SLOT = "2026-09-17T16:00:00Z";
  const onNow = (over = {}) => detail({
    title: "Let's Make a Deal", start: SLOT, duration: 3600,
    airing_now: true, scheduled: false, past: false,
    series: { path: "/guide/series/1", schedule_rule: "none" },
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks before recording something already airing", async () => {
    // It starts at once and captures only what is left, which is how three
    // stub recordings of four and eight seconds ended up in the library.
    const sched = vi.spyOn(api, "scheduleAiring").mockResolvedValue(onNow());
    vi.spyOn(api, "airingDetail").mockResolvedValue(onNow());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /record episode/i }));

    expect(sched).not.toHaveBeenCalled();
    expect(await screen.findByText(/already airing/i)).toBeInTheDocument();
  });

  it("asks before a series rule that would start one", async () => {
    // The rule buttons look like preferences and are not: setting one starts
    // recording the episode on air immediately.
    const rule = vi.spyOn(api, "scheduleSeries").mockResolvedValue(onNow());
    vi.spyOn(api, "airingDetail").mockResolvedValue(onNow());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /^all$/i }));

    expect(rule).not.toHaveBeenCalled();
    expect(await screen.findByText(/already airing/i)).toBeInTheDocument();
  });

  it("does not ask for an airing that has not started", async () => {
    // Nothing is captured part-way, so there is nothing to warn about.
    const sched = vi.spyOn(api, "scheduleAiring").mockResolvedValue(onNow({ airing_now: false }));
    vi.spyOn(api, "airingDetail").mockResolvedValue(onNow({ airing_now: false }));
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /record episode/i }));

    await waitFor(() => expect(sched).toHaveBeenCalled());
  });
});

