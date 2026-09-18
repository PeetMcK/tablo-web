/**
 * The show a recording belongs to: its cover, and every episode of it that was
 * recorded, in the best order the data supports.
 *
 * Reached two ways, and the difference is only in what it says. At the end of
 * a programme it comes up by itself — no autoplay and no countdown, because a
 * countdown decides for someone who has stopped paying attention, which is the
 * opposite of what the end of a programme is for. The rest of the time it is
 * summoned from the show's name in the player, as the quick way to the rest of
 * the same thing without watching to the end or going back to the Library.
 */

import { useQuery } from "@tanstack/react-query";
import { Check, Play, X } from "lucide-react";

import { api } from "../api/tablo";
import type { Recording } from "../api/tablo";
import { formatAired } from "../lib/format";
import { cardArt } from "../lib/recording";
import { siblingEpisodes } from "../lib/series";

/**
 * Why the card is up, which is the whole of what differs between the two.
 *
 * "ended" — the programme ran out. "browsing" — someone asked for it while it
 * is still playing, which means the picture underneath is paused behind the
 * card and waiting to be come back to.
 */
export type CardReason = "ended" | "browsing";

interface Props {
  /** The one being watched. Shown in place, marked, never hidden. */
  current: Recording;
  reason: CardReason;
  onPlay: (rec: Recording) => void;
  onClose: () => void;
}

/**
 * How an episode names itself in the list.
 *
 * Numbers where there are numbers, because "S2 · E7" places an episode in a run
 * at a glance and a date does not. Where there are none — sport, news — the
 * date it aired is the only thing that distinguishes six recordings of "NFL
 * Football" from each other, so it is what the row leads with.
 */
function episodeLabel(rec: Recording): string {
  if (rec.season_number !== null && rec.episode_number !== null) {
    return `S${rec.season_number} · E${rec.episode_number}`;
  }
  return formatAired(rec.orig_air_date ?? rec.start);
}

export function SeriesEndCard({ current, reason, onPlay, onClose }: Props) {
  const ended = reason === "ended";
  // The same key the Library holds, so this is usually already in hand: the
  // list is what carries `watched` for every row, and re-fetching it here is
  // also how the flag just written for the finished episode arrives.
  const { data } = useQuery({
    queryKey: ["recordings"],
    queryFn: () => api.recordings(),
    staleTime: 5 * 60_000,
  });

  // Artwork only, and the one thing here that costs a device round trip — a
  // recording carries no series object, just a path to one. Its absence is
  // ordinary rather than an error, so nothing waits on it.
  const { data: series } = useQuery({
    queryKey: ["recording-series", current.object_id],
    queryFn: () => api.recordingSeries(current.object_id),
    staleTime: 60 * 60_000,
    retry: false,
  });

  const episodes = siblingEpisodes(current, data?.recordings ?? []);

  /**
   * The picture this card leads with.
   *
   * The series cover first, which is the one made to be looked at large. Then
   * whatever the card in the Library is leading with, which is the same
   * question answered once already — the airing's own artwork, else a frame.
   *
   * Asking only the series record left sport with nothing at all: a game has
   * no series to carry a cover, and the six NFL recordings here have no airing
   * row left either, so this was a bare title over a list. The Library card
   * shows them perfectly well from their own frame, and so can this.
   */
  const cover = series?.cover_image != null
    ? `/api/channels/image/${series.cover_image}`
    : cardArt(current);

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center
                 overflow-y-auto bg-player-panel-strong backdrop-blur-sm"
      role="dialog"
      aria-label={ended ? "This recording has ended" : "The rest of this show"}
    >
      {/* Its own row rather than floating over the cover: the poster is the
          thing worth looking at, and a control sitting on it is the one piece
          of interface guaranteed to cover someone's face. */}
      <div className="w-full max-w-2xl flex items-center justify-between px-5 pt-5">
        <span className="text-player-fg-muted text-[11px] uppercase tracking-widest">
          {ended ? "Finished" : "Recorded"}
        </span>
        {/* The same corner in both, and a different way out of each: at the end
            there is nothing behind this to go back to, and mid-programme there
            is — the picture, where it was left. */}
        <button
          onClick={onClose}
          aria-label={ended ? "Back to Library" : "Keep watching"}
          className="w-8 h-8 rounded-full bg-fill-soft flex items-center justify-center
                     text-player-fg-muted hover:bg-fill hover:text-player-fg transition"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      <div className="w-full max-w-2xl flex flex-col items-center gap-5 px-5 pb-10 pt-4">
        {cover !== null && (
          // Capped in viewport height, not just in pixels: on a laptop in
          // fullscreen a poster at its natural size fills the screen and pushes
          // the list — the part that can actually be acted on — off the bottom.
          //
          // Held to 16:9 and filled rather than shown at its own size: a frame
          // from an SD recording is 4:3, and left to itself it would set the
          // hero's shape the way it once set the Library card's.
          <img
            src={cover}
            alt=""
            className="max-h-[34vh] w-full aspect-video object-fill rounded-xl shadow-lg"
          />
        )}

        <div className="text-center">
          <h2 className="text-player-fg text-xl font-semibold text-balance">
            {series?.title ?? current.title ?? "This recording"}
          </h2>
          {episodes.length > 0 && (
            <p className="text-player-fg-muted text-xs mt-1">
              {episodes.length} recorded
            </p>
          )}
        </div>

        {episodes.length === 0 ? (
          // A one-off, a movie, or the only recording of its show. Nothing to
          // list is not a failure and must not read as one — there is simply
          // nothing else of this to offer.
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg glass text-sm text-player-fg hover:bg-fill transition"
          >
            {ended ? "Back to Library" : "Keep watching"}
          </button>
        ) : (
          <ul className="w-full flex flex-col gap-1.5">
            {episodes.map((rec) => {
              const isCurrent = rec.object_id === current.object_id;
              // The one being watched is marked as itself rather than as
              // watched: "Watched" is a state the library has always shown, and
              // saying it here would leave the viewer hunting for which row
              // they were on among several that all say the same thing.
              const watched = rec.watched && !isCurrent;
              return (
                <li key={rec.object_id}>
                  <button
                    onClick={() => !isCurrent && onPlay(rec)}
                    disabled={isCurrent}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left
                      transition disabled:cursor-default
                      ${isCurrent
                        ? "bg-fill-soft"
                        : "bg-player-panel-soft hover:bg-fill"}`}
                  >
                    <span className="text-player-fg-muted text-[11px] tabular-nums
                                     w-20 shrink-0">
                      {episodeLabel(rec)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-player-fg text-sm truncate">
                        {rec.subtitle ?? rec.title ?? "Untitled"}
                      </span>
                      {isCurrent && (
                        <span className="block text-player-fg-muted text-[11px]">
                          {ended ? "Just watched" : "Now playing"}
                        </span>
                      )}
                    </span>
                    {watched && (
                      <span
                        className="flex items-center gap-1 text-player-fg-muted text-[11px]
                                   uppercase tracking-wider shrink-0"
                      >
                        <Check className="w-3 h-3" aria-hidden />
                        Watched
                      </span>
                    )}
                    {!isCurrent && (
                      <Play className="w-4 h-4 shrink-0 text-player-fg-muted" aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
