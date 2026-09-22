/**
 * Captions, over the picture.
 *
 * Drawn in the DOM rather than into the canvas: text stays crisp at any window
 * size, a screen reader can read it, and a test can assert on it without a
 * GPU. The cost is that `captureStream` does not carry it, so captions do not
 * appear in the picture-in-picture pop-out — the pop-out is fed a mirror of
 * canvas pixels, and this is not one of them.
 *
 * It steps on animation frames rather than on the player's `timeupdate`, which
 * fires about four times a second — enough for a scrubber, visibly late for
 * roll-up captions that advance a word at a time.
 *
 * Two layouts, one component. A cue from CEA-608 has only the bottom rows to
 * work with and is drawn where captions have always been drawn; a cue from
 * CEA-708 carries the window the broadcaster placed, and is drawn there. A
 * moment can hold several of the latter at once — see `compare` below, and
 * `allAt` on the source.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { placeInSafeArea, windowWidthPercent } from "../lib/captions/safeArea";
import type { PositionedCue } from "../lib/captions";
import { DOCUMENT_FRAMES, startFrameLoop } from "../lib/playbackSurface";
import type { CaptionSource, FrameSource } from "../lib/playbackSurface";
import { CHROME_BOTTOM_BAND_PX, CHROME_CLEARANCE_PX, liftToClearChrome }
  from "../lib/playerChrome";

/** Where captions sit when nothing is in their way — a television's height. */
const RESTING_BOTTOM = "12%";

/** A little air between the caption box and the top of the transport band. */
const CLEARANCE_PX = CHROME_CLEARANCE_PX;

const boxClasses =
  "rounded px-3 py-1 text-white text-base sm:text-lg md:text-xl " +
  "font-medium leading-snug";

/** A window's justification, as the flex row that holds its plate. */
const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end" } as const;

/** What the frame loop last read, and what the render draws. */
interface Shown {
  /** The standard in play, or both when comparing. */
  cea608: PositionedCue[];
  cea708: PositionedCue[];
  comparing: boolean;
}

const EMPTY: Shown = { cea608: [], cea708: [], comparing: false };

/** The window's geometry in a few characters, for the compare badge. */
function describeRegion(cue: PositionedCue): string {
  const region = cue.region;
  if (!region) return " unplaced";
  return ` ${region.anchor}@${Math.round(region.xPercent)},${Math.round(region.yPercent)}`
    + ` ${region.columns}/${region.gridColumns}c ${region.align}`;
}

/** Cheap identity for "has anything on screen actually changed". */
function fingerprint(shown: Shown): string {
  const one = (cues: PositionedCue[]) =>
    cues.map((c) => `${c.startSeconds}|${c.text}`).join("~");
  return `${one(shown.cea608)}#${one(shown.cea708)}`;
}

export function CaptionOverlay({
  source, enabled, currentTime, raised = false, frames = DOCUMENT_FRAMES,
  compare = false,
}: {
  /**
   * The current surface's captions, read fresh each frame.
   *
   * A getter rather than the source itself, for the same reason `currentTime`
   * is one: the player replaces its surface — a rebuild, a fallback, a
   * different recording — and a source captured at mount is then answering
   * about a session the clock has left behind. Held as a value once, this
   * silently drew nothing at all: the cue lookup was correct and was being
   * asked of the wrong session.
   */
  source: () => CaptionSource | null;
  enabled: boolean;
  /** Media seconds, read fresh each frame rather than passed as a value. */
  currentTime: () => number;
  /**
   * Whether the player's chrome is showing, which the captions must clear.
   *
   * The transport sits in a band of fixed pixel height along the bottom, while
   * captions rest at a percentage of the stage — so how much of the two
   * overlap depends entirely on how tall the window is, and at most sizes they
   * already half clear each other. Lifting by the whole band therefore throws
   * the captions into the middle of the picture. What is wanted is the floor:
   * stay where you are, unless that is inside the band.
   */
  raised?: boolean;
  /** Injected so a test can step the loop by hand. */
  frames?: FrameSource;
  /**
   * Draw both standards at once, each labelled. Diagnostic; see
   * `lib/captions/compareMode`.
   */
  compare?: boolean;
}) {
  const [shown, setShown] = useState<Shown>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    const loop = startFrameLoop(() => {
      const captions = source();
      const at = currentTime();
      const next: Shown = captions
        ? compare
          ? { ...captions.compareAt(at), comparing: true }
          : { cea608: [], cea708: captions.allAt(at), comparing: false }
        : EMPTY;
      // Compared inside the setter rather than against a captured value: an
      // unchanged caption must not re-render sixty times a second, and the
      // effect does not re-run to give us a fresh one to compare against.
      setShown((was) => (fingerprint(was) === fingerprint(next) ? was : next));
      return true;
    }, frames);
    // Cleared here rather than at the top of the next run: nothing renders
    // while `enabled` is false anyway, and what this is really preventing is
    // the stale caption flashing back when captions are turned on again - or
    // when the source changes underneath them.
    return () => { loop.stop(); setShown(EMPTY); };
  }, [source, enabled, currentTime, frames, compare]);

  if (!enabled) return null;

  // Outside compare mode everything arrives in the 708 slot whichever
  // standard produced it — the session has already chosen one.
  const drawn: Array<{ cue: PositionedCue; badge?: string; tint?: string }> = shown.comparing
    ? [
        ...shown.cea708.map((cue) => ({ cue, badge: "708", tint: "ring-2 ring-sky-400" })),
        ...shown.cea608.map((cue) => ({ cue, badge: "608", tint: "ring-2 ring-amber-400" })),
      ]
    : shown.cea708.map((cue) => ({ cue }));

  const visible = drawn.filter((d) => d.cue.text);
  if (!visible.length) return null;

  return (
    <>
      {visible.map(({ cue, badge, tint }, index) => (
        <Window
          key={`${badge ?? ""}${cue.startSeconds}:${index}`}
          cue={cue}
          badge={badge}
          tint={tint}
          raised={raised}
          /* Both standards now carry a position, and when they agree - which
             is the point - their boxes land on top of each other and neither
             can be read. So while comparing, 608 is pinned to the floor and
             708 keeps its window. Placement is still comparable, through the
             geometry each box carries in the DOM; what the floor buys is two
             legible boxes instead of one illegible one. */
          floor={shown.comparing && badge === "608"}
        />
      ))}
    </>
  );
}

function Window({
  cue, raised, badge, tint, floor,
}: {
  cue: PositionedCue;
  raised: boolean;
  badge?: string;
  tint?: string;
  floor: boolean;
}) {
  /*
   * Colour, under a readability floor.
   *
   * A window the broadcaster marks transparent is drawn on the overlay's own
   * background instead. Captions are tuned for a living-room television and
   * are routinely unreadable over a bright browser page, and an unreadable
   * caption is worse than a plainly-styled one.
   */
  const style = cue.style;
  const background = style?.background && style.background !== "transparent"
    ? style.background
    : undefined;
  const textStyle: React.CSSProperties = {
    color: style?.foreground || undefined,
    fontStyle: style?.italic ? "italic" : undefined,
    textDecoration: style?.underline ? "underline" : undefined,
  };

  // Inside a window the text follows the broadcaster's justification; an
  // unpositioned 608 screen is centred, as captions have always been.
  const align = cue.region && !floor ? cue.region.align : "center";

  /**
   * How far the box actually intrudes into the transport band, in pixels.
   *
   * Measured rather than guessed. This used to lift any window anchored below
   * three quarters of the frame, by the whole height of the band - a rule
   * that knows the window's anchor but not where the box ends up, and so
   * threw captions a hundred and fifty pixels up the picture to clear a bar
   * they were already well above. A box either overlaps the controls or it
   * does not, and when it does the amount it overlaps by is exactly how far
   * it needs to move.
   */
  const boxRef = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState(0);

  useLayoutEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    if (!raised) { setOverlap(0); return; }

    const measure = () => {
      const stage = element.offsetParent as HTMLElement | null;
      const stageRect = stage?.getBoundingClientRect();
      if (!stageRect?.height) return;

      const rect = element.getBoundingClientRect();
      // Back out the lift already applied, or each measurement would be of
      // the box in its lifted position and the two would chase each other.
      const next = liftToClearChrome(rect.bottom + overlap, stageRect.bottom);
      setOverlap((was) => (Math.abs(was - next) > 1 ? next : was));
    };

    measure();
    // The box moves when the window does, and a caption that cleared the
    // controls at one size may not at another.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [raised, overlap, cue.text, cue.region, floor]);

  const box = (
    <div
      className={`${boxClasses} ${background ? "" : "bg-black/75"} ${tint ?? ""} relative
                  ${cue.region && !floor ? "max-w-full" : "max-w-[80%]"}`}
      style={{ ...textStyle, backgroundColor: background, textAlign: align }}
    >
      {badge ? (
        <span
          className="absolute -top-4 left-0 whitespace-nowrap rounded bg-white
                     px-1 text-[10px] font-bold text-black"
          data-caption-badge={badge}
        >
          {/* The geometry, on the picture. Comparing placement means reading
              four numbers, and a diagnostic that needs the console open to
              answer its own question is half a diagnostic. */}
          {badge}{describeRegion(cue)}
        </span>
      ) : null}
      {cue.text.split("\n").map((row, i) => (
        <p key={i}>{row}</p>
      ))}
    </div>
  );

  if (cue.region && !floor) {
    const placement = placeInSafeArea(
      cue.region.anchor, cue.region.xPercent, cue.region.yPercent,
    );
    // The window's own width, in the broadcaster's cells. Without it the box
    // shrinks to its text and both the shape and the anchoring go wrong.
    const width = `${windowWidthPercent(cue.region.columns, cue.region.gridColumns)}%`;
    const lift = overlap > 0 ? ` translateY(-${overlap}px)` : "";

    return (
      <div
        ref={boxRef}
        className="absolute flex pointer-events-none
                   transition-transform duration-300"
        style={{
          left: placement.left,
          top: placement.top,
          width,
          justifyContent: JUSTIFY[cue.region.align],
          transform: `${placement.transform}${lift}`,
        }}
        data-raised={overlap > 0 ? "true" : "false"}
        data-positioned="true"
        data-caption-standard={badge}
        aria-live="polite"
      >
        {box}
      </div>
    );
  }

  return (
    <div
      className="absolute inset-x-0 flex justify-center pointer-events-none px-4
                 transition-[bottom] duration-300"
      style={{
        // `max` rather than a lift: on a short window the resting height sits
        // inside the transport band and the captions move up to its top edge;
        // on a tall one they are already above it and do not move at all. Both
        // are the same rule, and neither needs to know the window's height.
        bottom: floor
          ? `${CHROME_BOTTOM_BAND_PX + CLEARANCE_PX}px`
          : raised
            ? `max(${RESTING_BOTTOM}, ${CHROME_BOTTOM_BAND_PX + CLEARANCE_PX}px)`
            : RESTING_BOTTOM,
      }}
      /* The decision, not the pixels: `max()` is the presentation of it, and
         jsdom's CSS parser drops the value outright, so this is also what a
         test can hold on to. */
      data-raised={raised ? "true" : "false"}
      data-positioned="false"
      data-caption-standard={badge}
      aria-live="polite"
    >
      {box}
    </div>
  );
}
