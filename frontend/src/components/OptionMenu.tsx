import { useEffect, useRef, useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

export interface MenuOption<T extends string> {
  id: T;
  label: string;
  Icon: LucideIcon;
}

interface Props<T extends string> {
  /** Named for what it chooses, e.g. "Filter by content". Labels the popover
   *  and, prefixed to the current choice, the trigger. */
  label: string;
  options: MenuOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Which edge the popover hangs from. Right for a control near the right
   *  edge of its row, where a left-aligned panel would run off the screen. */
  align?: "left" | "right";
  /** A word in front of the choice on the trigger, e.g. "Sort". Two menus side
   *  by side otherwise read as two unrelated words — "Day" and "Newest" say
   *  nothing about which is which. */
  prefix?: string;
}

/**
 * One choice from a short list, as a pill and a popover.
 *
 * The app's single idiom for this: the content filter, the Library's sort and
 * its grouping are all this component, and the guide's date jump is the same
 * shape by hand. Three copies of a popover would be three places to fix a
 * focus bug.
 *
 * A native `select` would be less code and worse: it cannot carry an icon per
 * option, and these lists are read as much by their icons as their words.
 */
export function OptionMenu<T extends string>({
  label, options, value, onChange, align = "left", prefix,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const active = options.find(o => o.id === value) ?? options[0];

  // Bound only while open, as in GuideJump: a listener that lives for the life
  // of the page would run on every click in the app to answer a question
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
        // The accessible name says what this chooses as well as what is
        // chosen: three pills reading "All", "Day" and "Newest" are three
        // unlabelled words to anything that cannot see their icons.
        aria-label={`${label}: ${active.label}`}
        className="touch-target justify-center flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold
                   glass text-fg hover:bg-fill transition"
      >
        <active.Icon className="w-3.5 h-3.5 text-accent" strokeWidth={2.5} aria-hidden />
        {prefix && <span className="text-fg-muted font-semibold">{prefix}</span>}
        <span>{active.label}</span>
        <ChevronDown className="w-3 h-3 text-fg-faint" strokeWidth={3} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute top-full mt-2 z-40 w-48 p-1.5 rounded-2xl
                      bg-surface-overlay border border-border shadow-2xl shadow-shade
                      ${align === "right" ? "right-0" : "left-0"}`}
        >
          {options.map(o => {
            const on = o.id === value;
            return (
              <button
                key={o.id}
                role="menuitemradio"
                aria-checked={on}
                onClick={() => { onChange(o.id); setOpen(false); }}
                className={`touch-target w-full flex items-center gap-2 px-2.5 py-2 rounded-xl
                            text-xs font-bold tracking-wide text-left transition
                  ${on
                    ? "bg-accent text-accent-fg"
                    : "text-fg-muted hover:bg-fill-soft hover:text-fg"}`}
              >
                <o.Icon className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />
                <span>{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
