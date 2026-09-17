import { useMemo } from "react";
import type { GuideChannel, InProgressRecording } from "../api/tablo";
import { ChannelLogo } from "./ChannelLogo";
import { recordedSpan } from "../lib/recording";

interface Props {
  channel: GuideChannel;
  now: number;
  /** Tune this channel. The tile's job. */
  onPlay: () => void;
  /** Open the programme's sheet. The content's job. */
  onInfo: () => void;
  /**
   * This card's sheet is the one currently open.
   *
   * Hover alone cannot carry that: opening the sheet moves the pointer off the
   * card, so the mark that was just clicked would blink out from under it and
   * the card behind the sheet would look untouched. While the sheet is up, its
   * card holds the same state the hover gave it.
   */
  infoOpen?: boolean;
  /**
   * The recording capturing this programme right now, if any.
   *
   * Absent is the ordinary case and leaves the card exactly as it was.
   */
  recording?: InProgressRecording | null;
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
export function ChannelCard({ channel, now, onPlay, onInfo, infoOpen = false,
                              recording = null }: Props) {
  const program = channel.current_program;

  // What has actually been captured, when something is recording this. The
  // ordinary bar below says how far through the programme the clock is, which
  // is a different question and the less useful one once a recording exists:
  // a tuner that joined late will never catch the opening, and only this says
  // so. Identical geometry to the Library card, from the same function.
  const captured = recording ? recordedSpan(recording) : null;

  // The series poster for what is on, if the guide could resolve one. Null for
  // roughly one airing in five — movies and sports are separate record types
  // with no series row, and some channels carry no EPG at all — and the tile
  // then shows the station's mark, which is what it showed before any of this.
  const posterId = program?.poster_image_id ?? null;

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
      {/* The channel, and what it will tell you about itself. Its visible
          content is a logo and a number, neither of which announces anything,
          hence the label.

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
        className="group/tile relative flex flex-col items-center gap-2 shrink-0 p-1.5 -m-1.5
                   rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* The plate is the play button. Not a puck laid over it and not a
            badge beside it — the logo crossfades to the triangle in place, so
            the thing you already aim at when you want this channel is the
            thing that plays it. Nothing moves, nothing is covered, and the
            square keeps its own shape throughout.

            `bg-logo-plate`, which is dark in both themes, and not a surface
            token that follows the theme. `ChannelLogo` draws its own dark
            plate — it has to, because station marks are broadcast artwork we
            do not control and are overwhelmingly white-on-transparent. A tile
            that went pale in light mode therefore framed that dark plate in a
            near-white one, and the pair read as a black box floating in a
            white box: the nested rounded shape the rest of this design spent
            its effort removing. One colour for both and they merge into the
            single square this comment describes.

            Keyed to `group/tile`, not to the card: the channel's mark is how
            you find the channel, and swapping it for a triangle the moment a
            cursor crosses anywhere on the card takes that away while you are
            still reading. It changes when the pointer is actually on the half
            that plays. */}
        <div data-plate
             className={`relative w-16 h-12 flex items-center justify-center rounded-lg
                        overflow-hidden bg-logo-plate border border-border-subtle
                        group-hover/tile:bg-accent-soft group-hover/tile:border-accent/30
                        group-active/tile:scale-95 transition-all duration-100
                        ${posterId ? "" : "p-1.5"}`}>
          {/* The logo blurs back rather than leaving. A station's mark is
              mostly colour — the red of BUSTED, the PBS blue — and that colour
              is how the row is scanned. Held at a hint behind the triangle, the
              channel is still identifiable while the plate is saying "play".

              The two halves end up opposite on purpose: this one keeps its
              colour and loses its edges, the copy on the right keeps its edges
              and loses its contrast. Each keeps what it is read by.

              On a wrapper, not through `ChannelLogo`: that puts a caller's
              class on the mark inside its own opaque plate, so treating the
              mark alone leaves the plate sitting there. */}
          <span className="w-full h-full transition-opacity duration-150
                           group-hover/tile:opacity-[0.35]">
            {posterId ? (
              /* The poster is 240×360 and the plate is wider than it is tall,
                 so a square-ish crop has to lose something. `50% 0%` takes it
                 off the bottom, which is where a poster puts least: the title
                 and the faces sit in the upper two thirds on all eight checked.

                 No padding around it, unlike the logo: a station's mark is
                 artwork on its own ground and wants the inset, where a poster
                 is a photograph and should meet the plate's edge. */
              <img data-poster
                   src={`/api/channels/image/${posterId}`}
                   alt=""
                   loading="lazy"
                   className="w-full h-full object-cover"
                   style={{ objectPosition: "50% 0%" }} />
            ) : (
              <ChannelLogo src={channel.logo_url} callSign={channel.call_sign} className="w-8 h-8" />
            )}
          </span>
          {/* Just the triangle. A second shape inside the square would be one
              rounded thing inside another, which is what the puck was. */}
          <svg className="absolute w-7 h-7 text-accent opacity-0 transition-opacity duration-150
                          group-hover/tile:opacity-100"
               fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            {/* Centred on its own box: 7.5..17.5 puts the middle at 12.5, half
                a unit right of the viewBox's 12, which is the optical
                correction a right-pointing triangle wants and all it wants. */}
            <path d="M7.5 5 17.5 12 7.5 19 Z" />
          </svg>
        </div>
        {/* The channel's identity: its number, and what it broadcasts in.
            Both stay put through the hover — nothing is laid over them any
            more, so there is no reason to take them away. */}
        <span className="flex flex-col items-center gap-1">
          <span className="text-xs font-black tracking-tight text-fg-secondary uppercase
                           tabular-nums">
            {channel.major > 0 ? `${channel.major}.${channel.minor}` : "OTT"}
          </span>
          {/* From the device, which is the only thing that knows: the cloud's
              channel record has no resolution in it at all. */}
          {channel.scan && (
            <span className="px-1.5 py-px rounded-full bg-fill-soft border border-border-subtle
                             text-[9px] font-bold tracking-wide text-fg-muted tabular-nums">
              {channel.scan}
            </span>
          )}
        </span>

      </button>

      {/* What is on, and everything the device knows about it. Click the words
          to read; click the channel beside them to watch. */}
      <button
        onClick={onInfo}
        aria-label={program ? `About ${program.title}` : `About ${label(channel)}`}
        className="group/body relative flex-1 min-w-0 text-left p-1.5 -m-1.5 rounded-xl
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {/* The copy dims rather than blurring. It keeps its edges — the words
            are still words while the mark sits over them — and because it
            fades toward the card's own ground it goes dark in dark and pale in
            light without a second colour being chosen for either. */}
        <span className={`block transition-opacity duration-150
                          ${infoOpen ? "opacity-[0.35]" : "group-hover:opacity-[0.35]"}`}>
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
            <div className="h-1 w-full bg-fill-soft rounded-full overflow-hidden relative">
              {captured ? (
                <div
                  className="bg-danger h-full absolute inset-y-0 transition-all duration-1000"
                  style={{ left: `${captured.left}%`, width: `${captured.width}%` }}
                />
              ) : (
                <div
                  className="accent-gradient-x h-full transition-all duration-1000"
                  style={{ width: `${progress}%` }}
                />
              )}
            </div>
            <div className="flex justify-between items-center mt-1 text-[10px] font-medium text-fg-muted uppercase tracking-widest">
              <span>{new Date(program.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              {/* Said here rather than over the artwork: this row already
                  describes the programme's timing, which is exactly what a
                  recording in flight changes the meaning of. */}
              {recording && (
                <span
                  className="flex items-center gap-1 text-danger"
                  aria-label={`Recording now: ${recording.title ?? "this programme"}`}
                >
                  <span className="relative flex w-1.5 h-1.5" aria-hidden>
                    <span className="motion-safe:animate-ping absolute inline-flex w-full h-full rounded-full bg-danger opacity-60" />
                    <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-danger" />
                  </span>
                  Recording
                </span>
              )}
              <span>{Math.round(program.duration / 60)}m</span>
            </div>
          </div>
        )}
        </span>

        {/* Centred on the box it describes, where the play mark used to be —
            the two halves now each carry one mark, in the place the eye
            already goes.

            The mark takes the pointer rather than refusing it, so that resting
            on the mark itself answers back: it grows and lifts, and presses in
            on click. Clicking it is still clicking the half — it is a child of
            that button, not a rival to it — so the whole area works exactly as
            before and the mark is simply the part that knows you are there. */}
        <span className={`absolute inset-0 flex items-center justify-center
                          group-active/body:scale-95 transition-all duration-150
                          ${infoOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
          <span className={`accent-gradient w-16 h-16 rounded-full flex items-center justify-center
                            shadow-lg hover:scale-110 hover:shadow-2xl hover:brightness-110
                            transition-all duration-150
                            ${infoOpen ? "scale-100" : "scale-90 group-hover:scale-100"}`}>
            {/* Three quarters of the puck, so the ring is the mark rather than
                a small thing floating in a big disc. The stroke thins as the
                glyph grows — it scales with the viewBox, and at this size the
                old weight drew a band instead of a line. */}
            <svg className="w-12 h-12 text-brand-fg" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="9.6" />
              <path d="M12 11.1v5.6M12 7.5v.2" />
            </svg>
          </span>
        </span>
      </button>
    </div>
  );
}
