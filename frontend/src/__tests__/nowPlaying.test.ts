import { describe, it, expect } from "vitest";

import { nowPlayingArtwork } from "../lib/nowPlaying";

describe("now-playing artwork", () => {
  it("offers the source's own picture when it has one", () => {
    const art = nowPlayingArtwork("/api/recordings/86182/art");
    expect(art).toHaveLength(1);
    expect(art[0].src).toBe("/api/recordings/86182/art");
    expect(art[0].type).toBe("image/jpeg");
    expect(art[0].sizes).toContain("512x512");
  });

  it("falls back to the app's raster mark, never to nothing", () => {
    // An empty artwork list, or an entry the hub cannot load, shows the
    // browser's generic icon; the SVG favicon is one it cannot load.
    for (const missing of [null, undefined, ""]) {
      const art = nowPlayingArtwork(missing);
      expect(art.length).toBeGreaterThan(0);
      for (const image of art) {
        expect(image.src).toMatch(/\.png$/);
        expect(image.type).toBe("image/png");
        expect(image.sizes).toMatch(/^\d+x\d+$/);
      }
    }
  });

  it("hands out a fresh fallback list each time", () => {
    // MediaMetadata takes ownership of what it is given; sharing one array
    // across sessions would let one player's mutation leak into the next.
    expect(nowPlayingArtwork(null)).not.toBe(nowPlayingArtwork(null));
  });
});
