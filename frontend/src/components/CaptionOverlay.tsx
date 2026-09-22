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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { placeInSafeArea, restingBottomPx, windowWidthPercent }
  from "../lib/captions/safeArea";
import type { PositionedCue } from "../lib/captions";
import {
  DEFAULT_CAPTION_PREFERENCES,
  type CaptionPlacement, type CaptionStandardChoice,
} from "../lib/captions/preferences";
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

/**
 * The cues to draw, from whichever decoder the viewer asked for.
 *
 * `auto` is the session's own latch — 708 where the stream speaks it, 608
 * where it does not — and is what happened before there was a choice. The
 * other two reach past the latch into both queues, which cost nothing to
 * keep: both decoders run on every stream regardless.
 */
function chosen(
  captions: CaptionSource, at: number, standard: CaptionStandardChoice,
): { cea608: PositionedCue[]; cea708: PositionedCue[] } {
  if (standard === "auto") return { cea608: [], cea708: captions.allAt(at) };
  const both = captions.compareAt(at);
  return { cea608: [], cea708: standard === "cea608" ? both.cea608 : both.cea708 };
}

/**
 * Fold what is on screen into what the chosen placement can draw.
 *
 * Broadcast placement keeps every window where it was put. A fixed position
 * has only one place to put anything, so several windows at once have to
 * become one block of text or they would sit on top of each other — which is
 * what a 608 screen has always been anyway. Read top to bottom and then left
 * to right, the way the broadcaster laid them out.
 */
function gatherForPlacement(
  cues: PositionedCue[], placement: CaptionPlacement,
): PositionedCue[] {
  if (placement !== "bottom" || cues.length < 2) return cues;

  const ordered = [...cues].sort((a, b) => {
    const ay = a.region?.yPercent ?? 100;
    const by = b.region?.yPercent ?? 100;
    if (ay !== by) return ay - by;
    return (a.region?.xPercent ?? 0) - (b.region?.xPercent ?? 0);
  });

  return [{
    ...ordered[0],
    text: ordered.map((cue) => cue.text).join("\n"),
    // The cue keeps its style but loses its window: there is nowhere for a
    // window to go once the viewer has said where captions belong.
    region: undefined,
  }];
}

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
  placement = DEFAULT_CAPTION_PREFERENCES.placement,
  standard = DEFAULT_CAPTION_PREFERENCES.standard,
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
   * `lib/captions/compareMode`. Overrides `standard` while it is on, since
   * the point of it is to show both.
   */
  compare?: boolean;
  /** Where captions go: the broadcaster's windows, or one fixed place. */
  placement?: CaptionPlacement;
  /** Which decoder's words to show. */
  standard?: CaptionStandardChoice;
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
          : { ...chosen(captions, at, standard), comparing: false }
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
  }, [source, enabled, currentTime, frames, compare, standard]);

  if (!enabled) return null;

  // Outside compare mode everything arrives in the 708 slot whichever
  // standard produced it — the choice has already been made upstream.
  const drawn: Array<{ cue: PositionedCue; badge?: string; tint?: string }> = shown.comparing
    ? [
        ...shown.cea708.map((cue) => ({ cue, badge: "708", tint: "ring-2 ring-sky-400" })),
        ...shown.cea608.map((cue) => ({ cue, badge: "608", tint: "ring-2 ring-amber-400" })),
      ]
    : gatherForPlacement(shown.cea708, placement).map((cue) => ({ cue }));

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
          floor={shown.comparing ? badge === "608" : placement === "bottom"}
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

  /** Where a positioned window goes; null for a screen drawn along the floor. */
  const region = cue.region;
  const placement = useMemo(
    () => (region && !floor
      ? placeInSafeArea(region.anchor, region.xPercent, region.yPercent)
      : null),
    [region, floor],
  );

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
    if (!raised || !placement) { setOverlap(0); return; }

    const measure = () => {
      const stage = element.offsetParent as HTMLElement | null;
      const stageRect = stage?.getBoundingClientRect();
      if (!stageRect?.height) return;

      // Where the box sits when nothing has moved it, worked out rather than
      // read off the page. Reading it off the page is wrong precisely while
      // it matters: the box has a transition, so a measurement taken during
      // one catches it partway, the lift computed from it is short, applying
      // that lift starts another transition, and the next measurement is
      // shorter still. Measured on ABC, a caption overlapping the controls by
      // forty-eight pixels climbed a hundred and fifty-two - the whole band,
      // by a different route than the rule this replaced.
      //
      // A transform does not change a box's size, so its height is the one
      // thing safe to measure mid-flight; the rest is the placement's own
      // arithmetic.
      const height = element.getBoundingClientRect().height;
      if (!height) return;
      const bottom = restingBottomPx(
        stageRect.top, stageRect.height, placement, height,
      );
      const next = liftToClearChrome(bottom, stageRect.bottom);
      setOverlap((was) => (Math.abs(was - next) > 1 ? next : was));
    };

    measure();
    // The box moves when the window does, and a caption that cleared the
    // controls at one size may not at another.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [raised, placement, cue.text, floor]);

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

  if (cue.region && !floor && placement) {
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
