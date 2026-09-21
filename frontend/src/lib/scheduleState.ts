/**
 * How an upcoming airing's record state reads in the UI. Shared by the
 * cross-series Schedule grid and the per-series drawer, so a "skipped" rerun
 * looks the same everywhere.
 *
 * The device's `schedule.state` is one of: `scheduled` (will record),
 * `skipped` (won't — see `skip_reason`), `unscheduled` (this episode turned
 * off on its own, under a rule that still records the rest), `conflicted`
 * (wanted, tuner clash), `recording` (in progress now), or `none`.
 */

/** The filterable buckets a viewer toggles on the Schedule grid. `recording`
 *  is always shown, so it is not a toggle group. */
export type ScheduleGroup = "scheduled" | "airing" | "conflict";

export interface StateMarker {
  /** Which toggle bucket this row belongs to (null = always shown). */
  group: ScheduleGroup | null;
  label: string;
  /** Tailwind classes for the status pill, from semantic tokens. */
  className: string;
}

/** Human label for why an airing won't record. */
export function skipLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "not_new":
      return "Rerun";
    case "manual":
      return "Skipped";
    default:
      return "Won't record";
  }
}

export function stateMarker(
  state: string | null | undefined,
  skipReason?: string | null,
): StateMarker {
  switch (state) {
    case "scheduled":
      return {
        group: "scheduled",
        label: "Scheduled",
        className: "bg-accent-soft text-accent-strong",
      };
    case "recording":
      return {
        group: null,
        label: "Recording",
        className: "bg-success-soft text-success",
      };
    case "conflicted":
      return {
        group: "conflict",
        label: "Conflict",
        className: "bg-danger-soft text-danger",
      };
    case "skipped":
      return {
        group: "airing",
        label: skipLabel(skipReason),
        className: "bg-fill text-fg-muted",
      };
    // Turned off on its own: the series still records, this one will not.
    // It read as the bare "Airing" default, which says when it is on and
    // nothing about whether it will be kept.
    case "unscheduled":
      return {
        group: "airing",
        label: "Won't record",
        className: "bg-fill text-fg-muted",
      };
    default:
      return {
        group: "airing",
        label: "Airing",
        className: "bg-fill text-fg-muted",
      };
  }
}
