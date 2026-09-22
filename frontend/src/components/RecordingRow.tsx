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
import {
  CheckCircle2, CloudOff, Download, Eye, EyeOff, FileDown, Lock, LockOpen,
  Play, Trash2,
} from "lucide-react";

import { downloadUrl, type Recording } from "../api/tablo";
import { formatDuration } from "../lib/format";
import {
  cardArt, coverageOf, isIncomplete, isPlayable, isRecording, resumeFor,
} from "../lib/recording";
import { RecordingPill } from "./RecordingPill";

/**
 * One control in the row's cluster.
 *
 * Round and 32px like the card's, but flat until hovered: four filled discs
 * per row, forty rows down a page, is a column of buttons rather than a
 * library.
 */
const ACTION = "shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
  + " transition disabled:opacity-30 disabled:pointer-events-none"
  + " focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

interface Props {
  rec: Recording;
  /** The picture's click. Resumes, as a card's artwork does. */
  onPlay: () => void;
  /** The rest of the row, and the ⓘ: the sheet holding everything else. */
  onInfo: () => void;
  /** Keep an offline copy, or stop keeping one. */
  onKeep: (on: boolean) => void;
  /** Drop the transcoded copy, leaving the recording on the Tablo. */
  onDeleteCache: () => void;
  /** Mark watched, or put it back to unwatched. */
  onWatched: (on: boolean) => void;
  /** Protect from deletion, or let it be deleted again. */
  onProtect: (on: boolean) => void;
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

export function RecordingRow({
  rec, onPlay, onInfo, onKeep, onDeleteCache, onWatched, onProtect,
}: Props) {
  const title = rec.title || "Untitled Recording";
  const live = isRecording(rec);
  const playable = isPlayable(rec);
  // Caching copies the whole thing, so unlike playback this really does need a
  // finished recording. An offline copy is keepable by definition: it is one.
  const keepable = rec.offline_only || (!live && !rec.error);
  const cached = rec.cache_state !== "absent";
  const whole = rec.cache_state === "complete";
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
      {/* Two targets, and the picture is the smaller and the more specific:
          the frame plays, and everything else about the row opens the sheet.
          A whole row that played left no way to reach delete, keep or the
          series without aiming at one 32px control. */}
      <button
        onClick={onPlay}
        disabled={!playable}
        aria-label={`Play ${title}`}
        // `group/art`, not the row's `group`: the mark belongs to the picture,
        // and one on every row the pointer crosses is a page of triangles.
        className="group/art shrink-0 py-2 rounded-lg focus:outline-none
                   focus-visible:ring-2 focus-visible:ring-accent
                   disabled:cursor-not-allowed disabled:opacity-60"
      >
        {/* The card's own artwork, at a sixteenth of the area: the airing's
            picture, else the series cover, else a frame the viewer chose.
            `object-fill` for the card's reason — a frame from an SD recording
            is anamorphic, and cropping it to fit squeezes it further. */}
        <span className="relative block w-16 h-9 rounded-md bg-surface-sunken
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

          {/* The picture is the play button, and hovering the picture — not
              the row — is what says so.

              One mark, not the card's three chips: a card has room to ask
              whether you mean the live edge, where you left off, or the
              beginning, and a row does not. It resumes — which for something
              never opened is the beginning anyway — and the sheet is where the
              other two answers live.

              Decorative: the button around it is already named "Play <title>",
              so a second accessible name here would announce one click twice. */}
          {playable && (
            <span
              data-play-mark
              aria-hidden
              className="absolute inset-0 flex items-center justify-center bg-scrim-soft
                         opacity-0 group-hover/art:opacity-100 group-focus-visible/art:opacity-100
                         transition-opacity"
            >
              <span className="flex items-center justify-center w-6 h-6 rounded-full
                               accent-gradient shadow-lg">
                <Play className="w-3 h-3 text-brand-fg ml-px" fill="currentColor" aria-hidden />
              </span>
            </span>
          )}
        </span>

      </button>

      {/* Everything that is not the picture opens the sheet: what this is,
          when it was on, how far in you are — the questions the sheet answers
          — and from there the series behind it. Named "Read about" rather
          than "Information about" so it and the ⓘ button, which do the same
          thing, are still two distinguishable names to anyone listening. */}
      <button
        onClick={onInfo}
        aria-label={`Read about ${title}`}
        className="min-w-0 flex-1 flex flex-col gap-0.5 py-2 text-left rounded-lg
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
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
                {/* "Cached" is the word the card uses for this exact badge,
                    and one thing with two names is two things to anyone
                    reading the page. */}
                {rec.cache_state === "complete"
                  ? "Cached"
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
            {/* No lock chip here any more: the protect TOGGLE at the end of
                the row already draws the state it is in, and one recording
                wearing two locks is two things to read. */}
          </span>

          <span className={`truncate text-[11px] tabular-nums
                            ${dim ? "text-fg-faint" : "text-fg-muted"}`}>
            {facts}
          </span>
      </button>

      {/* The card's own controls, at the end of the row and in the card's own
          order: save the file, drop the copy, keep it — then information, on
          the outside edge where the row itself ends. Information is the one
          that does nothing irreversible, and the one the whole row already
          does, so it is the safe thing under a hand that overshoots.

          Save and delete appear only when there is something to save or drop:
          most of a library has nothing cached, and those rows carry the two
          controls that do apply — keep, then information. The cluster is
          right-aligned, so the buttons that are there still line up down the
          page whatever else a row has. */}
      <span data-row-actions className="shrink-0 flex items-center gap-1 pl-1">
        {/* Watched and protect lead the cluster: they are the two that apply
            to every recording whatever is on disk, where the three after them
            need something cached. Each draws the STATE it is in — an open eye
            has been watched, a closed lock is protected — with the act in the
            name and the tooltip. Neither applies to a file still being
            written. */}
        <button
          onClick={() => onWatched(!rec.watched)}
          disabled={live}
          aria-pressed={rec.watched}
          aria-label={rec.watched ? `Mark ${title} unwatched` : `Mark ${title} watched`}
          title={rec.watched ? "Mark unwatched" : "Mark watched"}
          className={ACTION + " text-fg-faint hover:bg-fill hover:text-fg"}
        >
          {rec.watched
            ? <Eye className="w-4 h-4" aria-hidden />
            : <EyeOff className="w-4 h-4" aria-hidden />}
        </button>

        <button
          onClick={() => onProtect(!rec.protected)}
          disabled={live}
          aria-pressed={rec.protected}
          aria-label={rec.protected
            ? `Remove protection from ${title}`
            : `Protect ${title} from deletion`}
          title={rec.protected ? "Remove protection" : "Protect from deletion"}
          className={ACTION + (rec.protected
            ? " text-warning hover:bg-warning-soft"
            : " text-fg-faint hover:bg-fill hover:text-fg")}
        >
          {rec.protected
            ? <Lock className="w-4 h-4" aria-hidden />
            : <LockOpen className="w-4 h-4" aria-hidden />}
        </button>

        {/* A plain link, not a fetch: the browser owns the download, so a 7 GB
            file streams to disk instead of being buffered in a tab. Only once
            the whole copy exists — half a transcode is not a file. */}
        {whole && (
          <a
            href={downloadUrl(rec.object_id)}
            download
            aria-label={`Save ${title} as an MP4 file`}
            title="Save as a single MP4 file"
            className={ACTION + " text-fg-faint hover:bg-fill hover:text-fg"}
          >
            <FileDown className="w-4 h-4" aria-hidden />
          </a>
        )}

        {cached && (
          <button
            onClick={onDeleteCache}
            aria-label={`Delete cached video of ${title}`}
            title="Delete cached video"
            className={ACTION + " text-fg-faint hover:bg-danger-soft hover:text-danger"}
          >
            <Trash2 className="w-4 h-4" aria-hidden />
          </button>
        )}

        <button
          onClick={() => onKeep(!rec.pinned)}
          disabled={!keepable}
          aria-label={rec.pinned ? `Stop keeping ${title}` : `Keep ${title} offline`}
          title={rec.pinned ? "Kept offline — click to stop keeping" : "Keep offline"}
          className={ACTION + (rec.pinned
            ? " bg-success-soft text-success hover:bg-success-soft-strong"
            : " text-fg-faint hover:bg-fill hover:text-fg-secondary")}
        >
          {rec.pinned
            ? <CheckCircle2 className="w-4 h-4" aria-hidden />
            : <Download className="w-4 h-4" aria-hidden />}
        </button>

        {/* Last, on the row's outside edge. Lit by a hover anywhere on the
            row, because a click anywhere on the row is what it does: the
            button is the row's own click, named.

            The direct hover carries `!` so it wins outright. Both rules are
            the same specificity — `.group:hover .x` and `.x:hover` — which
            leaves the winner to whichever Tailwind emits last, and that is not
            something this component should depend on. */}
        <button
          onClick={onInfo}
          aria-label={`Information about ${title}`}
          title="Show information"
          className={ACTION + " text-fg-faint group-hover:bg-fill group-hover:text-fg"
            + " hover:!bg-accent hover:!text-accent-fg"}
        >
          {/* The Live card's mark at the Live card's proportions: the ring is
              the glyph, rather than a small thing floating in a big disc. */}
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9.6" />
            <path d="M12 11.1v5.6M12 7.5v.2" />
          </svg>
        </button>
      </span>

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
