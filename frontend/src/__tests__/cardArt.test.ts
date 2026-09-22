import { describe, it, expect } from "vitest";

import { cardArt, recordedSpan, strippedTime } from "../lib/recording";
import type { Recording } from "../api/tablo";

/** A finished recording, with everything absent unless a test says otherwise. */
function rec(over: Partial<Recording> = {}): Recording {
  return {
    object_id: 1, identifier: 1, path: "/recordings/series/episodes/1",
    title: "Carl the Collector", subtitle: null, description: null,
    start: "2026-09-17T17:00:00Z",
    series_path: null, sport_path: null, season_number: null, episode_number: null,
    orig_air_date: null,
    duration: 1800, recorded_seconds: null, expected_seconds: null,
    recording_started: null, slot_seconds: 1800,
    thumbnail: "/api/recordings/1/thumbnail",
    image_url: null, cover_frame: null, has_preview: true,
    width: null, height: null, state: "finished", error: null, codec: "mpeg2", size: null,
    watched: false, position: 0, protected: false, cache_state: "absent", cache_progress: 0,
    pinned: false, offline_only: false, paused: false, cached_seconds: 0,
    rate: { mbps: 0, realtime: 0 }, channel: null, scan: null, interlaced: false,
    kind: "episode", genres: [],
    ...over,
  };
}

describe("what a card leads with", () => {
  it("prefers the show's artwork to a frame from the recording", () => {
    // The snapshot is a grab from the middle of a capture, which on plenty of
    // programmes is a caption card or somebody's back.
    expect(cardArt(rec({ image_url: "/api/channels/image/9345" })))
      .toBe("/api/channels/image/9345");
  });

  it("falls back to the frame where there is no artwork", () => {
    // Ordinary: sport whose airing has aged out of the guide, or anything
    // recorded before a guide sync.
    expect(cardArt(rec())).toBe("/api/recordings/1/thumbnail");
  });

  it("lets a frame the viewer chose outrank the artwork", () => {
    // Served through the thumbnail route, which knows about the override.
    expect(cardArt(rec({ image_url: "/api/channels/image/9345", cover_frame: 612 })))
      .toBe("/api/recordings/1/thumbnail?frame=612000");
  });

  it("puts the frame in the address, so a new choice is a new picture", () => {
    // The whole feature appeared to work once without this. Every choice
    // arrived at the same URL, the browser served what it had cached there -
    // for a card with no artwork behind it, a day-old snapshot - and nothing
    // changed on screen from the second pick onwards.
    const first = cardArt(rec({ cover_frame: 300 }));
    const second = cardArt(rec({ cover_frame: 900 }));
    expect(first).not.toBe(second);
  });

  it("rounds the frame to whole milliseconds", () => {
    // It is a cache key as much as a position; a float would spell the same
    // frame two ways.
    expect(cardArt(rec({ cover_frame: 612.5 })))
      .toBe("/api/recordings/1/thumbnail?frame=612500");
  });

  it("serves a chosen frame even where the device offered no snapshot", () => {
    // `thumbnail` is null when the device has no snapshot_image, but the route
    // serves a chosen frame from the preview pack regardless. Leaning on the
    // snapshot's existence dropped the card to its empty placeholder, with an
    // undo button floating over it offering to remove a picture never shown.
    expect(cardArt(rec({ cover_frame: 300, thumbnail: null, image_url: null })))
      .toBe("/api/recordings/1/thumbnail?frame=300000");
  });

  it("still has nothing to show when no frame was chosen and nothing exists", () => {
    expect(cardArt(rec({ thumbnail: null, image_url: null }))).toBeNull();
  });

  it("has nothing to show when there is neither", () => {
    expect(cardArt(rec({ thumbnail: null }))).toBeNull();
  });
});

describe("where a point on the strip falls in the recording", () => {
  /** An hour booked, an hour captured, punctual. The strip is the slot. */
  const whole = rec({ duration: 3600, slot_seconds: 3600, recorded_seconds: 3600 });
  const wholeSpan = recordedSpan({
    start: whole.start, duration: whole.slot_seconds,
    recording_started: null, recorded_seconds: 3600,
  })!;

  it("reads the middle of a punctual recording as its middle", () => {
    expect(strippedTime(whole, wholeSpan, 0.5)).toBeCloseTo(1800, 0);
  });

  it("reads the ends as the ends", () => {
    expect(strippedTime(whole, wholeSpan, 0)).toBeCloseTo(0, 0);
    expect(strippedTime(whole, wholeSpan, 1)).toBeCloseTo(3600, 0);
  });

  it("does not treat the left edge as zero on a late start", () => {
    // The strip is the scheduled slot, not a timeline. A tuner that began
    // twenty minutes into an hour leaves the first third of the strip as slot
    // with no video in it, and the recording's first frame sits a third along.
    const late = rec({
      duration: 2400, slot_seconds: 3600, recorded_seconds: 2400,
      recording_started: "2026-09-17T17:20:00Z",
    });
    const span = recordedSpan({
      start: late.start, duration: 3600,
      recording_started: late.recording_started, recorded_seconds: 2400,
    })!;

    // A third along is the first frame, not a third of the way in.
    expect(strippedTime(late, span, 1 / 3)).toBeCloseTo(0, 0);
    // And the middle of what exists is two thirds along the strip.
    expect(strippedTime(late, span, 2 / 3)).toBeCloseTo(1200, 0);
  });

  it("refuses the part of the strip with no video in it", () => {
    // Seeking there would land at zero and read as a bug. Measured on one
    // device, three recordings had captured four seconds, eight seconds and
    // 3.7 minutes of an hour - on those, nearly the whole strip is nothing.
    const late = rec({
      duration: 2400, slot_seconds: 3600, recorded_seconds: 2400,
      recording_started: "2026-09-17T17:20:00Z",
    });
    const span = recordedSpan({
      start: late.start, duration: 3600,
      recording_started: late.recording_started, recorded_seconds: 2400,
    })!;

    expect(strippedTime(late, span, 0)).toBeNull();
    expect(strippedTime(late, span, 0.1)).toBeNull();
  });

  it("has no answer for a recording with nothing in it", () => {
    const empty = rec({ duration: 0, recorded_seconds: 0 });
    expect(strippedTime(empty, { left: 0, width: 100 }, 0.5)).toBeNull();
  });
});
