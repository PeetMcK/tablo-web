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
      {/* The seam, shown only while the card is under the pointer: two targets
          look like one card until there is a reason to tell them apart. */}
      <span
        className="absolute inset-y-0 left-[88px] w-px bg-accent opacity-0
                   group-hover:opacity-30 transition-opacity pointer-events-none"
        aria-hidden
      />

      {/* Watch. Its visible content is a logo and a number, neither of which
          announces anything, hence the label — the same reason the guide's
          tile carries one. */}
      <button
        onClick={onPlay}
        aria-label={`Watch ${label(channel)}`}
        className="relative flex flex-col items-center gap-2 shrink-0 rounded-lg
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* The puck is centred on the plate, not on the column: centred on the
            column it lands between the plate and the channel number and covers
            the number, which is half of what the tile is for. */}
        <div className="relative w-16 h-12 flex items-center justify-center bg-recess-soft rounded-lg p-1.5 border border-border-subtle">
          <ChannelLogo src={channel.logo_url} callSign={channel.call_sign} className="w-8 h-8" />

          {/* The play affordance belongs over the half that plays. It used to
              cover the whole card, which is what made the card read as one
              target. */}
          <span className="absolute inset-0 flex items-center justify-center opacity-0
                           group-hover:opacity-100 transition-opacity pointer-events-none">
            <span className="accent-gradient w-9 h-9 rounded-full flex items-center justify-center
                             shadow-lg scale-90 group-hover:scale-100 transition-transform">
              {/* Centred on its own box: 7.5..17.5 puts the middle at 12.5,
                  half a unit right of the viewBox's 12, which is the optical
                  correction a right-pointing triangle wants and all it wants.
                  The old glyph ran 8..19 — centre 13.5 — and carried another
                  2px of transform, so it sat 3.5px right inside its puck. */}
              <svg className="w-4 h-4 text-brand-fg" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path d="M7.5 5 17.5 12 7.5 19 Z" />
              </svg>
            </span>
          </span>
        </div>
        <span className="text-[10px] font-black tracking-tighter text-fg-muted uppercase">
          {channel.major > 0 ? `${channel.major}.${channel.minor}` : "OTT"}
        </span>
      </button>

      {/* What is on. Opens the sheet, which is where the artwork and the rest
          of what the device knows about this programme lives. */}
      <button
        onClick={onInfo}
        aria-label={program ? `About ${program.title}` : `About ${label(channel)}`}
        className="relative flex-1 min-w-0 text-left rounded-lg
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

        {/* The counterpart to the play puck: a wash and a word, so the half
            that opens the sheet says so rather than looking inert. */}
        <span className="absolute inset-0 flex items-start justify-end p-1 rounded-lg
                         bg-accent-soft opacity-0 group-hover:opacity-100
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
