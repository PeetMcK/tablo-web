import { createLucideIcon } from "lucide-react";

/**
 * The way back out of picture-in-picture.
 *
 * Lucide has no such icon: `PictureInPicture` is the way in — its arrow points
 * down-right, into the small window — and `PictureInPicture2` is the state
 * with no arrow at all. What was missing was the reverse of the first.
 *
 * So this is `PictureInPicture2`'s frame, verbatim, with `PictureInPicture`'s
 * arrow turned around and set inside it. The frame being shared is the point:
 * the pop-out button and this one are the same button in two states, and at
 * the 16px they are drawn at, "an arrow appeared" is a change the eye catches
 * where "the arrow turned around" is not — the two arrows would lie along the
 * same diagonal, differing only in which end carries the head.
 *
 * The arrow's own geometry is lucide's, scaled to the arm length that still
 * clears both the frame and the inner window at 16px: any longer and the head
 * crowds the frame's corner, any shorter and it reads as a tick rather than an
 * arrow. Half-units are on lucide's grid and survive the 24 → 16 scale.
 */
export const PictureInPictureExit = createLucideIcon("picture-in-picture-exit", [
  // The frame, from `PictureInPicture2`. Open at the bottom right, which is
  // where the inner window sits.
  ["path", { d: "M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4", key: "frame" }],
  ["rect", { width: "10", height: "7", x: "12", y: "13", rx: "2", key: "inner" }],
  // The arrow: head at 5.5,7.5, tail at 10,12, pointing up and out of the
  // inner window towards the frame.
  ["path", { d: "M10 7.5H5.5v4.5", key: "head" }],
  ["path", { d: "m10 12-4.5-4.5", key: "shaft" }],
]);
