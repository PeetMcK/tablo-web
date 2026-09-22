import { useMemo } from "react";
import type { GuideChannel, InProgressRecording } from "../api/tablo";
import { ChannelLogo } from "./ChannelLogo";
import { recordedSpan } from "../lib/recording";

interface Props {
  channel: GuideChannel;
  now: number;
  /**
   * This channel's listing has not arrived yet — as opposed to not existing.
   *
   * The guide streams in phases, so for a stretch of a cold load a card holds
   * a real channel and a null programme. That is the same shape as a channel
   * the guide has nothing for, and the card used to answer both with "No
   * Information" — stating as fact, for up to fifteen seconds, the one thing
   * it did not yet know. While this is true the card says nothing instead.
   */
  pending?: boolean;
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
                              recording = null, pending = false }: Props) {
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
      {/* The channel: its poster, its number, its station.

          Not a button any more. The tile used to be the play control, with the
          logo crossfading to a triangle on its own hover, and the copy beside
          it was a second control that dimmed on another. That machinery existed
          to keep two adjacent targets legible; with one scrim over the whole
          card there is nothing to disambiguate, and a poster that behaves like
          a button only invites a click that now belongs to the control resting
          on top of it. */}
      <div className="relative flex flex-col items-center gap-2 shrink-0">
        {/* `bg-logo-plate`, which is dark in both themes, and not a surface
            token that follows the theme. `ChannelLogo` draws its own dark
            plate - it has to, because station marks are broadcast artwork we
            do not control and are overwhelmingly white-on-transparent. A tile
            that went pale in light mode therefore framed that dark plate in a
            near-white one, and the pair read as a black box floating in a
            white box. One colour for both and they merge into one square,
            which is also what lets a poster and a mark sit in the same column
            without the row looking ragged. */}
        <div data-plate
             className={`relative w-16 h-12 flex items-center justify-center rounded-lg
                        overflow-hidden bg-logo-plate border border-border-subtle
                        ${posterId ? "" : "p-1.5"}`}>
          {posterId ? (
            /* The poster is 240x360 and the plate is wider than it is tall, so
               the crop has to lose something. `50% 0%` takes it off the bottom,
               which is where a poster puts least: the title and the faces sit
               in the upper two thirds on all eight checked.

               No padding around it, unlike the logo: a station's mark is
               artwork on its own ground and wants the inset, where a
               photograph should meet the plate's edge. */
            <img data-poster
                 src={`/api/channels/image/${posterId}`}
                 alt=""
                 loading="lazy"
                 className="w-full h-full object-cover"
                 style={{ objectPosition: "50% 0%" }} />
          ) : pending ? (
            /* A ring on the plate the mark will land on, at the size of the
               mark, so the tile neither resizes nor changes colour when the
               real artwork arrives. `border-2` rather than the page
               spinner's `border-4`: this one is 32px across, not 48. */
            <div data-pending-logo
                 className="w-8 h-8 rounded-full border-2 border-fill-strong
                            border-t-accent animate-spin" />
          ) : (
            <ChannelLogo src={channel.logo_url} callSign={channel.call_sign} className="w-8 h-8" />
          )}
        </div>
        {/* The channel's identity: its number, and whose station it is.
            
            This badge carried the scan type until the poster took the tile.
            What the poster displaced was the station's mark, and a column of
            28 is scanned by network far more often than by whether something
            is 1080i - so the network is what comes back here. The scan is
            still collected and still on the channel record; it is only no
            longer what this badge says. */}
        <span className="flex flex-col items-center gap-1">
          <span className="text-xs font-black tracking-tight text-fg-secondary uppercase
                           tabular-nums">
            {channel.major > 0 ? `${channel.major}.${channel.minor}` : "OTT"}
          </span>
          {channel.network && (
            <span data-station
                  className="px-1.5 py-px rounded-full bg-fill-soft border border-border-subtle
                             text-[9px] font-bold tracking-wide text-fg-muted uppercase">
              {channel.network}
            </span>
          )}
        </span>
      </div>

      {/* What is on, and everything the device knows about it. Plain content
          now - the controls are on the scrim. */}
      <div className="flex-1 min-w-0">
        {/* Skeletons rather than words while the listing is in flight, and
            they occupy the identical boxes: the title's own line height and
            the blurb's `h-10`, so the card does not reflow under the reader
            when the real text lands. A channel the guide truly has nothing
            for still says "No Information" — by then that is an answer rather
            than a guess. */}
        {pending ? (
          <div data-pending-title
               className="h-5 w-2/3 mb-0.5 rounded bg-fill-strong animate-pulse" />
        ) : (
          <p className="text-sm font-bold text-fg-secondary truncate mb-0.5">
            {program?.title || "No Information"}
          </p>
        )}
        {/* 20px lines in a 40px box is exactly two of them. It was
            `leading-relaxed h-8` - 19.5px lines in 32px - so the second line
            was sliced through the middle on every card that had one. */}
        {pending ? (
          <div data-pending-blurb className="h-10 flex flex-col justify-start gap-1.5">
            <div className="h-3 w-full rounded bg-fill animate-pulse" />
            <div className="h-3 w-4/5 rounded bg-fill animate-pulse" />
          </div>
        ) : (
          <p className="text-xs text-fg-muted line-clamp-2 leading-5 h-10">
            {program?.description || `Watching ${channel.display_name}`}
          </p>
        )}

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
      </div>

      {/* One scrim over the whole card, carrying both controls.

          `bg-scrim` is dark in both themes, like the plate underneath it. A
          light veil over a dark tile would invert the card's relationship to
          its own artwork - the same mistake the plate itself made until
          01006b5.

          `group-focus-within` is not decoration. Touch has no hover and
          neither does the keyboard: without it the controls are reachable by
          tab but the focus ring lands on something invisible. */}
      <div data-scrim
           className={`absolute inset-0 flex items-center justify-center gap-4
                       bg-scrim transition-opacity duration-150
                       motion-reduce:transition-none
                       ${infoOpen
                         ? "opacity-100"
                         : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
        <button
          onClick={onPlay}
          aria-label={`Watch ${label(channel)}`}
          className="accent-gradient w-14 h-14 rounded-full flex items-center justify-center
                     shadow-lg hover:scale-110 hover:brightness-110 active:scale-95
                     transition-transform duration-150 motion-reduce:transition-none
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
                     focus-visible:ring-offset-2 focus-visible:ring-offset-scrim"
        >
          {/* Centred on its own box: 7.5..17.5 puts the middle at 12.5, half a
              unit right of the viewBox's 12, which is the optical correction a
              right-pointing triangle wants and all it wants. */}
          <svg className="w-7 h-7 text-brand-fg" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M7.5 5 17.5 12 7.5 19 Z" />
          </svg>
        </button>
        <button
          onClick={onInfo}
          aria-label={program ? `About ${program.title}` : `About ${label(channel)}`}
          className="accent-gradient w-14 h-14 rounded-full flex items-center justify-center
                     shadow-lg hover:scale-110 hover:brightness-110 active:scale-95
                     transition-transform duration-150 motion-reduce:transition-none
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
                     focus-visible:ring-offset-2 focus-visible:ring-offset-scrim"
        >
          {/* Three quarters of the puck, so the ring is the mark rather than a
              small thing floating in a big disc. */}
          <svg className="w-8 h-8 text-brand-fg" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9.6" />
            <path d="M12 11.1v5.6M12 7.5v.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
