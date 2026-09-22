import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";

interface Props {
  value: ContentFilter;
  onChange: (next: ContentFilter) => void;
}

/**
 * The content filters, as one control. The only one — Live, Guide and Library
 * all use this, at every width.
 *
 * It began as the phone's answer to a row of eight chips that needed 810px and
 * overflowed: below that width they became this. The row is gone now. Eight
 * chips cost a full line of every page to say what the trigger says in 120px,
 * and offered eight decisions where there is one — so the narrow window's
 * answer turned out to be the right answer everywhere.
 *
 * Deliberately the same pill-and-popover as the date jump beside it in the
 * guide: two idioms for one job read as two unrelated things. It keeps each
 * filter's icon, which a native `select` cannot.
 */
export function ContentFilterMenu({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const active = CONTENT_FILTERS.find(f => f.id === value) ?? CONTENT_FILTERS[0];

  // Bound only while open, as in GuideJump: a listener that lives for the life
  // of the guide would run on every click in the app to answer a question
  // nobody asked.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="touch-target justify-center flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold
                   glass text-fg hover:bg-fill transition"
      >
        <active.Icon className="w-3.5 h-3.5 text-accent" strokeWidth={2.5} aria-hidden />
        <span>{active.label}</span>
        <ChevronDown className="w-3 h-3 text-fg-faint" strokeWidth={3} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Filter by content"
          /* Left-aligned, unlike the jump popover's right: this control sits at
             the left end of the toolbar, and a right-aligned panel would hang
             off the screen at the only width this is shown. */
          className="absolute top-full left-0 mt-2 z-40 w-48 p-1.5 rounded-2xl
                     bg-surface-overlay border border-border shadow-2xl shadow-shade"
        >
          {CONTENT_FILTERS.map(f => {
            const on = f.id === value;
            return (
              <button
                key={f.id}
                role="menuitemradio"
                aria-checked={on}
                onClick={() => { onChange(f.id); setOpen(false); }}
                className={`touch-target w-full flex items-center gap-2 px-2.5 py-2 rounded-xl
                            text-xs font-bold tracking-wide text-left transition
                  ${on
                    ? "bg-accent text-accent-fg"
                    : "text-fg-muted hover:bg-fill-soft hover:text-fg"}`}
              >
                <f.Icon className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />
                <span>{f.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
