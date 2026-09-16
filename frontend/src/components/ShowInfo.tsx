import { useEffect, useRef, useState } from "react";
import { Play, X } from "lucide-react";
import { api } from "../api/tablo";
import type { AiringDetail } from "../api/tablo";

interface Props {
  /** Channel identifier, as the grid holds it. */
  channel: string;
  /** Airing start, as the grid holds it. Together these key `guide_airing`. */
  start: string;
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
export function ShowInfo({ channel, start, onClose, onTune }: Props) {
  const [detail, setDetail] = useState<AiringDetail | null>(null);
  const [failed, setFailed] = useState(false);
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
      aria-label={detail?.title ?? "Show information"}
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
              {detail && (
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  {[number, detail.channel.network ?? detail.channel.call_sign]
                    .filter(Boolean).join(" · ")}
                </p>
              )}
              <h2 className="mt-1 text-xl font-bold text-fg leading-snug text-balance">
                {detail?.title ?? (failed ? "Information unavailable" : " ")}
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
              this browser's — see the endpoint for why. */}
          {detail?.airing_now && (
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
        </div>
      </div>
    </div>
  );
}
