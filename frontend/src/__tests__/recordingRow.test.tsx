/**
 * One recording as a row.
 *
 * A row is ~58px against a card's ~360px, so almost everything the card says
 * has to go somewhere else. What survives is what these tests pin down: what
 * it is, when, on what channel, and the two or three facts that change what
 * you would do about it.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { RecordingRow } from "../components/RecordingRow";
import type { Recording } from "../api/tablo";

function rec(over: Partial<Recording> = {}): Recording {
  return {
    object_id: 1,
    identifier: 1,
    path: "/recordings/series/episodes/1",
    title: "Jeopardy!",
    subtitle: null,
    description: null,
    start: "2026-09-21T22:00:00Z",
    series_path: "/recordings/series/700",
    sport_path: null,
    kind: "episode",
    season_number: 42,
    episode_number: 6,
    orig_air_date: null,
    duration: 1875,
    recorded_seconds: null,
    slot_seconds: 1875,
    expected_seconds: 1875,
    recording_started: null,
    thumbnail: null,
    width: 1920,
    height: 1080,
    state: "finished",
    error: null,
    watched: false,
    position: 0,
    protected: false,
    channel: {
      identifier: "S1_008_01", call_sign: "KPAX", network: "CBS",
      number: "8.1", kind: "ota",
    },
    scan: "1080i",
    interlaced: true,
    cache_state: "absent",
    cache_progress: 0,
    pinned: false,
    paused: false,
    cached_seconds: 0,
    rate: { mbps: 0, realtime: 0 },
    has_preview: false,
    offline_only: false,
    genres: [],
    image_url: null,
    cover_frame: null,
    ...over,
  } as Recording;
}

function row(over: Partial<Recording> = {}, handlers: {
  onPlay?: () => void; onInfo?: () => void;
} = {}) {
  return render(
    <RecordingRow
      rec={rec(over)}
      onPlay={handlers.onPlay ?? (() => {})}
      onInfo={handlers.onInfo ?? (() => {})}
    />,
  );
}

describe("what a row says", () => {
  it("names the recording, its episode and where it came from", () => {
    row();

    expect(screen.getByText(/Jeopardy!/)).toBeInTheDocument();
    expect(screen.getByText(/S42 E6/)).toBeInTheDocument();
    expect(screen.getByText(/8\.1 CBS/)).toBeInTheDocument();
    expect(screen.getByText(/31m/)).toBeInTheDocument();
  });

  it("carries the episode name on the title line, not a line of its own", () => {
    row({ subtitle: "Temple of Tigers", title: "Wild Kratts" });

    // One line: a second line for the episode is a card's luxury.
    expect(screen.getByText(/Temple of Tigers/)).toBeInTheDocument();
  });

  it("says what exists rather than what was promised, while recording", () => {
    row({ state: "recording", recorded_seconds: 480, duration: 0,
          expected_seconds: 3600 });

    expect(screen.getByText(/8m of 1h 0m/)).toBeInTheDocument();
    expect(screen.getByText(/Recording/i)).toBeInTheDocument();
  });

  it("calls out a capture that barely happened", () => {
    // Four seconds of an hour is not a short recording, it is a broken one,
    // and the device reports no error for it.
    row({ duration: 240, slot_seconds: 3600 });

    expect(screen.getByText(/Incomplete/i)).toBeInTheDocument();
  });

  it("says when a copy is kept here", () => {
    row({ pinned: true, cache_state: "complete", cache_progress: 1 });

    expect(screen.getByText(/^Kept$/i)).toBeInTheDocument();
  });

  it("says how far a copy has got while it is still arriving", () => {
    row({ pinned: true, cache_state: "partial", cache_progress: 0.42 });

    expect(screen.getByText(/42%/)).toBeInTheDocument();
  });

  it("says when the Tablo no longer has it", () => {
    row({ offline_only: true, pinned: true, cache_state: "complete" });

    expect(screen.getByLabelText(/Kept here/i)).toBeInTheDocument();
  });

  it("marks something never opened as new", () => {
    row({ position: 0, watched: false });

    expect(screen.getByText(/^New$/)).toBeInTheDocument();
  });

  it("says nothing is new about something already watched", () => {
    row({ watched: true, position: 0 });

    expect(screen.queryByText(/^New$/)).toBeNull();
  });
});

describe("what a row does", () => {
  it("plays when the row itself is clicked", () => {
    const onPlay = vi.fn();
    row({}, { onPlay });

    fireEvent.click(screen.getByRole("button", { name: /Play Jeopardy!/ }));

    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("opens the sheet from the one control that is not play", () => {
    const onPlay = vi.fn();
    const onInfo = vi.fn();
    row({}, { onPlay, onInfo });

    fireEvent.click(screen.getByRole("button", { name: /Information about/ }));

    expect(onInfo).toHaveBeenCalledTimes(1);
    // The sheet holds delete, keep and series — the row must not also play.
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("refuses to play what the device reported an error for", () => {
    row({ error: "tuner_conflict" });

    expect(screen.getByRole("button", { name: /Play Jeopardy!/ })).toBeDisabled();
  });
});

describe("how far in the viewer is", () => {
  it("draws the resume point on the row's own edge", () => {
    const { container } = row({ position: 937 });

    const rail = container.querySelector("[data-resume-rail] > *") as HTMLElement;
    expect(rail).toBeTruthy();
    expect(parseFloat(rail.style.width)).toBeCloseTo(50, 0);
  });

  it("draws nothing for something never opened", () => {
    const { container } = row({ position: 0 });

    expect(container.querySelector("[data-resume-rail]")).toBeNull();
  });

  it("draws nothing for the un-watch sentinel", () => {
    // `position: 1` is what clears watched without the device calling it New.
    const { container } = row({ position: 1 });

    expect(container.querySelector("[data-resume-rail]")).toBeNull();
  });
});
