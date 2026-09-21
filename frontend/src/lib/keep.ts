/**
 * The "Keep" limit — how many recordings a series holds before auto-deleting
 * the oldest. The device model is `keep.rule` ∈ `none | all | count` (+`count`);
 * the Tablo apps present that as Auto / Last N Episodes / All Episodes, so this
 * is the one place that translates between the two.
 *
 *   none        ↔ "Auto"          (the Auto-Delete default)
 *   count + N   ↔ "Last N Episodes" (N=1 reads "Last Episode")
 *   all         ↔ "All Episodes"   (never auto-delete)
 */
export type Keep = { rule: string; count: number | null };

/** Count presets the dropdown offers, matching the Tablo app. */
export const KEEP_COUNTS = [1, 3, 5, 10, 20];

/** A stable string key for a keep setting, used as the <select> value. */
export function keepValue(keep: Keep | undefined): string {
  if (!keep || keep.rule === "none") return "auto";
  if (keep.rule === "all") return "all";
  if (keep.rule === "count" && keep.count != null) return `count:${keep.count}`;
  return "auto";
}

/** Turn a <select> value back into a settings-write keep shape. */
export function keepFromValue(
  value: string,
): { rule: "all" | "none" | "count"; count?: number } {
  if (value === "auto") return { rule: "none" };
  if (value === "all") return { rule: "all" };
  const n = Number(value.slice("count:".length));
  return { rule: "count", count: Number.isFinite(n) ? n : 1 };
}

/** Full label for a count: "Last Episode" for 1, "Last N Episodes" otherwise. */
export function countLabel(n: number): string {
  return n === 1 ? "Last Episode" : `Last ${n} Episodes`;
}

/** The dropdown's options for a given current keep — always the presets, plus
 *  the current custom count if it isn't one of them. */
export function keepOptions(keep: Keep | undefined): { value: string; label: string }[] {
  const counts = [...KEEP_COUNTS];
  if (keep?.rule === "count" && keep.count != null && !counts.includes(keep.count)) {
    counts.push(keep.count);
    counts.sort((a, b) => a - b);
  }
  return [
    { value: "auto", label: "Auto" },
    ...counts.map((n) => ({ value: `count:${n}`, label: countLabel(n) })),
    { value: "all", label: "All Episodes" },
  ];
}

/** Short label for a card badge: "Auto" / "Last 5" / "All". */
export function keepLabel(keep: Keep | undefined): string {
  if (!keep || keep.rule === "none") return "Auto";
  if (keep.rule === "all") return "All";
  if (keep.rule === "count" && keep.count != null)
    return keep.count === 1 ? "Last ep" : `Last ${keep.count}`;
  return "Auto";
}
