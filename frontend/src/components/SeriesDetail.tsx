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
  X, Lock, LockOpen, Eye, EyeOff, Trash2, Film,
} from "lucide-react";
import {
  api, type SeriesAiring, type SeriesCard, type SeriesEpisode, type SeriesUpdate,
  type SeriesDetail as SeriesDetailData,
} from "../api/tablo";
import { Segmented } from "./ui/controls";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog";
import {
  recordingForSeries, useRecordingsInProgress,
} from "../lib/useRecordingsInProgress";
import { formatDuration } from "../lib/format";
import { ShowInfo } from "./ShowInfo";
import { stateMarker } from "../lib/scheduleState";
import { RecordingPill } from "./RecordingPill";
import { keepValue, keepFromValue, keepOptions } from "../lib/keep";

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
  ep, checked, onCheck, onOpen, onWatched, onProtect, onDelete,
}: {
  ep: SeriesEpisode;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onOpen: () => void;
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
      {/* The text is the way in; the checkbox and the three controls beside it
          are not. A whole-row click would fight all four. */}
      <button
        onClick={onOpen}
        className="min-w-0 flex-1 text-left rounded hover:bg-fill/60 transition px-1 -mx-1
                   focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{ep.title ?? "Untitled"}</span>
          {se && <span className="text-fg-muted shrink-0">{se}</span>}
          {ep.is_recording && <RecordingPill className="shrink-0" />}
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
      </button>
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
  query, hasGuide, emptyLabel, onOpen,
}: {
  query: { data?: SeriesAiring[]; isLoading: boolean };
  hasGuide: boolean;
  emptyLabel: string;
  onOpen: (a: SeriesAiring) => void;
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
            {/* Every row here is an airing with a sheet of its own - what it
                is, when, and whether it will record. */}
            <button
              onClick={() => onOpen(a)}
              disabled={!a.channel_identifier || !a.datetime}
              className="min-w-0 flex-1 text-left rounded hover:bg-fill/60 transition px-1 -mx-1
                         disabled:hover:bg-transparent
                         focus:outline-none focus:ring-2 focus:ring-accent"
            >
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
            </button>
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
  /**
   * The airing or episode whose sheet is open over this panel.
   *
   * Stacked rather than replacing: the panel is where you were, and closing
   * the sheet has to land back on it with the list still where it was. Escape
   * closes the sheet alone - see ShowInfo, which answers innermost-first.
   */
  const [sheet, setSheet] = useState<
    { channel: string; start: string | null; recordingId?: number } | null
  >(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // Polled while the drawer is open: the rule control can stop a tuner, so it
  // needs to know whether one is running before it asks the question.
  const inProgress = useRecordingsInProgress(true);
  // Episodes always, even with nothing on disk. A series scheduled nightly and
  // not yet recorded had no Episodes tab at all, so the panel opened on
  // Upcoming and the place that would say "none yet" did not exist - which
  // reads as a different kind of series rather than an empty one.
  const [tab, setTab] = useState<"episodes" | "upcoming" | "conflicts">("episodes");

  const { data, isLoading } = useQuery({
    queryKey: ["series-detail", detailKey],
    queryFn: () =>
      path ? api.series.detail(path) : api.series.detailByGuide(card.guide_path!),
  });

  const settings = data?.settings;
  const identifier = settings?.identifier ?? null;
  const guidePath = data?.meta.guide_path ?? card.guide_path ?? null;
  // Settings write to the guide series path, so that alone is what's required.
  // A series turned off has no identifier but keeps its guide_path, so it must
  // stay configurable — otherwise turning it off would strand it off.
  const canConfigure = guidePath != null;

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
  // The channels this series airs on — the choices for pinning the rule.
  const channels = useQuery({
    queryKey: ["series-channels", guidePath],
    queryFn: () => api.series.channels(guidePath!),
    enabled: canConfigure && !!guidePath,
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
    // Optimistic: reflect the new rule/keep/offsets in the drawer instantly so
    // the segment snaps under the tap instead of waiting a device round-trip.
    onMutate: async (body: SeriesUpdate) => {
      await qc.cancelQueries({ queryKey: ["series-detail", detailKey] });
      const prev = qc.getQueryData<SeriesDetailData>(["series-detail", detailKey]);
      if (prev) {
        const next: SeriesDetailData = {
          ...prev,
          settings: {
            ...prev.settings,
            ...(body.rule !== undefined ? { rule: body.rule } : {}),
            ...(body.keep !== undefined
              ? { keep: { rule: body.keep.rule, count: body.keep.count ?? null } }
              : {}),
            ...(body.offsets !== undefined
              ? { offsets: { ...prev.settings.offsets, ...body.offsets } }
              : {}),
            ...(body.channel_path !== undefined
              ? { channel_path: body.channel_path }
              : {}),
          },
        };
        qc.setQueryData(["series-detail", detailKey], next);
      }
      return { prev };
    },
    onError: (_e, _body, ctx) => {
      if (ctx?.prev) qc.setQueryData(["series-detail", detailKey], ctx.prev);
    },
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

  const setKeep = (keep: SeriesUpdate["keep"]) => {
    if (guidePath)
      update.mutate({ identifier, guide_path: guidePath, keep });
  };
  const applyPadding = (s: number, e: number) => {
    if (guidePath)
      update.mutate({ identifier, guide_path: guidePath,
                     offsets: { start: s * 60, end: e * 60 } });
  };
  const setChannel = (channel_path: string | null) => {
    if (guidePath)
      update.mutate({ identifier, guide_path: guidePath, channel_path });
  };
  // Turning a rule off is a confirm (see Issue 2): a scheduled-but-unrecorded
  // series leaves the Recordings list entirely, a recorded one just stops
  // future episodes. Setting a rule (all/new) applies immediately.
  const setRule = (rule: "all" | "new" | "none") => {
    if (!guidePath) return;
    if (rule === "none") {
      // An episode of this series on a tuner right now - any episode, not one
      // shown in this drawer.
      //
      // Measured on a real device 2026-09-18: turning the rule off stopped a
      // recording in flight within twelve seconds, and the ninety seconds
      // already captured stayed in the library as a stub. The wording below
      // ("the episodes already recorded stay") is true and beside the point
      // while a tuner is mid-capture, so that case gets its own question.
      //
      // No offer to keep the episode: rescheduling the airing afterwards does
      // not resume the capture, it starts a second one. A cancelled hour came
      // back as 5m and 55m, two rows in the library. An honest stop beats that.
      const live = recordingForSeries(inProgress, guidePath);
      if (live?.channel_identifier) {
        const so_far = formatDuration(live.recorded_seconds ?? 0);
        setConfirm({
          title: "An episode is recording now.",
          body: `“${live.title ?? "An episode"}” — ${so_far} of `
            + `${formatDuration(live.duration)} captured. Turning the rule off `
            + "stops it at once. What was captured stays in your library; the "
            + "rest is not recorded.",
          confirmLabel: "Stop it",
          danger: true,
          onConfirm: () =>
            update.mutate({ identifier, guide_path: guidePath, rule: "none" }),
        });
        return;
      }
      setConfirm({
        title: `Turn off ${card.title}?`,
        body: hasRecordings
          ? "No more episodes will record. The episodes already recorded stay, and you can still delete them here."
          : "Nothing has recorded yet, so turning the rule off removes this series from your Recordings until you set a rule again.",
        confirmLabel: "Turn off",
        danger: true,
        onConfirm: () => update.mutate({ identifier, guide_path: guidePath, rule: "none" }),
      });
      return;
    }
    update.mutate({ identifier, guide_path: guidePath, rule });
  };


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
                  This series has no guide entry, so its recording rule can't be
                  changed here — you can still clean up episodes below.
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
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-sm font-semibold">Keep</span>
                  <span className="text-[11px] text-fg-muted">
                    {keepValue(settings?.keep) === "auto"
                      ? "Auto-delete oldest"
                      : keepValue(settings?.keep) === "all"
                        ? "Never auto-delete"
                        : "Newest only"}
                  </span>
                </div>
                <select
                  value={keepValue(settings?.keep)}
                  disabled={!canConfigure}
                  onChange={(e) => setKeep(keepFromValue(e.target.value))}
                  aria-label="Keep limit"
                  className="rounded-lg border border-border bg-fill-soft px-2.5 py-1.5 text-sm
                             font-medium text-fg disabled:opacity-50 focus:outline-none
                             focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {keepOptions(settings?.keep).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Channel — pin the rule to one channel, or record on all.
                  Shown only when the series' channels are known. */}
              {(channels.data?.length ?? 0) > 0 && (() => {
                const opts = channels.data ?? [];
                const cur = settings?.channel_path ?? null;
                const withCur = cur && !opts.some((o) => o.path === cur)
                  ? [...opts, { path: cur, call_sign: null, number: null }]
                  : opts;
                const label = (o: { call_sign: string | null; number: string | null }) =>
                  o.call_sign
                    ? `${o.call_sign}${o.number ? ` ${o.number}` : ""}`
                    : o.number ? `Channel ${o.number}` : "Pinned channel";
                return (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-sm font-semibold">Channel</span>
                      <span className="text-[11px] text-fg-muted">
                        {cur ? "One channel only" : "Any channel it airs on"}
                      </span>
                    </div>
                    <select
                      value={cur ?? "all"}
                      disabled={!canConfigure}
                      onChange={(e) =>
                        setChannel(e.target.value === "all" ? null : e.target.value)}
                      aria-label="Channel"
                      className="rounded-lg border border-border bg-fill-soft px-2.5 py-1.5 text-sm
                                 font-medium text-fg disabled:opacity-50 focus:outline-none
                                 focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <option value="all">All channels</option>
                      {withCur.map((o) => (
                        <option key={o.path} value={o.path}>{label(o)}</option>
                      ))}
                    </select>
                  </div>
                );
              })()}

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
                  { value: "episodes", label: "Episodes" },
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
                {/* The count is stated even at zero: "Episodes (0)" is an
                    answer, where a bare "Episodes" over a blank panel looks
                    like something failed to load. */}
                <h3 className="text-sm font-bold">
                  Episodes ({data?.episodes.length ?? 0})
                </h3>
                {/* Nothing to delete, so nothing offering to. */}
                {(data?.episodes.length ?? 0) > 0 && (
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
                )}
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

              {(data?.episodes.length ?? 0) === 0 ? (
                <p className="text-fg-muted p-4 text-center text-sm">
                  Nothing recorded yet.
                </p>
              ) : (
              <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                {(data?.episodes ?? []).map((ep) => (
                  <EpisodeRow
                    key={ep.object_id}
                    ep={ep}
                    checked={selected.has(ep.object_id)}
                    onOpen={() => setSheet({
                      // An episode outlives its listing - the guide is pruned
                      // at 31 days - so the recording is what answers, with
                      // the airing laid over it when one still exists.
                      channel: ep.channel_identifier ?? "",
                      start: ep.datetime,
                      recordingId: ep.object_id,
                    })}
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
              )}
            </section>
            ) : (
              <AiringsPane
                query={tab === "upcoming" ? upcoming : conflicts}
                onOpen={(a) => setSheet({
                  channel: a.channel_identifier!, start: a.datetime,
                })}
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
                    // This footer has its own confirm, so write the rule
                    // directly rather than through setRule's confirm wrapper.
                    if (guidePath)
                      update.mutate({ identifier, guide_path: guidePath, rule: "none" });
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

      {/* The sheet for whichever row was opened, over this panel rather than
          instead of it: closing it lands back here, where the click came
          from. "Back to Series" rather than "Series Information", because the
          series is behind it and not somewhere else to go. */}
      {sheet && (
        <ShowInfo
          channel={sheet.channel}
          start={sheet.start}
          recordingId={sheet.recordingId}
          backToSeries
          onClose={() => {
            setSheet(null);
            // Whatever the sheet did - turned an episode off, changed the
            // rule, deleted a recording - this panel is now describing the
            // state from before it. Re-read rather than guess which.
            qc.invalidateQueries({ queryKey: ["series-detail"] });
            qc.invalidateQueries({ queryKey: ["series-airings"] });
            qc.invalidateQueries({ queryKey: ["series"] });
          }}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ["series-detail"] });
            qc.invalidateQueries({ queryKey: ["series"] });
          }}
          onTune={() => setSheet(null)}
        />
      )}
    </div>
  );
}
