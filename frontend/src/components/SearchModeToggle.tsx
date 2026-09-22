/**
 * Which job the topbar's one box is doing.
 *
 * It lives inside the field's left cap, where a lone decorative spyglass used
 * to sit, because the mode belongs to the box and a switch parked beside it
 * would read as a third control on a row that already has too many.
 *
 * The glyph is the state — a funnel means "this is narrowing the page", a
 * spyglass means "this goes and finds things" — so the act is in the
 * accessible name and the tooltip rather than in the icon.
 *
 * `onMouseDown` is prevented on both halves for the same reason the results
 * dropdown does it: the field's own `onBlur` would otherwise land first, take
 * the dropdown down under the pointer and drop the caret out of the box the
 * switch was just aimed at.
 */
import { Funnel, Search } from "lucide-react";

import type { TopbarMode } from "../lib/topbarMemory";

/**
 * Spyglass first, because it is the half that was already here: the box has
 * worn a spyglass in this exact spot since it was only a search, and moving
 * the familiar glyph to make room for the new one would charge everyone a
 * relearn for a feature half of them did not ask for. The funnel is still the
 * default selection — narrowing the page is the more common errand — so the
 * pair opens with its right half lit.
 */
const MODES = [
  {
    value: "search" as const,
    name: "Search everything",
    hint: "Search programs, channels and recordings",
    Icon: Search,
  },
  {
    value: "filter" as const,
    name: "Filter this page",
    hint: "Narrow what is on this page",
    Icon: Funnel,
  },
];

export function SearchModeToggle({
  value, onChange, filterDisabled,
}: {
  value: TopbarMode;
  onChange: (next: TopbarMode) => void;
  /** True on a tab with nothing to narrow, where the funnel greys out. */
  filterDisabled: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Search mode"
      className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5"
    >
      {MODES.map(({ value: mode, name, hint, Icon }) => {
        const disabled = filterDisabled && mode === "filter";
        // Greyed out, the funnel cannot be the checked one even while it is
        // still the stored mode — the box really is searching while you are
        // here, and saying otherwise would be a lie told to a screen reader.
        const checked = filterDisabled ? mode === "search" : value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={name}
            title={hint}
            disabled={disabled}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onChange(mode)}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
                        ${disabled
                          ? "text-fg-subtle cursor-not-allowed"
                          : checked
                            ? "bg-accent-soft text-accent-strong"
                            : "text-fg-muted hover:text-fg-secondary hover:bg-fill"}`}
          >
            <Icon className="w-4 h-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
