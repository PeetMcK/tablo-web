import { useEffect, useRef, useState } from "react";
import { Circle, CircleSlash, Play, SlidersHorizontal, X } from "lucide-react";
import { api } from "../api/tablo";
import type { AiringDetail, SeriesRule } from "../api/tablo";

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
  onClose: () => void;
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
export function ShowInfo({ channel, start, channelLabel, onClose, onTune }: Props) {
  const [detail, setDetail] = useState<AiringDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
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
    // Nothing to ask for without an airing to ask about — and asking with an
    // empty start would 404 and dress the sheet as a failure, which it is not.
    if (start === null) return;
    let live = true;
    api.airingDetail(channel, start)
      .then((d) => { if (live) setDetail(d); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [channel, start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // On `document`, not `window`: the tests dispatch there, and so does a
    // focused element inside the panel — the event reaches both either way.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  /** A channel the guide has no listing for, rather than one still loading. */
  const noListing = start === null;

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
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-full overflow-y-auto rounded-3xl
                   bg-surface-overlay border border-border shadow-2xl shadow-shade"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Rendered only when there is art. A placeholder box at hero size
            reads as a failed image rather than as an absent one. */}
        {detail?.image_url && (
          <img
            src={detail.image_url}
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
          {(noListing || detail?.airing_now) && (
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
              reads as broken, and the reason is worth a line. */}
          {detail && !detail.schedulable && (
            <p className="mt-6 text-xs text-fg-muted">
              Recording isn't available on this channel.
            </p>
          )}

          {detail?.schedulable && (
            <div className="mt-6 space-y-2">
              {detail.scheduled && (
                <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                  REC · {recordScope(detail)}
                </p>
              )}

              {/* Gated on `past`, never on `airing_now`: that is false for
                  everything upcoming, which is most of what anyone records. */}
              {!detail.past && (
                <button
                  disabled={pending}
                  onClick={() => write(
                    { scheduled: !detail.scheduled },
                    () => api.scheduleAiring(channel, start!, !detail.scheduled),
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
                          onClick={() => write(
                            { series: { ...detail.series!, schedule_rule: value } },
                            () => api.scheduleSeries(channel, start!, value),
                          )}
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

              {writeError && (
                <p role="alert" className="text-xs text-danger">{writeError}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
