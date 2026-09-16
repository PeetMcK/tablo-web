import { useMemo } from "react";
import type { GuideChannel } from "../api/tablo";
import { ChannelLogo } from "./ChannelLogo";

interface Props {
  channel: GuideChannel;
  now: number;
  /** Tune this channel. The tile's job. */
  onPlay: () => void;
  /** Open the programme's sheet. The content's job. */
  onInfo: () => void;
}

/** `7.1 PBS`, or the call sign alone where the device gave no number. */
function label(ch: GuideChannel): string {
  return ch.major > 0 ? `${ch.major}.${ch.minor} ${ch.call_sign}` : ch.call_sign;
}

/**
 * One channel on Live TV, as two targets.
 *
 * The tile watches, the programme opens the sheet. That is the split the guide
 * already uses — there the channel tile tunes and a programme cell opens the
 * sheet — and until now the whole Live TV card tuned, which left the artwork,
 * the episode title, the synopsis and the rating reachable from the guide and
 * nowhere else. A card is a channel and a programme sitting together; they are
 * two different things to want.
 */
export function ChannelCard({ channel, now, onPlay, onInfo }: Props) {
  const program = channel.current_program;

  // Calculate progress
  const progress = useMemo(() => {
    if (!program) return 0;
    const start = new Date(program.start).getTime();
    return Math.max(0, Math.min(100, ((now - start) / (program.duration * 1000)) * 100));
  }, [program, now]);

  return (
    <div
      className="group relative flex gap-4 p-4 rounded-xl overflow-hidden
                 bg-surface-raised border border-border
                 hover:border-accent/40 hover:channel-glow transition-all duration-200"
    >
      {/* Watch. Its visible content is a logo and a number, neither of which
          announces anything, hence the label — the same reason the guide's
          tile carries one.

          The hover wash is the whole left box, rounded like the card itself.
          A hairline between the halves said the same thing in a thinner voice
          and read as a divider in the artwork rather than a seam between two
          targets; two lit boxes say it without drawing anything.

          `p-1.5 -m-1.5` gives the wash room to stand off the plate without
          moving anything: the padding grows the painted box, the negative
          margin hands the same six pixels back to the layout. Six and not
          eight because the halves sit 16px apart — at eight the two washes
          meet in the middle and draw the very line this replaced. */}
      <button
        onClick={onPlay}
        aria-label={`Watch ${label(channel)}`}
        className="relative flex flex-col items-center gap-2 shrink-0 p-1.5 -m-1.5 rounded-xl
                   transition-colors group-hover:bg-accent-soft
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="w-16 h-12 flex items-center justify-center bg-recess-soft rounded-lg p-1.5 border border-border-subtle">
          <ChannelLogo src={channel.logo_url} callSign={channel.call_sign} className="w-8 h-8" />
        </div>
        <span className="text-[10px] font-black tracking-tighter text-fg-muted uppercase">
          {channel.major > 0 ? `${channel.major}.${channel.minor}` : "OTT"}
        </span>

        {/* Under the channel, not over it. The puck used to sit on the plate,
            covering the logo — the one thing on this half that says which
            channel this is, and the reason anyone aims here.

            It costs no layout to put it below: the tile column runs 71px
            inside a 97px box on every card, measured, because the programme
            side is always the taller of the two. A 24px puck lives in that
            slack, so nothing moves when it appears. Absolute, for the same
            reason — in the flow it would grow the column and shift the card
            on hover. */}
        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 opacity-0
                         group-hover:opacity-100 transition-opacity pointer-events-none">
          <span className="accent-gradient w-6 h-6 rounded-full flex items-center justify-center
                           shadow-lg scale-90 group-hover:scale-100 transition-transform">
            {/* Centred on its own box: 7.5..17.5 puts the middle at 12.5, half
                a unit right of the viewBox's 12, which is the optical
                correction a right-pointing triangle wants and all it wants.
                The old glyph ran 8..19 — centre 13.5 — and carried another 2px
                of transform, so it sat 3.5px right inside its puck. */}
            <svg className="w-3.5 h-3.5 text-brand-fg" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d="M7.5 5 17.5 12 7.5 19 Z" />
            </svg>
          </span>
        </span>
      </button>

      {/* What is on. Opens the sheet, which is where the artwork and the rest
          of what the device knows about this programme lives. */}
      <button
        onClick={onInfo}
        aria-label={program ? `About ${program.title}` : `About ${label(channel)}`}
        className="relative flex-1 min-w-0 text-left p-1.5 -m-1.5 rounded-xl
                   transition-colors group-hover:bg-accent-soft
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <p className="text-sm font-bold text-fg-secondary truncate mb-0.5">
          {program?.title || "No Information"}
        </p>
        {/* 20px lines in a 40px box is exactly two of them. It was
            `leading-relaxed h-8` — 19.5px lines in 32px — so the second line
            was sliced through the middle on every card that had one. */}
        <p className="text-xs text-fg-muted line-clamp-2 leading-5 h-10">
          {program?.description || `Watching ${channel.display_name}`}
        </p>

        {/* Progress bar */}
        {program && (
          <div className="mt-3">
            <div className="h-1 w-full bg-fill-soft rounded-full overflow-hidden">
              <div
                className="accent-gradient-x h-full transition-all duration-1000"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex justify-between mt-1 text-[10px] font-medium text-fg-muted uppercase tracking-widest">
              <span>{new Date(program.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              <span>{Math.round(program.duration / 60)}m</span>
            </div>
          </div>
        )}

        {/* The word that names what this half does. The wash under it is the
            button's own background now, so the chip is all that is left to
            place. */}
        <span className="absolute top-0 right-0 opacity-0 group-hover:opacity-100
                         transition-opacity pointer-events-none">
          <span className="px-2 py-0.5 rounded-full bg-surface-raised border border-border
                           text-[10px] font-bold tracking-widest uppercase text-accent">
            Info
          </span>
        </span>
      </button>
    </div>
  );
}
