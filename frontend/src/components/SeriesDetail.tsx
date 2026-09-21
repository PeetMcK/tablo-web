/**
 * Series detail — settings + episode cleanup for one recorded series.
 *
 * Opened from a Recordings series card. The settings section (rule / keep /
 * padding / danger zone) writes through `api.series.update` and needs the guide
 * `identifier`; a series with no active rule has none, so the section is shown
 * disabled with a hint and only episode cleanup is offered. The episode list
 * reuses the episode-level protect/watched/delete verbs.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X, Lock, LockOpen, Eye, EyeOff, Trash2, Film, Radio,
} from "lucide-react";
import {
  api, type SeriesAiring, type SeriesCard, type SeriesEpisode, type SeriesUpdate,
} from "../api/tablo";
import { Segmented } from "./ui/controls";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import { stateMarker } from "../lib/scheduleState";

const KEEP_PRESETS = [1, 3, 5, 10, 20];

function fmtDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function EpisodeRow({
  ep, checked, onCheck, onWatched, onProtect, onDelete,
}: {
  ep: SeriesEpisode;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onWatched: () => void;
  onProtect: () => void;
  onDelete: () => void;
}) {
  const se =
    ep.season_number != null && ep.episode_number != null
      ? `S${ep.season_number} E${ep.episode_number}`
      : null;
  return (
    <li className="flex items-center gap-3 py-2 text-sm border-b border-border-subtle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        aria-label={`Select ${ep.title ?? "episode"}`}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{ep.title ?? "Untitled"}</span>
          {se && <span className="text-fg-muted shrink-0">{se}</span>}
          {ep.is_recording && (
            <span className="inline-flex items-center gap-1 text-danger shrink-0" title="Recording">
              <Radio className="w-3.5 h-3.5" aria-hidden />
            </span>
          )}
          {ep.position === 0 && !ep.watched && !ep.is_recording && (
            <span className="px-1 py-0.5 rounded bg-accent-soft text-accent-strong text-[10px] font-bold uppercase shrink-0">
              New
            </span>
          )}
        </div>
        <div className="text-[11px] text-fg-muted tabular-nums">
          {ep.orig_air_date ?? ""} · {fmtDuration(ep.duration)}
          {fmtSize(ep.size) && ` · ${fmtSize(ep.size)}`}
        </div>
      </div>
      <button
        onClick={onWatched}
        title={ep.watched ? "Mark unwatched" : "Mark watched"}
        aria-label={ep.watched ? "Mark unwatched" : "Mark watched"}
        className="shrink-0 w-8 h-8 rounded-full hover:bg-fill flex items-center justify-center text-fg-secondary"
      >
        {ep.watched ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
      </button>
      <button
        onClick={onProtect}
        title={ep.protected ? "Remove protection" : "Protect from deletion"}
        aria-label={ep.protected ? "Remove protection" : "Protect from deletion"}
        className={`shrink-0 w-8 h-8 rounded-full hover:bg-fill flex items-center justify-center ${ep.protected ? "text-warning" : "text-fg-secondary"}`}
      >
        {ep.protected ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
      </button>
      <button
        onClick={onDelete}
        title="Delete recording"
        aria-label={`Delete ${ep.title ?? "episode"}`}
        className="shrink-0 w-8 h-8 rounded-full hover:bg-danger-solid/15 flex items-center justify-center text-fg-secondary hover:text-danger"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </li>
  );
}

function AiringsPane({
  query, hasGuide, emptyLabel,
}: {
  query: { data?: SeriesAiring[]; isLoading: boolean };
  hasGuide: boolean;
  emptyLabel: string;
}) {
  if (!hasGuide) {
    return (
      <p className="text-fg-muted p-4 text-center text-sm">
        This series has no guide entry, so its schedule isn't available.
      </p>
    );
  }
  if (query.isLoading) {
    return <p className="text-fg-muted p-4 text-center text-sm">Loading…</p>;
  }
  const rows = query.data ?? [];
  if (rows.length === 0) {
    return <p className="text-fg-muted p-4 text-center text-sm">{emptyLabel}</p>;
  }
  return (
    <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col p-4 pt-3">
      {rows.map((a) => {
        const se =
          a.season_number != null && a.episode_number != null
            ? `S${a.season_number} E${a.episode_number}`
            : null;
        const when = a.datetime ? new Date(a.datetime) : null;
        return (
          <li key={a.object_id}
              className="flex items-center gap-3 py-2 text-sm border-b border-border-subtle">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{a.title ?? "Untitled"}</span>
                {se && <span className="text-fg-muted shrink-0">{se}</span>}
                {(() => {
                  const m = stateMarker(a.state, a.skip_reason);
                  return (
                    <span className={
                      "px-1.5 py-0.5 rounded text-[11px] font-semibold shrink-0 " + m.className
                    }>
                      {m.label}
                    </span>
                  );
                })()}
              </div>
              <div className="text-[11px] text-fg-muted tabular-nums">
                {when
                  ? when.toLocaleString(undefined, {
                      weekday: "short", month: "short", day: "numeric",
                      hour: "numeric", minute: "2-digit",
                    })
                  : ""}
                {a.channel ? ` · ${a.channel}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function SeriesDetail({
  card, onClose,
}: {
  card: SeriesCard;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const path = card.recordings_path;
  // A ruled series with nothing on disk yet has no recordings_path; open its
  // detail by guide path instead. No episodes to browse or bulk-delete.
  const hasRecordings = path != null;
  const detailKey = path ?? card.guide_path ?? card.title;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [tab, setTab] = useState<"episodes" | "upcoming" | "conflicts">(
    hasRecordings ? "episodes" : "upcoming",
  );

  const { data, isLoading } = useQuery({
    queryKey: ["series-detail", detailKey],
    queryFn: () =>
      path ? api.series.detail(path) : api.series.detailByGuide(card.guide_path!),
  });

  const settings = data?.settings;
  const identifier = settings?.identifier ?? null;
  const guidePath = data?.meta.guide_path ?? card.guide_path ?? null;
  // Settings write to the guide series path, so both are needed to configure.
  const canConfigure = identifier != null && guidePath != null;

  // This series' upcoming airings (all states, so a rule-skipped rerun shows)
  // and its conflicts — titled, unlike the global list. Fetched only when their
  // tab is open and the series has a guide path.
  const upcoming = useQuery({
    queryKey: ["series-airings", guidePath, "all"],
    queryFn: () => api.series.airings(guidePath!, "all"),
    enabled: tab === "upcoming" && !!guidePath,
  });
  const conflicts = useQuery({
    queryKey: ["series-airings", guidePath, "conflicted"],
    queryFn: () => api.series.airings(guidePath!, "conflicted"),
    enabled: tab === "conflicts" && !!guidePath,
  });

  // Padding steppers, in minutes. The device value (seconds) is the baseline;
  // once the viewer edits a field, `pad` holds their in-progress value. This
  // component is keyed on the series in RecordingsView, so opening another
  // series remounts it and the edit state resets — no syncing effect needed.
  const [pad, setPad] = useState<{ start: number; end: number } | null>(null);
  const startMin = pad?.start ?? Math.round((settings?.offsets.start || 0) / 60);
  const endMin = pad?.end ?? Math.round((settings?.offsets.end || 0) / 60);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["series-detail", detailKey] });
    qc.invalidateQueries({ queryKey: ["series"] });
  };

  const update = useMutation({
    mutationFn: (body: SeriesUpdate) => api.series.update(body),
    onSettled: invalidate,
  });
  const bulk = useMutation({
    mutationFn: (filter: "watched" | "unprotected") =>
      api.series.bulkDelete(path!, filter),
    onSettled: invalidate,
  });
  const watched = useMutation({
    // Un-mark writes position 1 (clears watched without dropping to New); mark
    // writes watched:true. The two device calls return different shapes, so the
    // fn is typed to a common Promise.
    mutationFn: ({ id, next }: { id: number; next: boolean }): Promise<unknown> =>
      next ? api.setRecordingWatched(id, true) : api.setRecordingPosition(id, 1),
    onSettled: invalidate,
  });
  const protect = useMutation({
    mutationFn: ({ id, next }: { id: number; next: boolean }) =>
      api.setProtected(id, next),
    onSettled: invalidate,
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteRecording(id),
    onSettled: invalidate,
  });

  const setRule = (rule: "all" | "new" | "none") => {
    if (identifier && guidePath)
      update.mutate({ identifier, guide_path: guidePath, rule });
  };
  const setKeep = (keep: SeriesUpdate["keep"]) => {
    if (identifier && guidePath)
      update.mutate({ identifier, guide_path: guidePath, keep });
  };
  const applyPadding = (s: number, e: number) => {
    if (identifier && guidePath)
      update.mutate({ identifier, guide_path: guidePath,
                     offsets: { start: s * 60, end: e * 60 } });
  };

  const keepRule = settings?.keep.rule ?? "none";

  const deleteSelected = () => {
    for (const id of selected) del.mutate(id);
    setSelected(new Set());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-scrim backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={card.title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl h-full flex flex-col overflow-hidden bg-surface-raised border-l border-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-3 p-4 bg-surface-raised border-b border-border-subtle">
          <div className="w-24 aspect-video rounded overflow-hidden bg-surface-sunken shrink-0">
            {data?.meta.cover_image_id != null ? (
              <img src={`/api/channels/image/${data.meta.cover_image_id}`}
                   alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-fg-subtle">
                <Film className="w-6 h-6" aria-hidden />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold truncate">{card.title}</h2>
            {data?.meta.genres?.length ? (
              <p className="text-xs text-fg-muted truncate">
                {data.meta.genres.join(" · ")}
              </p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-9 h-9 rounded-full hover:bg-fill flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading ? (
          <p className="text-fg-muted py-12 text-center">Loading…</p>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Upper region: description + settings, capped so the episode list
                always keeps a pane; scrolls on its own only if it overflows. */}
            <div className="shrink-0 max-h-[45%] overflow-y-auto p-4 flex flex-col gap-4 border-b border-border-subtle">
            {data?.meta.description && (
              <p className="text-sm text-fg-secondary leading-relaxed">
                {data.meta.description}
              </p>
            )}

            {/* Settings */}
            <section className="flex flex-col gap-4">
              {!canConfigure && (
                <p className="text-xs text-warning">
                  This series has no active recording rule, so its settings
                  can't be changed here — you can still clean up episodes below.
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">Recording</span>
                <Segmented<"all" | "new" | "none">
                  value={settings?.rule}
                  options={[
                    { value: "all", label: "All" },
                    { value: "new", label: "New" },
                    { value: "none", label: "Off" },
                  ]}
                  onChange={setRule}
                  label="Recording rule"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">Keep</span>
                <Segmented<"all" | "none" | "count">
                  value={keepRule as "all" | "none" | "count"}
                  options={[
                    { value: "all", label: "All" },
                    { value: "count", label: "Number" },
                    { value: "none", label: "None" },
                  ]}
                  onChange={(r) =>
                    setKeep(r === "count"
                      ? { rule: "count", count: settings?.keep.count ?? 5 }
                      : { rule: r })}
                  label="Keep rule"
                />
              </div>
              {keepRule === "count" && (
                <div className="flex flex-wrap gap-1.5 justify-end">
                  {KEEP_PRESETS.map((n) => (
                    <button
                      key={n}
                      onClick={() => setKeep({ rule: "count", count: n })}
                      disabled={!canConfigure}
                      className={`px-2.5 py-1 rounded-lg text-sm font-medium border transition disabled:opacity-50 ${
                        settings?.keep.count === n
                          ? "bg-accent text-accent-fg border-accent"
                          : "border-border bg-fill-soft text-fg-secondary hover:text-fg"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}

              {/* Padding */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">
                  Padding <span className="text-fg-muted font-normal">(min)</span>
                </span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1 text-sm">
                    <span className="text-fg-muted">Start</span>
                    <input
                      type="number"
                      value={startMin}
                      disabled={!canConfigure}
                      onChange={(e) => setPad({ start: Number(e.target.value), end: endMin })}
                      onBlur={() => applyPadding(startMin, endMin)}
                      aria-label="Start padding minutes"
                      className="w-16 px-2 py-1 rounded bg-fill-soft border border-border tabular-nums"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-sm">
                    <span className="text-fg-muted">End</span>
                    <input
                      type="number"
                      value={endMin}
                      disabled={!canConfigure}
                      onChange={(e) => setPad({ start: startMin, end: Number(e.target.value) })}
                      onBlur={() => applyPadding(startMin, endMin)}
                      aria-label="End padding minutes"
                      className="w-16 px-2 py-1 rounded bg-fill-soft border border-border tabular-nums"
                    />
                  </label>
                </div>
              </div>

            </section>
            </div>{/* end upper region */}

            {/* Series-focused tabs — the recorded Episodes, plus this series'
                scheduled Upcoming airings and Conflicts (titled). Sits in the
                gap between settings and the list. */}
            <div className="shrink-0 px-4 pt-3 overflow-x-auto">
              <Segmented<"episodes" | "upcoming" | "conflicts">
                value={tab}
                options={[
                  ...(hasRecordings
                    ? [{ value: "episodes" as const, label: "Episodes" }]
                    : []),
                  { value: "upcoming", label: "Upcoming" },
                  { value: "conflicts", label: "Conflicts" },
                ]}
                onChange={setTab}
                label="Series view"
              />
            </div>

            {tab === "episodes" ? (
            /* Episodes — the one scroll region. Header + bulk bar stay put;
                only the list below scrolls. */
            <section className="flex-1 min-h-0 flex flex-col p-4 pt-3">
              <div className="flex items-center justify-between mb-2 shrink-0">
                <h3 className="text-sm font-bold">
                  Episodes{data?.episodes.length ? ` (${data.episodes.length})` : ""}
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => bulk.mutate("watched")}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium border border-border hover:bg-fill"
                  >
                    Delete watched
                  </button>
                  <button
                    onClick={() =>
                      setConfirm({
                        title: `Delete all of ${card.title}?`,
                        body: "Deletes every unprotected episode. Protected episodes are kept.",
                        confirmLabel: "Delete all",
                        danger: true,
                        onConfirm: () => bulk.mutate("unprotected"),
                      })
                    }
                    className="px-2.5 py-1 rounded-lg text-xs font-medium bg-danger-solid/15 text-danger hover:bg-danger-solid/25"
                  >
                    Delete all
                  </button>
                </div>
              </div>

              {selected.size > 0 && (
                <div className="flex items-center gap-3 mb-2 shrink-0 px-3 py-2 rounded-lg bg-accent-soft text-sm">
                  <span className="font-semibold">{selected.size} selected</span>
                  <button
                    onClick={deleteSelected}
                    className="ml-auto font-semibold text-danger"
                  >
                    Delete selected
                  </button>
                  <button onClick={() => setSelected(new Set())} className="text-fg-secondary">
                    Clear
                  </button>
                </div>
              )}

              <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                {(data?.episodes ?? []).map((ep) => (
                  <EpisodeRow
                    key={ep.object_id}
                    ep={ep}
                    checked={selected.has(ep.object_id)}
                    onCheck={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(ep.object_id); else next.delete(ep.object_id);
                        return next;
                      })
                    }
                    onWatched={() =>
                      watched.mutate({ id: ep.object_id, next: !ep.watched })}
                    onProtect={() =>
                      protect.mutate({ id: ep.object_id, next: !ep.protected })}
                    onDelete={() =>
                      setConfirm({
                        title: `Delete ${ep.title ?? "this episode"}?`,
                        confirmLabel: "Delete",
                        danger: true,
                        onConfirm: () => del.mutate(ep.object_id),
                      })
                    }
                  />
                ))}
              </ul>
            </section>
            ) : (
              <AiringsPane
                query={tab === "upcoming" ? upcoming : conflicts}
                hasGuide={!!guidePath}
                emptyLabel={tab === "upcoming"
                  ? "Nothing scheduled for this series."
                  : "No conflicts for this series."}
              />
            )}
          </div>
        )}

        {/* Footer: the destructive series-wide action, anchored bottom-right.
            Turning the rule off alone is the "Off" segment above, so this is
            only the combination — stop future recordings AND delete what's
            here. Hidden when the series has no rule to turn off. */}
        {!isLoading && canConfigure && hasRecordings && (
          <div className="shrink-0 flex justify-end p-3 border-t border-border-subtle bg-surface-raised">
            <button
              onClick={() =>
                setConfirm({
                  title: `Turn off ${card.title} and delete all episodes?`,
                  body: "The recording rule is turned off so no future episodes record, and every unprotected episode already recorded is deleted. Protected episodes are kept.",
                  confirmLabel: "Turn off & delete all",
                  danger: true,
                  onConfirm: () => {
                    setRule("none");
                    bulk.mutate("unprotected");
                  },
                })
              }
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-danger-solid/15 text-danger hover:bg-danger-solid/25"
            >
              Turn off &amp; delete all
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
