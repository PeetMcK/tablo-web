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
  onPlay?: () => void;
  onInfo?: () => void;
  onKeep?: (on: boolean) => void;
  onDeleteCache?: () => void;
} = {}) {
  return render(
    <RecordingRow
      rec={rec(over)}
      onPlay={handlers.onPlay ?? (() => {})}
      onInfo={handlers.onInfo ?? (() => {})}
      onKeep={handlers.onKeep ?? (() => {})}
      onDeleteCache={handlers.onDeleteCache ?? (() => {})}
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
  it("plays when the picture is clicked", () => {
    const onPlay = vi.fn();
    const onInfo = vi.fn();
    row({}, { onPlay, onInfo });

    fireEvent.click(screen.getByRole("button", { name: /Play Jeopardy!/ }));

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onInfo).not.toHaveBeenCalled();
  });

  it("opens the sheet when anything but the picture is clicked", () => {
    const onPlay = vi.fn();
    const onInfo = vi.fn();
    row({}, { onPlay, onInfo });

    fireEvent.click(screen.getByRole("button", { name: /Read about Jeopardy!/ }));

    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("carries the title and the facts on the sheet's own target", () => {
    // The two are one button, so reading the row and opening what it
    // describes are the same gesture.
    row({ subtitle: "Temple of Tigers", title: "Wild Kratts" });

    const sheet = screen.getByRole("button", { name: /Read about Wild Kratts/ });
    expect(sheet).toHaveTextContent(/Wild Kratts/);
    expect(sheet).toHaveTextContent(/Temple of Tigers/);
    expect(sheet).toHaveTextContent(/8\.1 CBS/);
  });

  it("refuses to play what the device reported an error for", () => {
    row({ error: "tuner_conflict" });

    expect(screen.getByRole("button", { name: /Play Jeopardy!/ })).toBeDisabled();
  });

  it("wears a play mark on the picture, so the frame reads as the button", () => {
    const { container } = row();

    // Decorative: the row's own button already says "Play Jeopardy!", and a
    // second accessible name for the same click is one thing announced twice.
    const mark = container.querySelector("[data-play-mark]")!;
    expect(mark).toBeTruthy();
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    // Hidden until the PICTURE is hovered, not the row: the frame is artwork
    // at rest, and a triangle lighting up on every row the pointer crosses is
    // a page of triangles.
    expect(mark.className).toMatch(/opacity-0/);
    expect(mark.className).toMatch(/group-hover\/art:opacity-100/);
    expect(mark.className).not.toMatch(/(?<!\/art)\bgroup-hover:opacity-100/);
  });

  it("offers one way in, not three", () => {
    // A card offers Live / Resume / From start because it has room to ask.
    // A row resumes, and the sheet is where the other answers live.
    row({ position: 937, state: "recording", recorded_seconds: 600 });

    expect(screen.queryByText(/From start/i)).toBeNull();
    expect(screen.queryByText(/^Resume/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Live$/i })).toBeNull();
  });

  it("puts no play mark on what cannot play", () => {
    const { container } = row({ error: "tuner_conflict" });

    expect(container.querySelector("[data-play-mark]")).toBeNull();
  });
});

/**
 * The four controls the card carries, at the end of the row.
 *
 * All four are always drawn, and disabled rather than absent when one does
 * not apply: a cluster that changes width from row to row leaves nothing to
 * aim down, and "nothing is cached here" is worth saying rather than hiding.
 */
describe("what a row can do to a recording", () => {
  const cluster = () =>
    [...document.querySelectorAll("[data-row-actions] > *")]
      .map(el => el.getAttribute("aria-label") ?? "");

  it("carries information, keep, delete and save, in that order", () => {
    row({ pinned: true, cache_state: "complete" });

    expect(cluster()).toEqual([
      expect.stringMatching(/Information about Jeopardy!/),
      expect.stringMatching(/Stop keeping Jeopardy!/),
      expect.stringMatching(/Delete cached video/),
      expect.stringMatching(/Save Jeopardy!/),
    ]);
  });

  it("opens the sheet from the information button", () => {
    const onInfo = vi.fn();
    row({}, { onInfo });

    fireEvent.click(screen.getByRole("button", { name: /Information about Jeopardy!/ }));

    expect(onInfo).toHaveBeenCalledTimes(1);
  });

  it("lights the information button when the row is hovered", () => {
    // Clicking anywhere on the row does what this button does, so the row's
    // hover has to point at it.
    row();

    const info = screen.getByRole("button", { name: /Information about Jeopardy!/ });
    expect(info.className).toMatch(/group-hover:bg-fill/);
    // And its own hover still wins over the row's.
    expect(info.className).toMatch(/hover:!bg-accent/);
  });

  it("keeps a copy offline", () => {
    const onKeep = vi.fn();
    row({}, { onKeep });

    fireEvent.click(screen.getByRole("button", { name: /Keep Jeopardy! offline/ }));

    expect(onKeep).toHaveBeenCalledWith(true);
  });

  it("offers to stop keeping one that is kept", () => {
    const onKeep = vi.fn();
    row({ pinned: true, cache_state: "complete" }, { onKeep });

    fireEvent.click(screen.getByRole("button", { name: /Stop keeping Jeopardy!/ }));

    expect(onKeep).toHaveBeenCalledWith(false);
  });

  it("will not keep something still being written", () => {
    // Caching copies the whole thing, and the whole thing does not exist yet.
    row({ state: "recording", recorded_seconds: 60 });

    expect(screen.getByRole("button", { name: /Keep Jeopardy! offline/ })).toBeDisabled();
  });

  it("deletes the cached video when there is one", () => {
    const onDeleteCache = vi.fn();
    row({ cache_state: "complete" }, { onDeleteCache });

    fireEvent.click(screen.getByRole("button", { name: /Delete cached video/ }));

    expect(onDeleteCache).toHaveBeenCalledTimes(1);
  });

  it("has nothing to delete when nothing is cached", () => {
    row({ cache_state: "absent" });

    expect(screen.getByRole("button", { name: /Delete cached video/ })).toBeDisabled();
  });

  it("saves the file once the whole copy exists", () => {
    row({ cache_state: "complete" });

    expect(screen.getByRole("link", { name: /Save Jeopardy!/ }))
      .toHaveAttribute("href", expect.stringContaining("/api/recordings/1/"));
  });

  it("offers no file to save while there is only part of one", () => {
    row({ cache_state: "partial", cache_progress: 0.4 });

    // A link to something nothing can serve is worse than a control that
    // says not yet.
    expect(screen.queryByRole("link", { name: /Save Jeopardy!/ })).toBeNull();
    expect(screen.getByLabelText(/Save Jeopardy!/))
      .toHaveAttribute("aria-disabled", "true");
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
