import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ChevronRight, Circle, CircleSlash, Layers, Play,
  Loader2, SlidersHorizontal, Square, Trash2, X,
} from "lucide-react";
import { recordedSpan } from "../lib/recording";
import {
  recordingFor, recordingForSeries, useRecordingsInProgress,
} from "../lib/useRecordingsInProgress";
import { api } from "../api/tablo";
import { loadResume, resumeKey, saveResume } from "../lib/resume";
import { VideoPlayer } from "./VideoPlayer";
import type { AiringDetail, Recording, SeriesRule } from "../api/tablo";

interface Props {
  /** Channel identifier, as the grid holds it. */
  channel: string;
  /**
   * Airing start, as the grid holds it. Together these key `guide_airing`.
   *
   * Null for a channel the guide has no listing for at all — several on a real
   * device carry no EPG data. There is nothing to ask the device about then,
   * and the sheet stands in for the row: it names the channel, says the
   * listings are missing, and offers to watch it anyway.
   */
  start: string | null;
  /** How to name the channel when there is no airing to name it. */
  channelLabel?: string;
  /**
   * The exact image the opener already resolved for this recording, so the
   * sheet matches its card. A Library card resolves `cardArt(rec)` — a
   * viewer-picked cover, else the episode's own snapshot, else the series art —
   * and passing it here keeps the sheet from falling back to the series
   * `cover_url` and showing a different picture than the card. When set, it wins
   * over `detail.image_url`; unset (the guide), the sheet uses the airing's own.
   */
  posterOverride?: string | null;
  onClose: () => void;
  /**
   * The recording this sheet is about, when the opener knows which one.
   *
   * A Library card does; the guide does not, and falls back to whatever the
   * airing resolves to. It matters because one airing can hold two recordings
   * - a capture stopped and restarted leaves both - and the airing's own
   * answer is then the wrong one from the other card's point of view.
   */
  recordingId?: number | null;
  /**
   * Called with the recording's id once the Tablo has deleted it.
   *
   * The sheet cannot know what is listing it, and the Library must not wait
   * for its fifteen-second poll to drop a card for something that no longer
   * exists - so the sheet reports, and whoever opened it decides what to
   * re-read.
   */
  onDeleted?: (objectId: number) => void;
  /**
   * Called once the Tablo has actually deleted it.
   *
   * Separate from `onDeleted` because the two moments are not the same, and
   * treating them as one is a race: re-reading the library alongside the
   * delete reads it before the delete lands, which puts the row straight back.
   * Measured that way on a real device - the listing answered 515ms in, the
   * delete 597ms, and the card returned for the rest of the poll interval.
   */
  onDeleteConfirmed?: (objectId: number) => void;
  /**
   * Called when the Tablo refused, after `onDeleted` already said otherwise.
   *
   * The sheet is gone by then - it closed on the confirmation, along with the
   * card - so the only place left that can put things back and explain is
   * whoever opened it.
   */
  onDeleteFailed?: (objectId: number, message: string) => void;
  /**
   * Open this airing's series, when there is somewhere new to go.
   *
   * Given the guide series path, because that is all this sheet knows; the
   * caller turns it into whatever its own series panel needs.
   */
  onOpenSeries?: (guidePath: string, title: string) => void;
  /**
   * This sheet was opened from that series' own panel.
   *
   * The panel is directly behind it, so the way out is back rather than
   * onward - and offering to open what you just came from would loop.
   */
  backToSeries?: boolean;
  /**
   * Play the recording this sheet describes, resuming where it was left.
   *
   * Optional, and only the Library passes it: that view owns a player already
   * and keeps the playhead in its own URL. Everywhere else the sheet opens one
   * over itself, so closing playback lands back on the sheet.
   */
  onWatchRecording?: (objectId: number) => void;
  /** Tune to this airing's channel. Only reachable while it is on air. */
  onTune: () => void;
}

/**
 * Runtime as `1h 0m`, matching LibraryView's own rendering.
 *
 * Lowercase h/m deliberately: in a metadata row of uppercase-ish tokens,
 * `1H 0M` reads as units of something other than time.
 */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * The device's rating codes, written the way they are printed on screen.
 *
 * It sends `tvpg`, `tvy7`, `pg13` — lowercase and unpunctuated. Uppercasing
 * alone yields `TVPG`, which nobody recognises, so the family prefix is split
 * off explicitly. Anything unrecognised is uppercased and shown as-is rather
 * than hidden: an unfamiliar rating is still information.
 */
function formatRating(raw: string): string {
  const r = raw.trim().toLowerCase();
  const tv = /^tv(y7|y|g|pg|14|ma)$/.exec(r);
  if (tv) return `TV-${tv[1].toUpperCase()}`;
  const movie = /^(pg|nc)(\d+)$/.exec(r);
  if (movie) return `${movie[1].toUpperCase()}-${movie[2]}`;
  return r.toUpperCase();
}

const RULES: { value: SeriesRule; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "none", label: "None" },
];

/**
 * What a scheduled recording is owed to — the series rule, or this episode.
 *
 * The device does not say which, so it is inferred: a series set to record
 * anything is what put a scheduled episode there.
 */
function recordScope(d: AiringDetail): string {
  const rule = d.series?.schedule_rule;
  return rule === "all" || rule === "new"
    ? "Record: All Episodes"
    : "Record: This Episode Only";
}

/**
 * A recording's own description, with a live airing's answers laid over it.
 *
 * Which half supplies what is the whole point. The device keeps a recording's
 * title, description, artwork, genres and rating for as long as it keeps the
 * recording — years, for a protected one. The guide keeps listings for days and
 * holds no past ones at all, so anything read from it about a recording is
 * borrowed time.
 *
 * Only the fields behind controls cross over, and only because those controls
 * write through `(channel, start)` against the guide: without a listing there
 * is nothing for them to address, and with one they must reflect it. A
 * recording still on a tuner is the case that needs this — its Stop Recording
 * button is a write against the airing.
 */
function withAiringActions(
  rec: AiringDetail, air: AiringDetail | null,
): AiringDetail {
  if (air === null) return rec;
  return {
    ...rec,
    // The guide means "on air now" where the recording means "still on a
    // tuner". The button this gates offers to watch the channel live, so the
    // guide's is the one that answers it.
    airing_now: air.airing_now,
    schedulable: air.schedulable,
    scheduled: air.scheduled,
    past: air.past,
    schedule_state: air.schedule_state,
    skip_reason: air.skip_reason,
    series: air.series,
  };
}

/** `8.1`, or just the network when the device gave no channel number. */
function channelNumber(ch: AiringDetail["channel"]): string | null {
  return ch.major ? `${ch.major}.${ch.minor ?? 0}` : null;
}

/** `Wed, Sep 16 · 8:00 AM – 9:00 AM`, in the viewer's locale and zone. */
function whenLine(start: string, duration: number): string | null {
  const from = new Date(start);
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(from.getTime() + duration * 1000);
  const time = (d: Date) =>
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = from.toLocaleDateString([], {
    weekday: "short", month: "short", day: "numeric",
  });
  return `${day} · ${time(from)} – ${time(to)}`;
}

/**
 * Everything the device knows about one programme.
 *
 * This is what a guide cell now opens. Until it existed a cell tuned, which is
 * why the channel tile became a real button first — the tile is the tune
 * affordance now, and this is the information one.
 *
 * Every field can be null: four channels on a real device carry no EPG data at
 * all. The layout omits rather than empties, so a sheet with nothing but a
 * title and a channel still looks deliberate instead of broken.
 */
export function ShowInfo({
  channel, start, channelLabel, recordingId, posterOverride,
  onClose, onDeleted, onDeleteConfirmed, onDeleteFailed, onOpenSeries,
  backToSeries, onWatchRecording, onTune,
}: Props) {
  // Polled while the sheet is open, so what it says about a recording moves
  // rather than freezing at whatever it was when opened.
  const inProgress = useRecordingsInProgress(true);
  const [detail, setDetail] = useState<AiringDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  /**
   * A write that starts or stops a recording, held until it is confirmed.
   *
   * Both directions deserve the pause. Stopping keeps what was captured but
   * does not resume. Starting, on something already airing, begins at once and
   * captures only what is left — which is how three stub recordings of four and
   * eight seconds ended up in the library, from someone cycling the series
   * buttons to decide on a rule.
   */
  const [confirming, setConfirming] = useState<
    {
      label: string;
      detail: string;
      action: string;
      run: () => void;
      /** Dressed as what it is, and never the focused default. */
      destructive?: boolean;
    } | null
  >(null);
  // Whatever had focus when the sheet opened, so closing can hand it back.
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      const el = opener.current;
      if (el instanceof HTMLElement) el.focus();
    };
  }, []);

  useEffect(() => {
    // Nothing to ask about at all — no recording, and no airing to look up.
    // Asking with an empty start would 404 and dress the sheet as a failure,
    // which it is not: the channel simply has no listings.
    if (recordingId == null && start === null) return;
    let live = true;

    void (async () => {
      // Both, in parallel, because they answer different questions and either
      // can be absent. Neither rejection is exceptional, so both are caught
      // into null and the two nulls together are what counts as failure.
      const [rec, air] = await Promise.all([
        recordingId != null
          ? api.recordingDetail(recordingId).catch(() => null)
          : Promise.resolve(null),
        start !== null
          ? api.airingDetail(channel, start).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!live) return;
      if (rec === null && air === null) { setFailed(true); return; }
      setDetail(rec === null ? air : withAiringActions(rec, air));

      // Then ask the device what it actually thinks. The mirror is a sync
      // behind - measured, it called an episode scheduled after it had been
      // turned off in the Tablo app, and reported a series rule the device had
      // since changed. Second rather than first, so the sheet opens at mirror
      // speed and corrects itself a moment later; a refusal leaves the
      // mirror's answer standing, which beats a sheet that will not open.
      if (start === null) return;
      try {
        const fresh = await api.airingLive(channel, start);
        if (!live) return;
        setDetail((d) => (d ? {
          ...d,
          schedule_state: fresh.schedule_state,
          skip_reason: fresh.skip_reason,
          scheduled: fresh.scheduled,
          series: d.series
            ? {
                ...d.series,
                schedule_rule: fresh.series_rule ?? d.series.schedule_rule,
              }
            : d.series,
        } : d));
      } catch {
        // The mirror's answer stands.
      }
    })();

    return () => { live = false; };
  }, [channel, start, recordingId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Innermost first. With a question up, Escape answers that question -
      // closing the whole sheet would throw the decision away along with the
      // context that raised it.
      if (confirming) setConfirming(null);
      else onClose();
    };
    // On `document`, not `window`: the tests dispatch there, and so does a
    // focused element inside the panel — the event reaches both either way.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, confirming]);

  /**
   * Apply a write optimistically, and put the old state back if it fails.
   *
   * Optimistic because the common failure is the network rather than a
   * refusal, and because the response carries the truth either way — every one
   * of these endpoints answers with the full updated detail.
   */
  async function write(
    optimistic: Partial<AiringDetail>,
    work: () => Promise<AiringDetail>,
  ) {
    if (!detail) return;
    const before = detail;
    setDetail({ ...detail, ...optimistic });
    setPending(true);
    setWriteError(null);
    try {
      setDetail(await work());
    } catch (e) {
      setDetail(before);
      setWriteError(e instanceof Error ? e.message : "The change did not stick.");
    } finally {
      setPending(false);
    }
  }

  /**
   * A channel the guide has no listing for, rather than one still loading.
   *
   * A named recording is not that case even with no airing to go with it: the
   * device can describe it in full, and heading the sheet "No programme
   * information" over a programme it is about to name would be a lie.
   */
  const noListing = start === null && recordingId == null;

  /**
   * Still waiting on the first answer about this programme.
   *
   * Not for a channel with no listing at all: there is nothing to wait for
   * there, and the sheet is the row - it names the channel and offers to
   * watch it.
   */
  const loading = !noListing && detail === null && !failed;

  /**
   * Ask before a write that starts or stops a recording.
   *
   * Only when something is actually at stake: an airing that has not begun
   * captures nothing part-way, so scheduling it is reversible and silent.
   */
  function guard(need: boolean, label: string, why: string, action: string,
                 run: () => void) {
    if (!need) { run(); return; }
    setConfirming({ label, detail: why, action, run });
  }

  /** The recording capturing this airing right now, if one is. */
  const recording = start ? recordingFor(inProgress, channel, start) : null;
  const captured = recording ? recordedSpan(recording) : null;

  /**
   * An episode of this series on a tuner right now — any episode, not this one.
   *
   * Measured on a real device 2026-09-18: setting the rule to None stopped a
   * recording in flight within twelve seconds, and the ninety seconds already
   * captured stayed in the library as a stub. So the rule buttons can end a
   * recording of something the sheet is not even showing, which is why this
   * asks about the series rather than about the airing.
   */
  const seriesRecording = detail?.series
    ? recordingForSeries(inProgress, detail.series.path)
    : null;

  /**
   * Which recording this sheet can delete.
   *
   * The opener's answer wins over the airing's. A Library card knows exactly
   * which recording it is showing; the airing only knows its newest, and those
   * differ whenever a capture was stopped and restarted.
   */
  const deletable = recordingId ?? detail?.recording_id ?? null;

  /**
   * The recording this sheet can play, and how far into it someone got.
   *
   * Same id the delete acts on: whatever this sheet is about, there is one
   * recording of it, and both controls mean that one.
   */
  const watchable = deletable;
  const watchedAt = watchable != null
    ? loadResume(resumeKey("recording", watchable))
    : 0;

  /**
   * Playing without leaving.
   *
   * The player is an overlay that takes a recording rather than an id, and for
   * a while only the Library held one - so this routed there instead, which
   * started playback behind this sheet in a view the viewer had not asked for,
   * and left them there when they closed it. One fetch gets the recording, and
   * the player opens over the sheet: closing it lands back here.
   *
   * The Library still plays through `onWatchRecording`, because it owns a
   * player already and keeps the playhead in its own URL.
   */
  const [playing, setPlaying] = useState<Recording | null>(null);

  async function playHere(objectId: number) {
    try {
      setPlaying(await api.recording(objectId));
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : "That recording would not open.");
    }
  }

  /**
   * Delete the recording on the Tablo, and stop offering to.
   *
   * Not optimistic, unlike the schedule writes: those can be put back by
   * writing the opposite, and this cannot be put back at all. The button stays
   * until the device has confirmed the recording is gone.
   */
  function deleteRecording(objectId: number) {
    // Everything that describes this recording goes on the same beat: the
    // question, the sheet, and the card behind them. Waiting on the device
    // first left the answer dismissed and the sheet sitting there for a beat -
    // which reads as a click that did not land, and invites a second one.
    //
    // The optimism is answerable rather than blind: a refusal is handed to
    // whoever opened the sheet, which is the only thing still on screen and
    // the only thing able to put the card back.
    onDeleted?.(objectId);
    onClose();

    void api.deleteRecording(objectId).then(
      () => onDeleteConfirmed?.(objectId),
      (e) => onDeleteFailed?.(objectId, e instanceof Error
        ? e.message
        : "The Tablo would not delete this recording."),
    );
  }

  /**
   * Apply a series rule, asking first when the answer would cost a recording.
   *
   * Two different questions hang off these three buttons. Turning the series
   * on starts capturing whatever is on air part-way through; turning it off
   * ends whatever it has on a tuner. Neither is what a row of buttons labelled
   * All / New / None looks like it does.
   */
  function applyRule(value: SeriesRule) {
    const setIt = () => write(
      { series: { ...detail!.series!, schedule_rule: value } },
      () => api.scheduleSeries(channel, start!, value),
    );

    if (value === "none" && seriesRecording?.channel_identifier) {
      const what = seriesRecording.title ?? "An episode";
      const so_far = formatDuration(seriesRecording.recorded_seconds ?? 0);
      // No offer to save the episode. Rescheduling the airing afterwards does
      // not resume the capture - it starts a second one, leaving a stub of
      // what was caught before the rule change and a separate recording of the
      // rest. Measured on a real device: a cancelled hour came back as 5m and
      // 55m, two rows in the library. An honest stop beats that.
      setConfirming({
        label: "An episode is recording now.",
        detail: `“${what}” — ${so_far} of ${formatDuration(seriesRecording.duration)} `
          + "captured. Setting the rule to None stops it at once. What was "
          + "captured stays in your library; the rest is not recorded.",
        action: "Stop it",
        destructive: true,
        run: setIt,
      });
      return;
    }

    guard(
      value !== "none" && !!detail?.airing_now && !detail?.scheduled,
      "Record this series?",
      "This episode is already airing, and setting a rule starts recording it "
        + "now - capturing only what is left of it.",
      "Set rule",
      setIt,
    );
  }

  const number = detail ? channelNumber(detail.channel) : null;
  // Network and channel number are deliberately absent: the eyebrow above the
  // title already carries both, and repeating them put "LOCALFAST · 7.99" two
  // lines under "7.99 · LOCALFAST" on every sheet.
  const meta = detail
    ? [
        detail.season_number != null && detail.episode_number != null
          ? `S${detail.season_number} E${detail.episode_number}`
          : null,
        detail.duration ? formatDuration(detail.duration) : null,
        detail.rating ? formatRating(detail.rating) : null,
      ].filter(Boolean)
    : [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim backdrop-blur-sm p-6"
      role="dialog"
      aria-modal="true"
      aria-label={noListing
        ? `${channelLabel ?? "Channel"} — no programme information`
        : detail?.title ?? "Show information"}
      // Dismisses this sheet and nothing behind it. When opened from a series
      // panel the sheet renders inside it, so an un-stopped click bubbled to
      // the panel's own outside-click and took both down - losing the place in
      // the list the sheet was opened from.
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      {/* Two boxes, and both parts matter. `relative` gives the confirmation
          something to sit over; `flex` with `max-h-full` keeps the height
          chain intact so the sheet inside still scrolls.

          The inner sheet cannot carry `max-h-full` here: a percentage maximum
          against a parent of automatic height does not resolve, so the sheet
          grew past the bottom of the screen and took its controls with it -
          the series buttons were simply unreachable. `min-h-0` is what lets a
          flex child shrink below its content and scroll instead. */}
      <div className="relative flex w-full max-w-lg max-h-full"
           onClick={(e) => e.stopPropagation()}>
      <div
        className="w-full min-h-0 overflow-y-auto rounded-3xl
                   bg-surface-overlay border border-border shadow-2xl shadow-shade"
      >
        {/* One state, then the card - never half of it.

            The actions are the trap here: they are drawn from the id the
            opener already holds, so they rendered the instant the sheet did,
            while the title, artwork and description waited on the fetch. That
            read as a bare pair of buttons with a card popping in around them.

            A press has to register, though, so this is a beat of "loading"
            rather than an empty rectangle - and it is sized to nothing, so it
            does not pretend to be the card that follows. */}
        {loading ? (
          <div role="status" className="flex items-center justify-center gap-3 p-10">
            <Loader2 className="w-5 h-5 animate-spin text-fg-muted" aria-hidden />
            <span className="text-sm text-fg-muted">Loading…</span>
          </div>
        ) : (
        <>
        {/* Rendered only when there is art. A placeholder box at hero size
            reads as a failed image rather than as an absent one.

            16:9 is right, and measured rather than assumed: the device's
            `cover_image` and `background_image` are both 1920x1080. Only
            `thumbnail_image` is a portrait 240x360 poster, and nothing here
            asks for that one. */}
        {(posterOverride ?? detail?.image_url) && (
          <img
            src={(posterOverride ?? detail?.image_url) || undefined}
            alt=""
            className="w-full aspect-video max-w-full object-cover rounded-t-3xl bg-surface-sunken"
          />
        )}

        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {/* No airing to name, so the channel names itself. The eyebrow
                  below is built from the airing's own channel record, which
                  there is none of here. */}
              {noListing && (
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {channelLabel}
                </p>
              )}
              {detail && (
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {[number, detail.channel.network ?? detail.channel.call_sign]
                    .filter(Boolean).join(" · ")}
                </p>
              )}
              <h2 className="mt-1 text-xl font-bold text-fg leading-snug text-balance">
                {noListing
                  ? "No programme information"
                  : detail?.title ?? (failed ? "Information unavailable" : " ")}
              </h2>
              {detail?.episode_title && (
                <p className="mt-1 text-base text-fg-secondary leading-snug">
                  {detail.episode_title}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 -mr-2 -mt-2 p-2 rounded-xl text-fg-muted
                         hover:text-fg hover:bg-fill-soft transition
                         focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <X className="w-5 h-5" aria-hidden />
            </button>
          </div>

          {detail && whenLine(detail.start, detail.duration) && (
            <p className="mt-3 text-sm text-fg-subtle">
              {whenLine(detail.start, detail.duration)}
            </p>
          )}

          {detail?.description && (
            <p className="mt-4 text-sm text-fg-secondary leading-relaxed">
              {detail.description}
            </p>
          )}

          {meta.length > 0 && (
            <p className="mt-4 text-xs text-fg-muted">{meta.join(" · ")}</p>
          )}

          {detail?.genres && detail.genres.length > 0 && (
            <p className="mt-2 text-xs text-fg-faint">{detail.genres.join(", ")}</p>
          )}

          {/* Only while it is on. `airing_now` is the server's judgement, not
              this browser's — see the endpoint for why.

              Always for a channel with no listings: what is missing there is
              the EPG data, not the channel, and watching it is the only thing
              this sheet is for. */}
          {/* What pressing it does, said in the label. A recording resumes
              where it was left, which is a surprise worth naming: the Library
              card beside this one already says "Resume 16:56" rather than
              making anyone guess.

              The recording wins over the broadcast when both exist. It plays
              from its first moment - the device serves one still being written
              as HLS - so it is watching from the start rather than joining
              half way through, and it needs no tuner. */}
          {watchable != null && (
            <button
              onClick={() => (onWatchRecording
                ? onWatchRecording(watchable)
                : void playHere(watchable))}
              className="mt-6 w-full flex items-center justify-center gap-2
                         px-4 py-2.5 rounded-xl text-sm font-semibold
                         bg-accent text-accent-fg hover:opacity-90 transition
                         focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <Play className="w-4 h-4" aria-hidden />
              {watchedAt > 0 ? "Continue Watching" : "Watch Now"}
            </button>
          )}

          {watchable == null && (noListing || detail?.airing_now) && (
            <button
              onClick={onTune}
              className="mt-6 w-full flex items-center justify-center gap-2
                         px-4 py-2.5 rounded-xl text-sm font-semibold
                         bg-accent text-accent-fg hover:opacity-90 transition
                         focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <Play className="w-4 h-4" aria-hidden />
              Watch Live
            </button>
          )}

          {/* Omitted rather than disabled: a dead button with no explanation
              reads as broken, and the reason is worth a line.

              Never on a sheet opened from the Library. `schedulable` is false
              there whenever the guide has no listing left, which says nothing
              about the channel - and a recording is standing proof that the
              channel records. Scheduling is not what that sheet is about. */}
          {detail && !detail.schedulable && recordingId == null && (
            <p className="mt-6 text-xs text-fg-muted">
              Recording isn't available on this channel.
            </p>
          )}

          {/* What is happening right now, above what could be made to happen.
              The bar is the scheduled slot with the captured part placed where
              it falls — identical geometry to the Library card, the Live card
              and the guide cell, from the same function. */}
          {recording && captured && (
            <div className="mt-6 rounded-xl bg-fill-soft p-3">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-danger">
                <span className="relative flex w-2 h-2" aria-hidden>
                  <span className="motion-safe:animate-ping absolute inline-flex w-full h-full rounded-full bg-danger opacity-60" />
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-danger" />
                </span>
                Recording now
              </p>

              <div className="mt-2 h-1 w-full rounded-full bg-ink/40 relative overflow-hidden">
                <div
                  className="bg-danger h-full absolute inset-y-0"
                  style={{ left: `${captured.left}%`, width: `${captured.width}%` }}
                />
              </div>

              <p className="mt-2 text-xs text-fg-muted tabular-nums">
                {formatDuration(recording.recorded_seconds ?? 0)} of{" "}
                {formatDuration(recording.expected_seconds || recording.duration)} captured
                {recording.recording_started && (
                  <> · since {new Date(recording.recording_started)
                    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</>
                )}
              </p>

              <button
                disabled={pending}
                onClick={() => guard(
                  true,
                  "Stop recording?",
                  `What has been recorded of "${detail?.title ?? "this programme"}" is kept, `
                    + "but recording will not resume.",
                  "Stop",
                  () => write({ scheduled: false },
                              () => api.scheduleAiring(channel, start!, false)),
                )}
                className="mt-3 w-full flex items-center gap-3 px-4 py-2.5 rounded-xl
                           text-sm font-semibold bg-danger-solid text-danger-fg
                           hover:opacity-90 transition disabled:opacity-60
                           focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <Square className="w-4 h-4 shrink-0" fill="currentColor" aria-hidden />
                Stop Recording
              </button>
            </div>
          )}

          {detail?.schedulable && (
            <div className="mt-6 space-y-2">
              {/* A past airing reports what happened. `scheduled` stays true
                  after an airing has recorded, so describing its scope in the
                  future tense left a programme that finished hours ago labelled
                  with an intent - and, with the series rule at None,
                  contradicting the control directly beneath it. */}
              {detail.scheduled && detail.past && (
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  Recorded
                </p>
              )}
              {detail.scheduled && !detail.past && !recording && (
                <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                  REC · {recordScope(detail)}
                </p>
              )}

              {/* Gated on `past`, never on `airing_now`: that is false for
                  everything upcoming, which is most of what anyone records. */}
              {!detail.past && (
                <button
                  disabled={pending}
                  onClick={() => guard(
                    !detail.scheduled && detail.airing_now,
                    "Record this episode?",
                    "It is already airing, so recording starts now and captures "
                      + "only what is left of it.",
                    "Record",
                    () => write(
                      { scheduled: !detail.scheduled },
                      () => api.scheduleAiring(channel, start!, !detail.scheduled),
                    ),
                  )}
                  className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl
                             text-sm font-semibold bg-fill-soft text-fg
                             hover:bg-fill transition disabled:opacity-60
                             focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  {detail.scheduled
                    ? <CircleSlash className="w-4 h-4 shrink-0" aria-hidden />
                    : <Circle className="w-4 h-4 shrink-0" aria-hidden />}
                  {detail.scheduled ? "Don't Record Episode" : "Record Episode"}
                </button>
              )}

              {/* The series behind this episode: back to it when that is where
                  this sheet was opened from, onward to it otherwise. Absent
                  for a one-off or a film, which has no series to open. */}
              {backToSeries ? (
                <button
                  onClick={onClose}
                  className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl
                             text-sm font-semibold bg-fill-soft text-fg
                             hover:bg-fill transition
                             focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <ArrowLeft className="w-4 h-4 shrink-0" aria-hidden />
                  Back to Series
                </button>
              ) : onOpenSeries && detail?.series?.path ? (
                <button
                  onClick={() => onOpenSeries(
                    detail.series!.path, detail.title ?? "This series")}
                  className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl
                             text-sm font-semibold bg-fill-soft text-fg
                             hover:bg-fill transition
                             focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <Layers className="w-4 h-4 shrink-0" aria-hidden />
                  Series Information
                  {/* It sits in a column of buttons that toggle things - record
                      this episode, set the rule - and looked like one more of
                      them. The chevron says this one goes somewhere. */}
                  <ChevronRight className="w-4 h-4 shrink-0 ml-auto text-fg-muted"
                                aria-hidden />
                </button>
              ) : null}

              {/* Kept on a past airing: a rule is about every episode still to
                  come, not about the one being looked at. */}
              {detail.series && (
                <div className="rounded-xl bg-fill-soft p-3">
                  <p className="flex items-center gap-3 text-sm font-semibold text-fg">
                    <SlidersHorizontal className="w-4 h-4 shrink-0" aria-hidden />
                    Edit Series Recording
                  </p>
                  <div className="mt-3 flex gap-2">
                    {RULES.map(({ value, label }) => {
                      const on = detail.series?.schedule_rule === value;
                      return (
                        <button
                          key={value}
                          aria-pressed={on}
                          disabled={pending}
                          onClick={() => applyRule(value)}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold
                                      transition disabled:opacity-60
                                      focus:outline-none focus:ring-2 focus:ring-accent ${
                            on ? "bg-accent text-accent-fg"
                               : "bg-fill text-fg-secondary hover:text-fg"}`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* What this airing left behind, and the way to be rid of it.

              Outside the `schedulable` block on purpose: a recording outlives
              the schedule handles of the airing that made it, and something
              already on the drive is still deletable when scheduling it again
              is not.

              Deletion is on the Tablo, not here - the Library's own trash
              button drops the transcoded copy and leaves the recording on the
              device, which is a different promise and was the only one the app
              could keep until now. */}
          {deletable != null && (
            <button
              disabled={pending}
              onClick={() => setConfirming({
                label: "Delete this recording?",
                detail: `“${detail?.title ?? "This recording"}” is removed from the `
                  + "Tablo, freeing its space. This cannot be undone.",
                action: "Delete",
                destructive: true,
                run: () => void deleteRecording(deletable),
              })}
              className="mt-6 w-full flex items-center gap-3 px-4 py-2.5 rounded-xl
                         text-sm font-semibold bg-fill-soft text-danger
                         hover:bg-fill transition disabled:opacity-60
                         focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <Trash2 className="w-4 h-4 shrink-0" aria-hidden />
              Delete Recording
            </button>
          )}

          {writeError && (
            <p role="alert" className="mt-3 text-xs text-danger">{writeError}</p>
          )}
        </div>
        </>
        )}
      </div>

      {/* The question, over the card rather than above it.

          As a banner in the flow it pushed the artwork and every control below
          it down the sheet, so the card jumped at exactly the moment attention
          was wanted on the question - and on a scrolled sheet it could open
          off-screen, above the control that raised it.

          Scoped to the card's own bounds, not the viewport: this is the card
          asking something, and a second full-screen dialog over the first
          reads as a mistake.

          `alertdialog` rather than `dialog`: every one of these interrupts to
          report a consequence - a tuner that stops, a capture that starts
          part-way through - which is what the role is for. */}
      {confirming && (
        <div
          className="confirm-backdrop absolute inset-0 z-10 flex items-center
                     justify-center rounded-3xl bg-scrim/80 backdrop-blur-[2px] p-6"
          onClick={() => setConfirming(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-detail"
            className="w-full max-w-sm rounded-2xl border border-border
                       bg-surface-overlay p-5 shadow-2xl shadow-shade"
            onClick={(e) => e.stopPropagation()}
          >
            <p id="confirm-title"
               className="flex items-center gap-2 text-sm font-semibold text-fg">
              <AlertTriangle className="w-4 h-4 shrink-0 text-warning" aria-hidden />
              {confirming.label}
            </p>
            <p id="confirm-detail" className="mt-2 text-xs leading-relaxed text-fg-muted">
              {confirming.detail}
            </p>
            {/* Stacked, not a row: side-by-side pills of equal weight made the
                destructive answer look like just another button.

                Focus starts on Cancel whenever the answer ends a recording. A
                confirmation that opens with the destructive button focused is
                one stray Return away from doing the thing it asked about. */}
            <div className="mt-4 flex flex-col gap-2">
              <button
                autoFocus={!confirming.destructive}
                onClick={() => { const { run } = confirming; setConfirming(null); run(); }}
                className={`w-full px-4 py-2.5 rounded-xl text-sm font-semibold
                            transition focus:outline-none focus:ring-2 focus:ring-accent ${
                  confirming.destructive
                    ? "bg-danger-solid text-danger-fg hover:opacity-90"
                    : "bg-accent text-accent-fg hover:opacity-90"}`}
              >
                {confirming.action}
              </button>
              <button
                autoFocus={confirming.destructive}
                onClick={() => setConfirming(null)}
                className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold
                           bg-fill text-fg-secondary hover:text-fg transition
                           focus:outline-none focus:ring-2 focus:ring-accent"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Over the sheet, not instead of it: closing the player lands back on
          the thing that opened it, which is the whole point of playing here
          rather than routing to the Library. */}
      {playing && (
        // Its own layer, above this sheet and outside its backdrop's reach.
        // Nested inside, every click on the player's controls bubbled to the
        // dismiss handler and closed the lot - and the picture painted below
        // the sheet, the player being z-50 against the sheet's z-60.
        <div
          data-player-layer
          className="fixed inset-0 z-[80]"
          onClick={(e) => e.stopPropagation()}
        >
          <VideoPlayer
            source={{ kind: "recording", recording: playing }}
            startAt={loadResume(resumeKey("recording", playing.object_id))}
            onPosition={(seconds) =>
              saveResume(resumeKey("recording", playing.object_id),
                         seconds, playing.duration)}
            onClose={() => setPlaying(null)}
          />
        </div>
      )}
    </div>
  );
}
