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
    /* One capsule, two cells, and a line between them.
       `items-stretch` with no height on the cells themselves is what makes a
       half's fill run floor to ceiling: two loose buttons with a gap between
       them read as two controls that happen to be adjacent, and a hover that
       stopped short of the edges kept saying so. `overflow-hidden` is what
       lets the cells stay square-cornered while the capsule is round — the
       clip supplies the outer radius, so the fill reaches into the corners
       instead of leaving four lit crumbs outside a rounded chip. */
    <div
      role="radiogroup"
      aria-label="Search mode"
      className="absolute left-1.5 top-1/2 -translate-y-1/2 h-8 flex items-stretch
                 rounded-lg border border-border overflow-hidden"
    >
      {MODES.map(({ value: mode, name, hint, Icon }, i) => {
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
            /* The divider is the first cell's right edge rather than an
               element of its own, so it is exactly as tall as the cells are
               and cannot drift out of step with them.

               `ring-inset` because the capsule clips its children: an outset
               focus ring would be shaved off on three sides.

               `fill-strong` for the selected half, not `accent-soft`: the
               brand blue at 15% over this near-black bar lifts a chip barely
               above the background, which is what made the selected tab read
               as having no indicator (see the nav above). White at the same
               alpha lifts; the glyph stays `accent-strong`, so a selected
               half still differs from a hovered one by hue and not only by
               brightness. */
            className={`px-2 flex items-center justify-center transition
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-inset
                        focus-visible:ring-accent
                        ${i === 0 ? "border-r border-border" : ""}
                        ${disabled
                          ? "text-fg-subtle cursor-not-allowed"
                          : checked
                            ? "bg-fill-strong text-accent-strong"
                            : "text-fg-muted hover:text-fg-secondary hover:bg-fill"}`}
          >
            <Icon className="w-4 h-4" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
