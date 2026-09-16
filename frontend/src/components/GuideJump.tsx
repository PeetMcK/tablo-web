import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronDown } from "lucide-react";

import { DAYPARTS, type JumpDay } from "../lib/guideJump";

interface Props {
  /** Days the guide covers, each with a cell per daypart. */
  days: JumpDay[];
  /** Where the guide is now, e.g. "Thu · Prime". */
  label: string;
  onJump: (at: number) => void;
  onNow: () => void;
}

/**
 * Jump the guide to a day and a stretch of it, or back to the live edge.
 *
 * The way back is a control of its own rather than an entry in the popover:
 * wherever scrolling has gone, returning to now must not start with opening
 * something. It carries the now-line's red so the two read as one idea.
 */
export function GuideJump({ days, label, onJump, onNow }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Bound only while open: a listener that lives for the life of the guide
  // would run on every click in the app to answer a question nobody asked.
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
    <div ref={root} className="relative flex items-center gap-2 shrink-0">
      <button
        onClick={onNow}
        title="Back to what is on now"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-extrabold
                   tracking-wide bg-danger-soft border border-danger/30 text-danger
                   hover:bg-danger/15 transition"
      >
        {/* The same red as the now-line this returns to, which is what ties the
            two together - and the one colour in the toolbar that is allowed to
            be red, because it points at the live edge rather than at deletion. */}
        <span
          className="w-1.5 h-1.5 rounded-full bg-danger-solid"
          style={{ boxShadow: "0 0 8px rgb(var(--c-danger-solid) / 0.8)" }}
          aria-hidden
        />
        NOW
      </button>

      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold
                   glass text-fg hover:bg-fill transition"
      >
        <Calendar className="w-3.5 h-3.5 text-accent" strokeWidth={2.5} aria-hidden />
        <span>{label}</span>
        <ChevronDown className="w-3 h-3 text-fg-faint" strokeWidth={3} aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Jump to a day and time"
          className="absolute top-full right-0 mt-2 z-40 w-[340px] p-4 rounded-2xl
                     bg-surface-overlay border border-border shadow-2xl shadow-shade"
        >
          <div className="grid grid-cols-[76px_repeat(4,minmax(0,1fr))] gap-1.5 mb-2">
            <div />
            {DAYPARTS.map(p => (
              <div key={p.id} className="flex flex-col items-center gap-px">
                <span className="text-[9px] font-black uppercase tracking-widest text-fg-muted">
                  {p.label}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            {days.map(day => (
              <div key={day.key} className="grid grid-cols-[76px_repeat(4,minmax(0,1fr))] gap-1.5 items-center">
                <div className="flex flex-col">
                  <span className="text-[11px] font-extrabold text-fg-secondary">{day.label}</span>
                  <span className="text-[9px] font-semibold text-fg-faint tabular-nums">{day.date}</span>
                </div>
                {day.cells.map(cell => {
                  // A stretch that cannot be reached is a disabled button, not
                  // a styled div: "there is nothing here" is something a screen
                  // reader has to be told, not only shown.
                  const dead = cell.state === "past" || cell.state === "empty";
                  return (
                    <button
                      key={cell.part.id}
                      disabled={dead}
                      onClick={() => { onJump(cell.at); setOpen(false); }}
                      aria-label={`${day.label} ${day.date}, ${cell.part.label}`}
                      className={`h-[34px] rounded-lg text-[10px] font-bold tracking-wide transition
                        ${cell.state === "live"
                          ? "bg-accent text-accent-fg font-extrabold shadow-lg shadow-accent-glow"
                          : cell.state === "listed"
                            ? "bg-fill-soft text-fg-muted hover:bg-fill hover:text-fg"
                            : "text-fg-disabled cursor-default"}`}
                    >
                      {cell.state === "empty" ? "—" : cell.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <p className="mt-3 pt-3 border-t border-border-subtle text-[10px] text-fg-faint">
            Each cell scrolls the guide to that hour.
          </p>
        </div>
      )}
    </div>
  );
}
