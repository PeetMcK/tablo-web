/**
 * The strip along the bottom of a Library card, and what you can do to it.
 *
 * It says three things at rest — what was captured, how much has been watched,
 * and where the booked slot ended — and answers a pointer with a fourth: the
 * frame at that point. Left click plays from there; right click makes that
 * frame the card's picture.
 *
 * Its own component because it holds hover state, and the card that draws it is
 * one row of a list: state inside the loop would need a hook per card.
 */

import { useRef, useState } from "react";

import { previewUrl } from "../api/tablo";
import type { Recording } from "../api/tablo";
import type { Fill, Span } from "../lib/recording";

/**
 * How tall the pointer's reach is, in pixels.
 *
 * The strip itself is 4px, which is under any sane minimum for a target — it
 * is drawn thin because it is mostly a thing to read. The band is invisible,
 * sits over the bottom of the picture, and is what actually takes the pointer.
 */
const REACH = 20;

interface Props {
  recording: Recording;
  span: Span;
  /** How much of the capture has been watched, or null for none. */
  watched: Fill | null;
  watchedAt: number;
  /** Colours the capture: still recording, or captured too little to be whole. */
  recording_now: boolean;
  broken: boolean;
  title: string;
  /** Seconds into the recording, from a click on the captured part. */
  onPlayAt: (seconds: number) => void;
  /** Same, from a right click: make this frame the card's picture. */
  onPickCover: (seconds: number) => void;
  /** Where in the recording a fraction across the strip falls, or null. */
  timeAt: (fraction: number) => number | null;
}

/** A position as `12:20`, or `1:02:20` past the hour. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function CoverageStrip({
  recording, span, watched, watchedAt, recording_now, broken, title,
  onPlayAt, onPickCover, timeAt,
}: Props) {
  const bandRef = useRef<HTMLDivElement>(null);
  /** Where the pointer is, as a fraction across the strip, or null. */
  const [at, setAt] = useState<number | null>(null);

  /** The fraction across the strip a pointer event landed at. */
  const fractionOf = (e: React.MouseEvent<HTMLDivElement>): number | null => {
    const rect = bandRef.current?.getBoundingClientRect();
    if (!rect?.width) return null;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const seconds = at === null ? null : timeAt(at);
  // Previews come from the device's own pack of frames, ten seconds apart and
  // stored beside the recording. Nothing has one until it has been played, so
  // the popup is offered only where there is something to show.
  const preview = seconds !== null && recording.has_preview;

  return (
    <div
      ref={bandRef}
      className="absolute inset-x-0 bottom-0 z-10"
      style={{ height: REACH }}
      onMouseMove={(e) => setAt(fractionOf(e))}
      onMouseLeave={() => setAt(null)}
      onClick={(e) => {
        // The card's picture is a full-bleed play button, and the strip sits
        // on top of it: without this, a click meant for a point in the
        // programme also starts it from wherever it was left.
        e.preventDefault();
        e.stopPropagation();
        const t = timeAt(fractionOf(e) ?? 0);
        if (t !== null) onPlayAt(t);
      }}
      onContextMenu={(e) => {
        const t = timeAt(fractionOf(e) ?? 0);
        if (t === null) return;
        e.preventDefault();
        onPickCover(t);
      }}
    >
      {/* Drawn at the bottom of the band, so the strip stays where it was and
          only the reach above it is new. */}
      <div className="absolute inset-x-0 bottom-0 h-1 bg-ink/60" title={title}>
        <div
          className={`h-full absolute inset-y-0 transition-[width,left] duration-1000 ease-linear
                      ${recording_now ? "bg-danger" : broken ? "bg-warning" : "bg-media-fg/40"}`}
          style={{ left: `${span.left}%`, width: `${span.width}%` }}
        />
        {/* How much of what exists has been watched, over the top of it.
            Measured against the capture rather than the slot: the resume
            position is an offset into the media, so on a recording that began
            late a quarter watched is a quarter of the grey, not of the strip. */}
        {watched && (
          <div
            className="absolute inset-y-0 bg-accent transition-[width] duration-500 ease-linear"
            style={{ left: `${watched.left}%`, width: `${watched.width}%` }}
            title={`Watched ${clock(watchedAt)}`}
          />
        )}
        {/* Where the booked slot ended, when something ran past it. Sports pad
            by half an hour on purpose, and without the mark the bar just looks
            full. */}
        {span.slotEnd !== null && (
          <div
            className="absolute inset-y-0 w-px bg-media-fg/70"
            style={{ left: `${span.slotEnd}%` }}
            aria-hidden
          />
        )}
        {/* Where the pointer is, over the part that has video in it. Drawn
            only there: the rest of the strip is scheduled slot the tuner never
            captured, and a playhead over it would promise something to play. */}
        {seconds !== null && at !== null && (
          <div
            className="absolute inset-y-0 w-px bg-media-fg"
            style={{ left: `${at * 100}%` }}
            aria-hidden
          />
        )}
      </div>

      {preview && at !== null && (
        // Above the strip and clear of the pointer, clamped inside the card so
        // the first and last few seconds do not hang off the edge.
        <div
          className="absolute bottom-3 pointer-events-none flex flex-col items-center gap-1"
          style={{
            left: `${Math.min(80, Math.max(20, at * 100))}%`,
            transform: "translateX(-50%)",
          }}
        >
          {/* Stretched to 16:9, not cropped to it, because these frames are
              anamorphic.

              The device sizes them to the *coded* picture — 320x180 from an HD
              source, 320x240 from an SD one — and broadcast SD here is a 16:9
              picture stored in a 4:3 grid with non-square pixels. `object-cover`
              treated the 4:3 ones as genuinely 4:3 and trimmed an eighth off
              the top and bottom, which on Carl the Collector is the characters'
              heads; showing them at 320x240 instead would make everything in
              them tall and thin, the fault `deinterlace.ts` sizes the player's
              canvas to avoid.

              Assumed rather than read: `video_details` reports the coded size
              and no sample aspect, so unlike the player — which learns it from
              the decoder — there is nothing here to ask. Genuinely 4:3
              material would come out wide. Every SD subchannel measured on this
              device is anamorphic 16:9. */}
          <img
            src={previewUrl(recording.object_id, seconds!)}
            alt=""
            className="w-40 aspect-video object-fill rounded-lg border border-border shadow-xl bg-surface-sunken"
          />
          <span className="px-1.5 py-0.5 rounded bg-ink/80 text-media-fg text-[10px] tabular-nums">
            {clock(seconds!)}
          </span>
        </div>
      )}
    </div>
  );
}
