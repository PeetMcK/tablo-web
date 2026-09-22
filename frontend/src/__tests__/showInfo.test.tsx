import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShowInfo } from "../components/ShowInfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../api/tablo";
import type { AiringDetail } from "../api/tablo";
import { saveResume, resumeKey, __resetResumeForTests } from "../lib/resume";

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
    recording_id: null,
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
    // And with that the series is recording, so the editor hands over: the
    // rule is a Series Information matter from here. The REC line says what
    // took, so the control does not simply vanish without an answer.
    await waitFor(() => expect(screen.queryByText("Edit Series Recording")).toBeNull());
    expect(await screen.findByText(/REC ·/)).toBeInTheDocument();
  });

  it("puts what reaches past this airing under the hairline", async () => {
    // The seam is scope, the way the Tablo app draws it: what acts on this
    // episode above the line, what acts on the series below it.
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());
    const { container } = render(
      <ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}}
                onOpenSeries={vi.fn()} />);

    await screen.findByText("Edit Series Recording");
    const seam = container.querySelector("[data-series-seam]");
    expect(seam).not.toBeNull();
    expect(seam!.className).toMatch(/border-t/);
    expect(seam).toHaveTextContent("Edit Series Recording");
    expect(seam).toHaveTextContent("Series Information");
    expect(seam).not.toHaveTextContent("Record Episode");
  });

  it("offers the rule editor only for a series it is not recording yet", async () => {
    // Setting a series up from an episode is a fair thing to do here. Changing
    // one that is already running is a series-level act, and it has a proper
    // home: the drawer behind Series Information, which carries Keep and the
    // channel pin as well.
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      series: { path: "/guide/series/6472", schedule_rule: "all" },
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}}
                     onOpenSeries={vi.fn()} />);

    await screen.findByText("Finding Your Roots");
    expect(screen.queryByText("Edit Series Recording")).toBeNull();
    expect(screen.getByRole("button", { name: /series information/i }))
      .toBeInTheDocument();
  });

  it("does not offer the series rule from a finished recording", async () => {
    // A card about something already on the drive is the wrong place to hold a
    // control that can stop tonight's recording.
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      past: true, scheduled: true, recording_id: 86353,
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}}
                     onOpenSeries={vi.fn()} />);

    await screen.findByText("Finding Your Roots");
    expect(screen.queryByText("Edit Series Recording")).toBeNull();
  });

  it("keeps Delete with the episode actions, above the seam", async () => {
    // It ends one recording and nothing else, so it belongs with Watch rather
    // than stranded under the series block at the foot of the sheet.
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      past: true, scheduled: true, recording_id: 86353,
    }));
    const { container } = render(
      <ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}}
                onOpenSeries={vi.fn()} />);

    const del = await screen.findByRole("button", { name: /delete recording/i });
    const seam = container.querySelector("[data-series-seam]")!;
    expect(seam).not.toContainElement(del);
    expect(del.compareDocumentPosition(seam))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
    recorded_seconds: 1020, expected_seconds: 2341, title: "Let's Make a Deal", series_path: null,
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

/* The rule buttons no longer live on this card once a series is recording -
   the sheet offers them only to start a series off - so the suite that covered
   turning one off mid-capture moved with the control, to
   recordings-page.test.tsx ("says plainly that turning the rule off stops a
   recording in flight" and its neighbours). */

describe("the confirmation sits over the card", () => {
  // Raised here by Record Episode on something already airing - recording it
  // starts at once and catches only the rest. Any of the sheet's questions
  // would do; what these cover is how the question behaves over the card.
  const SERIES = "/guide/series/6137";
  const onAir = () => detail({
    title: "NHK Newsline", start: "2026-09-19T06:30Z", duration: 1800,
    airing_now: true, scheduled: false, past: false,
    series: { path: SERIES, schedule_rule: "none" },
  });

  async function raise(onClose: () => void = () => {}) {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    vi.spyOn(api, "airingDetail").mockResolvedValue(onAir());
    vi.spyOn(api, "scheduleAiring").mockResolvedValue(onAir());
    const view = render(<ShowInfo channel="ch1" start="2026-09-19T06:30Z"
                                  onClose={onClose} onTune={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /record episode/i }));
    await screen.findByRole("alertdialog");
    return view;
  }

  afterEach(() => vi.restoreAllMocks());

  it("asks in a dialog of its own, not a banner that shifts the card", async () => {
    // As a banner it pushed the artwork and everything under it down the sheet,
    // so the card jumped at the moment attention was needed on the question.
    await raise();

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/record this episode\?/i);
    // The card is still there underneath, unmoved.
    expect(screen.getByText("NHK Newsline")).toBeInTheDocument();
  });

  it("puts the safe way out under the cursor, not the destructive one", async () => {
    // A confirmation that opens with the destructive button focused is one
    // stray Return away from losing a recording. Raised from Delete rather
    // than Record Episode: only a destructive question defaults to Cancel,
    // and an ordinary one should still open on its action.
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      detail({ title: "NHK Newsline", recording_id: 86353, past: true }));
    render(<ShowInfo channel="ch1" start="2026-09-19T06:30Z"
                     onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    await screen.findByRole("alertdialog");

    expect(screen.getByRole("button", { name: /^cancel$/i })).toHaveFocus();
  });

  it("cancels the question on Escape without closing the sheet", async () => {
    const onClose = vi.fn();
    await raise(onClose);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("NHK Newsline")).toBeInTheDocument();
  });

  it("still closes the sheet on Escape when nothing is being asked", async () => {
    const onClose = vi.fn();
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    vi.spyOn(api, "airingDetail").mockResolvedValue(onAir());
    render(<ShowInfo channel="ch1" start="2026-09-19T06:30Z"
                     onClose={onClose} onTune={() => {}} />);
    await screen.findByText("NHK Newsline");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("does not close the sheet when the question's own backdrop is clicked", async () => {
    // The click lands inside the sheet's bounds; closing the whole sheet would
    // throw away the decision rather than dismissing the question.
    const onClose = vi.fn();
    const { container } = await raise(onClose);

    fireEvent.click(container.querySelector(".confirm-backdrop")!);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("opening the sheet", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits for the whole card rather than showing its buttons first", async () => {
    // The actions come from the id its opener already holds, so they rendered
    // instantly while the title, artwork and description waited on the fetch -
    // a bare pair of buttons, then the card popping in around them.
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    vi.spyOn(api, "recordingDetail").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "airingDetail").mockReturnValue(new Promise(() => {}));

    render(<ShowInfo channel="ch1" start="2026-09-20T22:15Z" recordingId={74776}
                     onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /watch now/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete recording/i })).toBeNull();
  });

  it("shows the card once, complete, when the answers arrive", async () => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    vi.spyOn(api, "airingLive").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      title: "NFL Football", recording_id: 74776,
    }));

    render(<ShowInfo channel="ch1" start="2026-09-20T22:15Z" recordingId={74776}
                     onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /watch now/i })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("watching what the sheet describes", () => {
  const SLOT = "2026-09-21T22:00Z";
  const airing = (over = {}) => detail({
    title: "Jeopardy!", start: SLOT, duration: 1800, ...over,
  });

  beforeEach(() => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
    vi.spyOn(api, "airingLive").mockRejectedValue(new Error("offline"));
    __resetResumeForTests();
    window.location.hash = "";
  });
  afterEach(() => vi.restoreAllMocks());

  it("continues a recording that was left part-watched", async () => {
    // The label says where pressing it lands, because resuming forty minutes
    // in is a surprise to anyone expecting the start.
    saveResume(resumeKey("recording", 86353), 1016, 2684);
    const onWatch = vi.fn();
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing({ recording_id: 86353 }));
    render(<ShowInfo channel="ch1" start={SLOT} onWatchRecording={onWatch}
                     onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /continue watching/i }));

    expect(onWatch).toHaveBeenCalledWith(86353);
  });

  it("offers to watch a recording nobody has started", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing({ recording_id: 86353 }));
    render(<ShowInfo channel="ch1" start={SLOT} onWatchRecording={vi.fn()}
                     onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /^watch now$/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue watching/i })).toBeNull();
  });

  it("prefers the recording over the broadcast when both exist", async () => {
    // A recording in progress plays from its first moment, so this is watching
    // from the start rather than joining half way - and it needs no tuner.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      airing({ recording_id: 86353, airing_now: true }));
    render(<ShowInfo channel="ch1" start={SLOT} onWatchRecording={vi.fn()}
                     onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /^watch now$/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /watch live/i })).toBeNull();
  });

  it("falls back to the broadcast when there is no recording", async () => {
    const onTune = vi.fn();
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      airing({ recording_id: null, airing_now: true }));
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={onTune} />);

    fireEvent.click(await screen.findByRole("button", { name: /watch live/i }));

    expect(onTune).toHaveBeenCalled();
  });

  it("offers nothing to watch when there is nothing to watch", async () => {
    // Next Tuesday's episode, unrecorded: a dead button reads as broken.
    vi.spyOn(api, "airingDetail").mockResolvedValue(
      airing({ recording_id: null, airing_now: false }));
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Jeopardy!");
    expect(screen.queryByRole("button", { name: /watch/i })).toBeNull();
  });

  it("keeps the player above the sheet, and clicks inside it out of the sheet's way", async () => {
    // The player rendered inside the sheet's backdrop and below it: every
    // click on the controls bubbled to the dismiss handler and shut the lot,
    // and the picture sat under the sheet at z-50 against its z-60.
    const onClose = vi.fn();
    vi.spyOn(api, "recording").mockResolvedValue({
      object_id: 86353, title: "Jeopardy!", duration: 1800,
    } as never);
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing({ recording_id: 86353 }));
    // The player reads through react-query, as it does in the app - App.tsx
    // wraps everything in a provider.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <ShowInfo channel="ch1" start={SLOT} onClose={onClose} onTune={() => {}} />
      </QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /^watch now$/i }));

    const stage = await waitFor(() => {
      const el = container.querySelector<HTMLElement>("[data-player-layer]");
      if (!el) throw new Error("no player layer");
      return el;
    });
    fireEvent.click(stage);

    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector("[data-player-layer]")).toBeInTheDocument();
  });

  it("plays where it stands rather than sending the viewer to the Library", async () => {
    // Routing there started the player behind this sheet, in another view, and
    // closing it left the viewer somewhere they had not chosen to be. The
    // player is an overlay that takes a recording - so the sheet fetches the
    // one it describes and opens it here.
    const fetched = vi.spyOn(api, "recording").mockResolvedValue({
      object_id: 86353, title: "Jeopardy!", duration: 1800,
    } as never);
    vi.spyOn(api, "airingDetail").mockResolvedValue(airing({ recording_id: 86353 }));
    // The player this opens reads through react-query, so it needs the provider
    // App.tsx gives it in the app; without one it throws past the assertions.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />
      </QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /^watch now$/i }));

    await waitFor(() => expect(fetched).toHaveBeenCalledWith(86353));
    expect(window.location.hash).not.toContain("library");
  });
});

describe("what the sheet knows when it opens", () => {
  const SLOT = "2026-09-22T00:00Z";
  const stale = (over = {}) => detail({
    title: "Jeopardy!", start: SLOT, duration: 1800,
    scheduled: true, schedule_state: "scheduled", past: false,
    series: { path: "/guide/series/6137", schedule_rule: "new" },
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks the device rather than trusting the mirror", async () => {
    // Measured: after a failed sync the mirror called an episode scheduled
    // that had been turned off in the Tablo app an hour earlier, and said the
    // series recorded "new" where the device said "all".
    const live = vi.spyOn(api, "airingLive").mockResolvedValue({
      schedule_state: "unscheduled", skip_reason: "none",
      scheduled: false, series_rule: "all",
    });
    vi.spyOn(api, "airingDetail").mockResolvedValue(stale());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Jeopardy!");

    await waitFor(() => expect(live).toHaveBeenCalledWith("ch1", SLOT));
    // The stale REC line is gone. The device says the series records All, so
    // the rule is not this card's to edit - that is the drawer's job now, and
    // the inline editor stays away.
    await waitFor(() =>
      expect(screen.queryByText(/REC · RECORD/i)).toBeNull());
    expect(screen.queryByText("Edit Series Recording")).toBeNull();
  });

  it("keeps what the mirror said when the device will not answer", async () => {
    // A sheet a sync behind beats a sheet that refuses to open.
    vi.spyOn(api, "airingLive").mockRejectedValue(new Error("device down"));
    vi.spyOn(api, "airingDetail").mockResolvedValue(stale());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText(/REC · RECORD/i)).toBeInTheDocument();
  });
});

describe("moving between an episode and its series", () => {
  const SLOT = "2026-09-21T22:00Z";
  const episode = (over = {}) => detail({
    title: "Jeopardy!", start: SLOT, duration: 1800,
    series: { path: "/guide/series/6137", schedule_rule: "new" },
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers the series behind the episode", async () => {
    const onOpenSeries = vi.fn();
    vi.spyOn(api, "airingDetail").mockResolvedValue(episode());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}}
                     onOpenSeries={onOpenSeries} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /series information/i }));

    // The guide path is all this sheet knows; the caller turns it into
    // whatever its own series panel needs.
    expect(onOpenSeries).toHaveBeenCalledWith("/guide/series/6137", "Jeopardy!");
  });

  it("offers nothing for an airing with no series behind it", async () => {
    // A one-off film has no series to open, so the control would lead nowhere.
    vi.spyOn(api, "airingDetail").mockResolvedValue(episode({ series: null }));
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}}
                     onOpenSeries={vi.fn()} onTune={() => {}} />);

    await screen.findByText("Jeopardy!");
    expect(screen.queryByRole("button", { name: /series information/i })).toBeNull();
  });

  it("says Back to Series when that is where it was opened from", async () => {
    // Onward and back are different journeys: the panel is directly behind
    // this sheet, so offering to "open" it would loop.
    const onClose = vi.fn();
    vi.spyOn(api, "airingDetail").mockResolvedValue(episode());
    render(<ShowInfo channel="ch1" start={SLOT} backToSeries
                     onClose={onClose} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /back to series/i }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /series information/i })).toBeNull();
  });
});

describe("deleting the recording an airing produced", () => {
  const SLOT = "2026-09-18T07:00Z";
  const recorded = (over = {}) => detail({
    title: "Saturday Night Live", start: SLOT, duration: 3600,
    airing_now: false, scheduled: true, past: true,
    recording_id: 86353,
    series: { path: "/guide/series/6291", schedule_rule: "none" },
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(api, "inProgressRecordings").mockResolvedValue({ recordings: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers to delete what this airing recorded", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(recorded());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByRole("button", { name: /delete recording/i }))
      .toBeInTheDocument();
  });

  it("offers nothing to delete when the airing recorded nothing", async () => {
    vi.spyOn(api, "airingDetail").mockResolvedValue(recorded({ recording_id: null }));
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("Saturday Night Live");
    expect(screen.queryByRole("button", { name: /delete recording/i })).toBeNull();
  });

  it("asks before deleting, because the Tablo cannot undo it", async () => {
    const del = vi.spyOn(api, "deleteRecording").mockResolvedValue({
      object_id: 86353, deleted: true,
    });
    vi.spyOn(api, "airingDetail").mockResolvedValue(recorded());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));

    expect(del).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(screen.getByRole("button", { name: /^cancel$/i })).toHaveFocus();
  });

  it("deletes it on the device once confirmed", async () => {
    const del = vi.spyOn(api, "deleteRecording").mockResolvedValue({
      object_id: 86353, deleted: true,
    });
    vi.spyOn(api, "airingDetail").mockResolvedValue(recorded());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(86353));
  });

  it("closes everything at once, without waiting for the Tablo", async () => {
    // The question, the sheet and the card behind it all describe the same
    // thing, so they go together. Waiting on the round trip left the answer
    // dismissed and the sheet sitting there for a beat, which reads as a
    // click that did not land.
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    // Never resolves: nothing below may depend on the device having answered.
    vi.spyOn(api, "deleteRecording").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "airingDetail").mockResolvedValue(recorded());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={onClose}
                     onDeleted={onDeleted} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    expect(onClose).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledWith(86353);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("still asks the Tablo to delete it", async () => {
    const del = vi.spyOn(api, "deleteRecording").mockResolvedValue({
      object_id: 86353, deleted: true,
    });
    vi.spyOn(api, "airingDetail").mockResolvedValue(recorded());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(86353));
  });

  it("reports a refusal to whoever opened it, since the sheet has gone", async () => {
    // Optimism has to be answerable for: the card was removed on the promise
    // of a delete, and if the device refused, whoever removed it has to put it
    // back and say why.
    const onDeleteFailed = vi.fn();
    vi.spyOn(api, "deleteRecording")
      .mockRejectedValue(new Error("The Tablo would not delete this recording."));
    vi.spyOn(api, "airingDetail").mockResolvedValue(recorded());
    render(<ShowInfo channel="ch1" start={SLOT} onClose={() => {}}
                     onDeleteFailed={onDeleteFailed} onTune={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(onDeleteFailed).toHaveBeenCalledWith(
      86353, "The Tablo would not delete this recording."));
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

/**
 * A recording describes itself. The guide only says what can still be done.
 *
 * The device keeps a recording's title, description and artwork for as long as
 * it keeps the recording; the guide holds no past airings at all. Measured
 * 2026-09-18: the mirror's earliest row was from the 15th while recordings from
 * the 13th were still in the library, and every one of their sheets read
 * "Information unavailable".
 */
describe("ShowInfo on a recording", () => {
  afterEach(() => vi.restoreAllMocks());

  /** What `/recordings/{id}/detail` answers: description, no schedule. */
  function recorded(over: Partial<AiringDetail> = {}): AiringDetail {
    return detail({
      title: "NFL Football",
      episode_title: "Green Bay Packers at Minnesota Vikings",
      season_number: null, episode_number: null,
      description: "The Minnesota Vikings host the Green Bay Packers.",
      genres: ["Football"], rating: null,
      image_url: "/api/channels/image/38765",
      airing_now: false, schedulable: false, scheduled: false, past: true,
      schedule_state: null, skip_reason: null,
      recording_id: 66220, series: null,
      ...over,
    });
  }

  it("describes a recording the guide has forgotten", async () => {
    const air = vi.spyOn(api, "airingDetail")
      .mockRejectedValue(new Error("404 airing not found"));
    vi.spyOn(api, "recordingDetail").mockResolvedValue(recorded());

    render(<ShowInfo channel="ch1" start="2026-09-13T20:25Z" recordingId={66220}
                     onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
    expect(screen.getByText(/Minnesota Vikings host/)).toBeInTheDocument();
    expect(screen.getByText("Football")).toBeInTheDocument();
    expect(screen.queryByText(/information unavailable/i)).toBeNull();
    expect(air).toHaveBeenCalled();
  });

  it("asks the device even when the opener has no airing to offer", async () => {
    const air = vi.spyOn(api, "airingDetail");
    vi.spyOn(api, "recordingDetail").mockResolvedValue(recorded());

    render(<ShowInfo channel="ch1" start={null} recordingId={66220}
                     onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
    expect(air).not.toHaveBeenCalled();
  });

  it("never says recording is unavailable on a channel that recorded", async () => {
    // `schedulable` is false because there is no listing to write against,
    // which says nothing about the channel - and the recording is proof.
    vi.spyOn(api, "airingDetail").mockRejectedValue(new Error("404"));
    vi.spyOn(api, "recordingDetail").mockResolvedValue(recorded());

    render(<ShowInfo channel="ch1" start="2026-09-13T20:25Z" recordingId={66220}
                     onClose={() => {}} onTune={() => {}} />);

    await screen.findByText("NFL Football");
    expect(screen.queryByText(/isn't available on this channel/i)).toBeNull();
  });

  it("takes the guide's schedule answers when there is still a listing", async () => {
    // The case the merge exists for: something recording right now. Its Stop
    // Recording button is a write against the airing, so the airing's answers
    // have to win - while the title and artwork stay the device's.
    vi.spyOn(api, "recordingDetail").mockResolvedValue(recorded());
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      title: "Stale guide title",
      image_url: "/api/channels/image/111",
      schedulable: true, scheduled: true, past: false, airing_now: true,
      series: { path: "/guide/sports/38763", schedule_rule: "all" },
    }));

    render(<ShowInfo channel="ch1" start="2026-09-13T20:25Z" recordingId={66220}
                     onClose={() => {}} onTune={() => {}} />);

    // The device's description of the programme.
    expect(await screen.findByText("NFL Football")).toBeInTheDocument();
    expect(screen.queryByText("Stale guide title")).toBeNull();
    // The guide's answers about what can be done to it: it is scheduled, and
    // the scope the guide reports is the one named.
    expect(screen.getByText(/all episodes/i)).toBeInTheDocument();
    // Watching, though, goes to the recording rather than the broadcast: it is
    // already being written and plays from its first moment, so this starts at
    // the beginning instead of joining half way, and costs no tuner.
    expect(screen.getByRole("button", { name: /^watch now$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /watch live/i })).toBeNull();
  });

  it("fails only when neither source has anything", async () => {
    vi.spyOn(api, "airingDetail").mockRejectedValue(new Error("404"));
    vi.spyOn(api, "recordingDetail").mockRejectedValue(new Error("502"));

    render(<ShowInfo channel="ch1" start="2026-09-13T20:25Z" recordingId={66220}
                     onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText(/information unavailable/i)).toBeInTheDocument();
  });

  it("still renders from the guide alone when the opener names no recording", async () => {
    const rec = vi.spyOn(api, "recordingDetail");
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail());

    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}} />);

    expect(await screen.findByText("Finding Your Roots")).toBeInTheDocument();
    expect(rec).not.toHaveBeenCalled();
  });
});



/**
 * A game is an episode of its sport, and now says so.
 *
 * The device files an NFL game under `/guide/sports/{id}` and its recordings
 * under `/recordings/sports/{id}`, carries a title, a cover and a schedule rule
 * on both, and its own app heads a game's sheet "Series Recording Scheduled".
 * Our sheet offered nothing: the guide mirror read only `series_path`, so a
 * game reached it with no show at all.
 */
describe("the route from a programme to the show behind it", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens a game's sport the way an episode opens its series", async () => {
    const open = vi.fn();
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      title: "NFL Football",
      episode_title: "Green Bay Packers at Minnesota Vikings",
      series: { path: "/guide/sports/38763", schedule_rule: "all" },
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}}
                     onOpenSeries={open} />);

    fireEvent.click(await screen.findByRole("button", { name: /series information/i }));

    expect(open).toHaveBeenCalledWith("/guide/sports/38763", "NFL Football");
  });

  it("uses the recording's own show path over the guide's", async () => {
    // The two name the same show in different namespaces, and only one of them
    // is still true a week later: the guide holds no airing for a game once it
    // has been played, where the recording keeps its `sport_path` for life.
    const open = vi.fn();
    vi.spyOn(api, "recordingDetail").mockResolvedValue(detail({
      title: "NFL Football",
      recording_id: 66220,
      show_path: "/recordings/sports/63558",
      series: { path: "/guide/sports/38763", schedule_rule: "all" },
    }));
    render(<ShowInfo channel="ch1" start={null} recordingId={66220}
                     onClose={() => {}} onTune={() => {}} onOpenSeries={open} />);

    fireEvent.click(await screen.findByRole("button", { name: /series information/i }));

    expect(open).toHaveBeenCalledWith("/recordings/sports/63558", "NFL Football");
  });

  it("still offers the show when nothing about the airing is left", async () => {
    // `schedulable` is an airing's word, and the seam used to require it - so a
    // recording whose airing had aged out of the guide lost the route to its
    // own show along with the ability to schedule something already past.
    const open = vi.fn();
    vi.spyOn(api, "recordingDetail").mockResolvedValue(detail({
      title: "NFL Football",
      recording_id: 66220,
      schedulable: false,
      past: true,
      series: null,
      show_path: "/recordings/sports/63558",
    }));
    render(<ShowInfo channel="ch1" start={null} recordingId={66220}
                     onClose={() => {}} onTune={() => {}} onOpenSeries={open} />);

    expect(await screen.findByRole("button", { name: /series information/i }))
      .toBeInTheDocument();
    // And no rule editor with it: nothing here can be scheduled.
    expect(screen.queryByText("Edit Series Recording")).toBeNull();
  });

  it("offers nothing for a programme that belongs to no show", async () => {
    // A film. There is nothing behind it to open, and a button that opened an
    // empty panel would be worse than none.
    vi.spyOn(api, "airingDetail").mockResolvedValue(detail({
      title: "Knives Out", series: null, show_path: null,
    }));
    render(<ShowInfo channel="ch1" start="s" onClose={() => {}} onTune={() => {}}
                     onOpenSeries={vi.fn()} />);

    await screen.findByText("Knives Out");
    expect(screen.queryByRole("button", { name: /series information/i })).toBeNull();
  });
});
