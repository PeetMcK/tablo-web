/**
 * One recording as a row, for the Library's list layout.
 *
 * A card is ~360px tall and carries artwork, a description, a coverage strip
 * and nine controls, which is the right shape for deciding what to watch and
 * the wrong one for finding a recording you already have in mind. This is the
 * same recording in ~58px.
 *
 * Three rules decide what is here (see
 * docs/superpowers/specs/2026-09-21-library-list-view-design.md):
 *
 *   1. Density is the point. A fact that does not earn its line belongs in the
 *      sheet, which is one click away.
 *   2. The row plays. Clicking anywhere but the ⋮ resumes, which is what
 *      clicking a card's artwork already does.
 *   3. The ⋮ opens the sheet we already have. Delete, Keep, Series Information
 *      and the rest live there; the row duplicates none of them.
 *
 * Presentational on purpose: it is given a recording and two callbacks, and
 * knows nothing about fetching, grouping or filtering. That is what lets the
 * view render cards or rows from the same section list.
 */
import { CheckCircle2, CloudOff, Lock, MoreVertical } from "lucide-react";

import type { Recording } from "../api/tablo";
import { formatDuration } from "../lib/format";
import {
  cardArt, coverageOf, isIncomplete, isPlayable, isRecording, resumeFor,
} from "../lib/recording";
import { RecordingPill } from "./RecordingPill";

interface Props {
  rec: Recording;
  /** The row's own click. Resumes, as a card's artwork does. */
  onPlay: () => void;
  /** The ⋮, which opens the sheet holding everything else. */
  onInfo: () => void;
}

/** `8.1 CBS`, or whichever half the device gave us, or nothing. */
function channelLabel(rec: Recording): string | null {
  const ch = rec.channel;
  if (!ch) return null;
  return [ch.number, ch.network || ch.call_sign].filter(Boolean).join(" ") || null;
}

/** The clock time it started, in the viewer's locale. */
function startedAt(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * How long it runs — or, while recording, how much of it exists.
 *
 * The slot is a promise, not a length: showing `1h 0m` against something eight
 * minutes old invites exactly the wrong expectation of the scrubber, which is
 * why the card says the same thing this way.
 */
function lengthLabel(rec: Recording): string {
  if (isRecording(rec) && rec.recorded_seconds !== null) {
    return `${formatDuration(rec.recorded_seconds)} of `
      + `${formatDuration(rec.expected_seconds || rec.duration)}`;
  }
  return formatDuration(rec.duration);
}

export function RecordingRow({ rec, onPlay, onInfo }: Props) {
  const title = rec.title || "Untitled Recording";
  const live = isRecording(rec);
  // Inferred from how little of the slot exists, not reported: the device
  // called none of the three measured failures an error.
  const broken = !live && isIncomplete(coverageOf(rec));
  const at = resumeFor(rec);
  const isNew = rec.position === 0 && !rec.watched && !live;

  // The meta line, with absent facts left out rather than rendered empty.
  const facts = [
    rec.season_number != null && rec.episode_number != null
      ? `S${rec.season_number} E${rec.episode_number}` : null,
    channelLabel(rec),
    startedAt(rec.start),
    lengthLabel(rec),
    at > 0 ? `${formatDuration(at)} in` : null,
  ].filter(Boolean).join(" · ");

  // Watched rows dim rather than wear a badge: at this density the dimming
  // says it, and a badge would only cost width the title wants.
  const dim = rec.watched && !live;

  return (
    <div className="group relative flex items-center gap-3 px-2
                    border-b border-border-subtle last:border-b-0
                    hover:bg-fill-soft transition">
      <button
        onClick={onPlay}
        disabled={!isPlayable(rec)}
        aria-label={`Play ${title}`}
        className="flex flex-1 min-w-0 items-center gap-3 py-2 text-left
                   rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
                   disabled:cursor-not-allowed disabled:opacity-60"
      >
        {/* The card's own artwork, at a sixteenth of the area: the airing's
            picture, else the series cover, else a frame the viewer chose.
            `object-fill` for the card's reason — a frame from an SD recording
            is anamorphic, and cropping it to fit squeezes it further. */}
        <span className="relative shrink-0 w-16 h-9 rounded-md bg-surface-sunken
                         overflow-hidden flex items-center justify-center">
          {cardArt(rec) ? (
            <img
              src={cardArt(rec)!}
              alt=""
              loading="lazy"
              className={`absolute inset-0 w-full h-full object-fill
                          ${rec.watched ? "opacity-[0.55]" : ""}`}
              // A dead artwork link falls back to the frame we still have.
              // Compared as resolved URLs: `img.src` reads back absolute where
              // `rec.thumbnail` is a path, and comparing them directly never
              // matched — which reassigned the same address forever.
              onError={(e) => {
                const img = e.currentTarget;
                if (!rec.thumbnail) return;
                const fallback = new URL(rec.thumbnail, location.href).href;
                if (img.src !== fallback) img.src = fallback;
              }}
            />
          ) : (
            <span className="text-[8px] font-black italic uppercase text-fg-faint">
              Tablo
            </span>
          )}
        </span>

        <span className="min-w-0 flex-1 flex flex-col gap-0.5">
          <span className="flex items-center gap-2 min-w-0">
            <span className={`truncate text-sm font-semibold ${dim ? "text-fg-subtle" : "text-fg"}`}>
              {title}
              {rec.subtitle && (
                <span className={dim ? "text-fg-subtle" : "text-fg-secondary"}>
                  {" · "}{rec.subtitle}
                </span>
              )}
            </span>

            {/* The card's badge vocabulary, shrunk to the title line and in the
                card's own precedence: nothing a row can say matters as much as
                the fact that the file is still growing. */}
            {live ? (
              <RecordingPill className="shrink-0" />
            ) : broken ? (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-warning-solid text-[9px]
                               font-bold text-warning-fg uppercase tracking-wider"
                    title="Only a fraction of the scheduled programme was captured.">
                Incomplete
              </span>
            ) : rec.pinned ? (
              <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded
                               bg-success-solid text-[9px] font-bold text-success-fg
                               uppercase tracking-wider tabular-nums">
                <CheckCircle2 className="w-3 h-3" aria-hidden />
                {rec.cache_state === "complete"
                  ? "Kept"
                  : `${Math.round(rec.cache_progress * 100)}%`}
              </span>
            ) : rec.cache_state === "complete" ? (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-accent text-[9px]
                               font-bold text-accent-fg uppercase tracking-wider">
                Ready
              </span>
            ) : isNew ? (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-accent-soft text-[9px]
                               font-bold text-accent-strong uppercase tracking-wider">
                New
              </span>
            ) : null}

            {rec.offline_only && (
              <span className="shrink-0 flex items-center text-fg-muted"
                    title="Kept here — the Tablo no longer has this recording"
                    aria-label="Kept here — the Tablo no longer has this recording">
                <CloudOff className="w-3.5 h-3.5" aria-hidden />
              </span>
            )}
            {rec.protected && (
              <span className="shrink-0 flex items-center text-warning"
                    title="Protected from deletion"
                    aria-label="Protected from deletion">
                <Lock className="w-3.5 h-3.5" aria-hidden />
              </span>
            )}
          </span>

          <span className={`truncate text-[11px] tabular-nums
                            ${dim ? "text-fg-faint" : "text-fg-muted"}`}>
            {facts}
          </span>
        </span>
      </button>

      {/* Always visible, not revealed on hover: touch has no hover, and this is
          the only way from a row to delete, keep, or the series behind it. */}
      <button
        onClick={onInfo}
        aria-label={`Information about ${title}`}
        title="Show information"
        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center
                   text-fg-faint hover:bg-fill hover:text-fg transition
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <MoreVertical className="w-4 h-4" aria-hidden />
      </button>

      {/* How far in the viewer is, on the row's own bottom edge. Deliberately
          not the CoverageStrip: that is an interactive scrubber with a preview,
          and it needs room a row does not have. */}
      {at > 0 && rec.duration > 0 && (
        <span data-resume-rail className="absolute left-2 right-2 bottom-0 h-0.5" aria-hidden>
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${Math.min(100, (at / rec.duration) * 100)}%` }}
          />
        </span>
      )}
    </div>
  );
}
