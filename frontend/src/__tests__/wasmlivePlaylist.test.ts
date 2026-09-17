import { describe, it, expect } from "vitest";

import {
  parseMediaPlaylist, playlistWindow, segmentAt, startNearEdge,
} from "../lib/wasmlive/playlist";

// The session began at 20:00:00; the window now starts 30s into it.
const ORIGIN = Date.parse("2026-09-16T20:00:00Z");

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:30+00:00
#EXTINF:6.000,
00005.ts
#EXTINF:6.000,
00006.ts
#EXTINF:5.500,
00007.ts
`;

describe("parseMediaPlaylist", () => {
  it("reads the sequence, target and segments", () => {
    const pl = parseMediaPlaylist(PLAYLIST);
    expect(pl.mediaSequence).toBe(5);
    expect(pl.targetDuration).toBe(6);
    expect(pl.segments).toEqual([
      { uri: "00005.ts", duration: 6 },
      { uri: "00006.ts", duration: 6 },
      { uri: "00007.ts", duration: 5.5 },
    ]);
  });

  it("reads the date of the first segment it holds", () => {
    expect(parseMediaPlaylist(PLAYLIST).programDateTimeMs).toBe(
      Date.parse("2026-09-16T20:00:30Z"),
    );
  });

  it("survives a playlist with nothing in it", () => {
    const pl = parseMediaPlaylist("#EXTM3U\n");
    expect(pl.segments).toEqual([]);
    expect(pl.programDateTimeMs).toBeNull();
    expect(pl.mediaSequence).toBe(0);
  });

  it("ignores tags sitting between an EXTINF and its uri", () => {
    const pl = parseMediaPlaylist("#EXTM3U\n#EXTINF:6.0,\n#EXT-X-DISCONTINUITY\na.ts\n");
    expect(pl.segments).toEqual([{ uri: "a.ts", duration: 6 }]);
  });
});

describe("playlistWindow", () => {
  it("is media seconds since the session began", () => {
    expect(playlistWindow(parseMediaPlaylist(PLAYLIST), ORIGIN)).toEqual({ start: 30, end: 47.5 });
  });

  it("is empty when the playlist is", () => {
    expect(playlistWindow(parseMediaPlaylist("#EXTM3U\n"), ORIGIN)).toEqual({ start: 0, end: 0 });
  });
});

describe("a recording's playlist, which carries no date", () => {
  const VOD = parseMediaPlaylist(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:2.000,
00000.ts
#EXTINF:2.000,
00001.ts
#EXTINF:2.000,
00002.ts
#EXT-X-ENDLIST
`);

  it("begins at zero, because media time is elapsed time", () => {
    // A live ring dates its segments because its window slides out from under
    // a paused viewer. A recording does not move: position is simply seconds
    // from the start, which is what the scrubber already shows.
    expect(playlistWindow(VOD, ORIGIN)).toEqual({ start: 0, end: 6 });
  });

  it("finds the segment covering a position, so a seek lands where it was aimed", () => {
    // This returned an empty window for a dateless playlist, so every seek
    // looked past the end and clamped to the last segment. Measured on a 45
    // minute recording resumed at 42:58: it fed segment 2680 of 2680, a final
    // 0.2s fragment with too little in it for the demuxer to name a stream,
    // and the session died with "decode error".
    expect(segmentAt(VOD, ORIGIN, 0)?.sequence).toBe(0);
    expect(segmentAt(VOD, ORIGIN, 3)?.sequence).toBe(1);
    expect(segmentAt(VOD, ORIGIN, 5.9)?.sequence).toBe(2);
  });
});

describe("segmentAt", () => {
  const pl = parseMediaPlaylist(PLAYLIST);

  it("finds the segment covering a media instant", () => {
    expect(segmentAt(pl, ORIGIN, 30)).toEqual({ index: 0, startSeconds: 30, sequence: 5 });
    expect(segmentAt(pl, ORIGIN, 37)).toEqual({ index: 1, startSeconds: 36, sequence: 6 });
    expect(segmentAt(pl, ORIGIN, 47)).toEqual({ index: 2, startSeconds: 42, sequence: 7 });
  });

  it("clamps a target before the window to its first segment", () => {
    // The viewer rewound past what the ring still holds: give them the oldest
    // thing that exists rather than nothing at all.
    expect(segmentAt(pl, ORIGIN, 5)).toEqual({ index: 0, startSeconds: 30, sequence: 5 });
  });

  it("clamps a target at or past the live edge to its last segment", () => {
    // The mirror of the rewind case, and a real bug rather than tidiness.
    // This returned null, and the session read null as "start from the front
    // of the window" — so dragging the scrubber to the right-hand end of the
    // bar jumped the viewer up to an hour backwards. The player clamps
    // inclusively to a range end that is up to half a second stale while the
    // ring gains a segment every second or so, so about half of all drags to
    // the end asked for a time at or past it.
    expect(segmentAt(pl, ORIGIN, 90)).toEqual({ index: 2, startSeconds: 42, sequence: 7 });
    expect(segmentAt(pl, ORIGIN, 48)).toEqual({ index: 2, startSeconds: 42, sequence: 7 });
  });

  it("has nothing when the playlist is empty", () => {
    expect(segmentAt(parseMediaPlaylist("#EXTM3U\n"), ORIGIN, 10)).toBeNull();
  });
});

describe("startNearEdge", () => {
  const playlist = (durations: number[], mediaSequence = 0) => ({
    targetDuration: 2,
    mediaSequence,
    programDateTimeMs: null,
    segments: durations.map((duration, i) => ({ uri: `${i}.ts`, duration })),
  });

  it("counts back from the newest segment, not from the window's start", () => {
    // A primed ring holds the device's whole backlog, fetched in one go, so
    // its segments all carry nearly the same timestamp and forty seconds of
    // media look like a moment. Anything derived from those stamps puts the
    // live edge in the wrong place: measured at a 0:01-1:20 window that began
    // playback at 0:55, twenty-five seconds late, with every fresh session on
    // a channel replaying the same content — live TV behaving like a DVR.
    const at = startNearEdge(playlist(Array(30).fill(1.5)), 3);
    expect(at).not.toBeNull();
    expect(at!.index).toBe(28);
  });

  it("gives an absolute sequence, which survives the window sliding", () => {
    expect(startNearEdge(playlist(Array(10).fill(1.5), 100), 3)!.sequence).toBe(108);
  });

  it("never asks for more than the ring holds", () => {
    const at = startNearEdge(playlist([1.5, 1.5]), 3600);
    expect(at!.index).toBe(0);
    expect(at!.sequence).toBe(0);
  });

  it("takes the only segment there is", () => {
    expect(startNearEdge(playlist([1.5]), 3)!.index).toBe(0);
  });

  it("has nothing to offer for an empty playlist", () => {
    expect(startNearEdge(playlist([]), 3)).toBeNull();
  });
});
