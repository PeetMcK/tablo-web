/**
 * The picture beside the title on the OS now-playing surface.
 *
 * Never empty: a missing or unloadable entry drops the whole card back to the
 * browser's generic icon, so a source with no picture of its own gets the
 * app's mark instead. The mark is a PNG rather than the favicon's SVG for the
 * same reason — the hub wants raster.
 */
export const APP_MARK_ARTWORK: readonly MediaImage[] = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
];

export function nowPlayingArtwork(art: string | null | undefined): MediaImage[] {
  if (!art) return [...APP_MARK_ARTWORK];
  // One entry listing several sizes: the hub picks a size and the route
  // serves what it has. The type is the proxy's, which returns JPEG.
  return [{ src: art, sizes: "96x96 192x192 256x256 512x512", type: "image/jpeg" }];
}
