import { describe, it, expect } from "vitest";

import {
  airingAt, clampSkip, LIVE_EDGE_MARGIN, mediaAt, planSkip, programWindow,
  readyRange, SEGMENT_SECONDS,
} from "../lib/playback";

describe("readyRange", () => {
  const cached: [number, number][] = [[0, 600], [1800, 2400]];

  it("is the whole timeline when everything is available", () => {
    expect(readyRange(120, { ranges: [], start: 0, end: 3600, whole: true }))
      .toEqual([0, 3600]);
  });

  it("is the cached island the playhead is standing in", () => {
    expect(readyRange(120, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([0, 600]);
    expect(readyRange(2000, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([1800, 2400]);
  });

  it("still belongs to the island whose frontier it is stalled on", () => {
    // A forward skip parks at the last playable instant, playback rolls the
    // remaining half-second, and the playhead comes to rest exactly on the
    // window boundary waiting for the encoder. It has not left the island it
    // was watching, and rewinding into it is the one move guaranteed warm.
    expect(readyRange(600, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([0, 600]);
  });

  it("is a point when the playhead sits in a gap", () => {
    expect(readyRange(1000, { ranges: cached, start: 0, end: 3600, whole: false }))
      .toEqual([1000, 1000]);
  });

  it("collapses to a point when nothing reports anything, pinning every skip", () => {
    // What the MPEG-2 path looked like from in here: no encoder report, because
    // nothing is transcoding, and no buffer, because the <video> element whose
    // buffer this reads is hidden while a canvas does the drawing. The run
    // collapses, the jump clamps to where it started, and the button is dead
    // while the picture plays on perfectly.
    //
    // The fix is at the call site - such a source passes `whole` - so this pins
    // why, not a behaviour change here.
    const pinned = readyRange(300, { ranges: [], buffered: [], start: 0, end: 2700, whole: false });

    expect(pinned).toEqual([300, 300]);
    expect(clampSkip(300, 30, pinned)).toBe(300);
    expect(clampSkip(300, -10, pinned)).toBe(300);

    // Told the truth about itself, the same playhead moves.
    const whole = readyRange(300, { ranges: [], buffered: [], start: 0, end: 2700, whole: true });
    expect(clampSkip(300, 30, whole)).toBe(330);
    expect(clampSkip(300, -10, whole)).toBe(290);
  });
});

describe("clampSkip", () => {
  it("jumps freely inside the ready range", () => {
    expect(clampSkip(100, 30, [0, 600])).toBe(130);
    expect(clampSkip(100, -10, [0, 600])).toBe(90);
  });

  it("stops just inside the frontier, not on it", () => {
    // The range is half-open: 600 is the first instant that does not exist yet,
    // so landing exactly there would stall on the window being encoded.
    expect(clampSkip(592, 30, [0, 600])).toBe(599.5);
    // Standing on the frontier already, forward genuinely stays put — it used
    // to answer 599.5, which is to say a tap on Forward stepped backwards. The
    // caller reads "no movement" and does not seek at all, so there is no
    // landing on 600 to stall on.
    expect(clampSkip(600, 30, [0, 600])).toBe(600);
  });

  it("will not rewind out of the ready range either", () => {
    expect(clampSkip(1805, -10, [1800, 2400])).toBe(1800);
  });

  it("holds still when the playhead is in a gap", () => {
    // readyRange collapses to a point there; a jump must not escape it.
    expect(clampSkip(1000, 30, [1000, 1000])).toBe(1000);
    expect(clampSkip(1000, -10, [1000, 1000])).toBe(1000);
  });
});

// An 8:00–9:00 PM news hour, tuned into at 8:15. The player has been running
// 900 media-seconds by then, so that instant anchors the two timelines.
const EIGHT_PM = new Date("2026-09-15T20:00:00").getTime();
const EIGHT_FIFTEEN = EIGHT_PM + 15 * 60_000;
const ANCHOR = { wallMs: EIGHT_FIFTEEN, media: 900 };
const NEWS_HOUR = { start: "2026-09-15T20:00:00", duration: 3600 };
const NEXT_SHOW = { start: "2026-09-15T21:00:00", duration: 1800 };

describe("mediaAt", () => {
  it("walks the media clock with the wall clock", () => {
    expect(mediaAt(EIGHT_FIFTEEN, ANCHOR)).toBe(900);
    expect(mediaAt(EIGHT_PM, ANCHOR)).toBe(0);
    expect(mediaAt(EIGHT_FIFTEEN + 60_000, ANCHOR)).toBe(960);
  });
});

describe("programWindow", () => {
  it("spans the airing, so a quarter in reads as a quarter in", () => {
    const window = programWindow(NEWS_HOUR, ANCHOR);
    expect(window).toEqual([0, 3600]);
    const [start, end] = window!;
    // Where the playhead sits at 8:15, as a fraction of the bar.
    expect((900 - start) / (end - start)).toBeCloseTo(0.25);
  });

  it("puts an airing already underway before the session's own zero", () => {
    // Tuning in at 8:45 of the same hour: 45 minutes of it predate the stream.
    const late = { wallMs: EIGHT_PM + 45 * 60_000, media: 0 };
    expect(programWindow(NEWS_HOUR, late)).toEqual([-2700, 900]);
  });

  it("knows nothing without an anchor or a usable airing", () => {
    expect(programWindow(NEWS_HOUR, null)).toBeNull();
    expect(programWindow(null, ANCHOR)).toBeNull();
    expect(programWindow({ start: null, duration: 3600 }, ANCHOR)).toBeNull();
    expect(programWindow({ start: "whenever", duration: 3600 }, ANCHOR)).toBeNull();
    expect(programWindow({ start: NEWS_HOUR.start, duration: 0 }, ANCHOR)).toBeNull();
    expect(programWindow({ start: NEWS_HOUR.start, duration: null }, ANCHOR)).toBeNull();
  });
});

describe("airingAt", () => {
  const schedule = [NEXT_SHOW, NEWS_HOUR];

  it("picks whatever covers the moment, unsorted input and all", () => {
    expect(airingAt(schedule, EIGHT_FIFTEEN)).toBe(NEWS_HOUR);
  });

  it("hands the boundary to the airing starting there", () => {
    // 9:00:00 belongs to the show beginning at 9:00, not to the one ending.
    expect(airingAt(schedule, EIGHT_PM + 3_600_000)).toBe(NEXT_SHOW);
  });

  it("covers nothing outside the schedule", () => {
    expect(airingAt(schedule, EIGHT_PM - 1)).toBeNull();
    expect(airingAt([], EIGHT_FIFTEEN)).toBeNull();
    expect(airingAt([{ start: "whenever", duration: 60 }], EIGHT_FIFTEEN)).toBeNull();
  });
});

describe("stalled on the encoder's frontier", () => {
  const cached: [number, number][] = [[0, 600]];
  const opts = { ranges: cached, start: 0, end: 3600, whole: false };

  it("rewinds out of the stall instead of holding still", () => {
    // Skipping forward near the frontier lands just inside it; half a second of
    // playback later the playhead is on the boundary, waiting for the next
    // 60s window to encode. A rewind from there must move.
    const parked = clampSkip(590, 30, readyRange(590, opts));
    expect(parked).toBe(599.5);
    expect(clampSkip(600, -10, readyRange(600, opts))).toBe(590);
  });

  it("does not jump forward into the window being encoded", () => {
    // Not past 600, and not backwards away from it either: the playhead is
    // already as far on as anything that exists, so forward holds still.
    expect(clampSkip(600, 30, readyRange(600, opts))).toBe(600);
  });
});

describe("playing ahead of what the cache report knows", () => {
  // The published playlist names every segment of the recording, so hls.js
  // keeps pulling 180s ahead and the backend transcodes each cold window on
  // demand. Playback sails past the cached island without stalling. Meanwhile
  // `cached_ranges` only grows a whole 60s window at a time and is polled every
  // 3s, so for most of a minute the report says the playhead is nowhere.
  const cached: [number, number][] = [[0, 600]];
  const buffered: [number, number][] = [[480, 790]];
  const opts = { ranges: cached, buffered, start: 0, end: 3600, whole: false };

  it("trusts the buffer, which is the only thing that knows", () => {
    expect(readyRange(605, opts)).toEqual([0, 790]);
  });

  it("skips both ways while the report still says nothing is here", () => {
    expect(clampSkip(605, -10, readyRange(605, opts))).toBe(595);
    expect(clampSkip(605, 30, readyRange(605, opts))).toBe(635);
  });

  it("holds still where neither the cache nor the buffer reaches", () => {
    expect(readyRange(2000, opts)).toEqual([2000, 2000]);
    expect(clampSkip(2000, -10, readyRange(2000, opts))).toBe(2000);
  });

  it("leaves live alone — its whole DVR window is served from disk", () => {
    // Narrowing live to what happens to be buffered would break the rewind
    // that already works there.
    expect(readyRange(605, { ...opts, whole: true })).toEqual([0, 3600]);
  });
});

describe("skipping forward on a live edge", () => {
  // A live encoder publishes one 6s segment every 6s, so the seekable end is a
  // frontier rather than an end: there is nothing past it yet, and there will
  // not be for another segment. Landing a half-second short of it buys a
  // half-second of video and then a wait.
  const edge: [number, number] = [0, 36];

  it("stops a segment's worth short of the frontier, not a hair", () => {
    const landed = clampSkip(21, 30, edge, LIVE_EDGE_MARGIN);
    expect(landed).toBe(26);
    // The cushion has to outlast the gap between segments, or the viewer is
    // watching the encoder work.
    expect(36 - landed).toBeGreaterThan(SEGMENT_SECONDS);
  });

  it("gives a repeat tap nowhere new to go", () => {
    // Which is what makes the caller's no-op guard fire instead of seeking to
    // the same spot again — thirteen times, in the log that prompted this.
    const first = clampSkip(21, 30, edge, LIVE_EDGE_MARGIN);
    expect(clampSkip(first, 30, edge, LIVE_EDGE_MARGIN)).toBe(first);
  });

  it("still rewinds freely from there", () => {
    expect(clampSkip(26, -10, edge, LIVE_EDGE_MARGIN)).toBe(16);
  });

  it("will not turn a forward tap into a rewind", () => {
    // Playback on live rides a few seconds behind the edge, so the playhead is
    // normally *inside* the cushion already. Clamping to `hi - margin` without
    // regard to direction sent it backwards: measured in the browser, Forward
    // moved the playhead from 139.92 to 134.18 against an edge of 144.18.
    expect(clampSkip(139.92, 30, [0, 144.18], LIVE_EDGE_MARGIN)).toBe(139.92);
    expect(clampSkip(35, 30, edge, LIVE_EDGE_MARGIN)).toBe(35);
  });

  it("will not turn a rewind into a jump forward", () => {
    // The same trap at the other end: standing before `lo`, a back-10 must not
    // be dragged up to it.
    expect(clampSkip(5, -10, [10, 36], LIVE_EDGE_MARGIN)).toBe(5);
  });

  it("leaves a finished recording able to reach its own ending", () => {
    // Nothing is being produced there: the last second is on disk like every
    // other, so the wide live cushion would only fence off the credits.
    expect(clampSkip(3500, 30, [0, 3600])).toBe(3530);
    expect(clampSkip(3590, 30, [0, 3600])).toBe(3599.5);
  });
});

describe("a skip never leaves what exists", () => {
  it("stops at the live edge even when the bar runs an hour past it", () => {
    // The bar spans 8:00–9:00; only 8:00–8:15 is on disk. Forward 30 from near
    // the live edge must stay on disk rather than seeking into unbroadcast
    // time, which would stall and raise the transcoding overlay.
    const range = readyRange(880, { ranges: [], start: 0, end: 900, whole: true });
    expect(clampSkip(880, 30, range)).toBe(899.5);
    expect(clampSkip(899.5, 30, range)).toBeLessThan(900);
  });
});

describe("queuing a flurry of skips", () => {
  // Live: a 900s window whose end is a frontier the encoder is still extending.
  const LIVE: [number, number] = [0, 900];
  const M = LIVE_EDGE_MARGIN;

  it("accumulates from the pending target, not the playhead", () => {
    // The whole point. `currentTime` has not moved yet when the second tap
    // lands - a seek is asynchronous - so chaining from it would make twenty
    // taps land thirty seconds away instead of ten minutes.
    let t: number | null = null;
    for (let i = 0; i < 20; i++) t = planSkip(t, 100, 30, LIVE, M);
    expect(t).toBe(700);
  });

  it("lets a burst reach the far end without passing it", () => {
    let t: number | null = null;
    for (let i = 0; i < 100; i++) t = planSkip(t, 100, 30, LIVE, M);
    // Stops a margin short of a frontier still being produced, and stays there
    // however many more taps arrive.
    expect(t).toBe(900 - M);
  });

  it("stops at zero going back, however hard it is pressed", () => {
    let t: number | null = null;
    for (let i = 0; i < 50; i++) t = planSkip(t, 100, -10, LIVE, M);
    expect(t).toBe(0);
  });

  it("turns around cleanly from a clamped edge", () => {
    // Forward into the clamp, then back: the return trip starts from where it
    // actually landed, not from the phantom position the taps asked for.
    let t: number | null = null;
    for (let i = 0; i < 100; i++) t = planSkip(t, 100, 30, LIVE, M);
    expect(t).toBe(890);
    t = planSkip(t, 100, -10, LIVE, M);
    expect(t).toBe(880);
  });

  it("reports no movement when already clamped", () => {
    // The caller uses this to skip a seek that would go nowhere - each of those
    // announces itself as a stall.
    const at = planSkip(null, 895, 30, LIVE, M);
    expect(planSkip(at, 895, 30, LIVE, M)).toBe(at);
  });

  it("starts from the playhead when nothing is pending", () => {
    expect(planSkip(null, 100, 30, LIVE, M)).toBe(130);
  });

  it("holds a settled end exactly, with no live margin", () => {
    // A finished recording's end is not a frontier, so a skip may land on it.
    const vod: [number, number] = [0, 600];
    let t: number | null = null;
    for (let i = 0; i < 40; i++) t = planSkip(t, 0, 30, vod);
    expect(t).toBeGreaterThan(599);
    expect(t).toBeLessThanOrEqual(600);
  });
});
