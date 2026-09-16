import { describe, it, expect } from "vitest";

import { parseMediaPlaylist, playlistWindow, segmentAt } from "../lib/wasmlive/playlist";

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

  it("has nothing for a target past the live edge", () => {
    expect(segmentAt(pl, ORIGIN, 90)).toBeNull();
  });

  it("has nothing when the playlist is empty", () => {
    expect(segmentAt(parseMediaPlaylist("#EXTM3U\n"), ORIGIN, 10)).toBeNull();
  });
});
