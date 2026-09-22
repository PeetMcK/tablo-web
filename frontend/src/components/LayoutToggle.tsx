/**
 * Cards or rows, as a segmented pair beside Group and Sort.
 *
 * Not a third `OptionMenu`: those two answer questions with several answers
 * each and need their words on the trigger, where this is one binary that two
 * icons state outright — and a third pill of the same width would crowd a
 * toolbar row that already wraps at phone width.
 *
 * Each half is a real toggle rather than a radio: `aria-pressed` says which
 * layout is in force, so the control reads correctly without sight of the
 * icons, and the labels are there for that reader rather than hidden entirely.
 */
import { LIBRARY_LAYOUTS, type LibraryLayout } from "../lib/libraryLayout";

interface Props {
  value: LibraryLayout;
  onChange: (next: LibraryLayout) => void;
}

export function LayoutToggle({ value, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Layout"
      data-layout-toggle
      className="flex items-center gap-0.5 p-0.5 rounded-xl bg-fill-soft border border-border-subtle"
    >
      {LIBRARY_LAYOUTS.map(({ id, label, Icon }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            title={`${label} layout`}
            // The one already in force does nothing: the preference is stored
            // server-side, and a write per click would be a round trip that
            // changes nothing.
            onClick={() => { if (!active) onChange(id); }}
            className={`touch-target flex items-center justify-center w-8 h-8 rounded-lg transition
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
                        ${active
                          ? "bg-fill-strong text-fg"
                          : "text-fg-muted hover:bg-fill hover:text-fg"}`}
          >
            <Icon className="w-4 h-4" aria-hidden />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
