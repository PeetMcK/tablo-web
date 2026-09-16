import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTheme, THEME_SETTINGS, THEME_LABELS } from "../lib/theme";

interface Props {
  /** id of a visible label element. Use `label` instead when there is none. */
  labelledBy?: string;
  /** Accessible name for a group with no visible label. */
  label?: string;
  /** Sized down, for the corner of the login and loading screens. */
  compact?: boolean;
}

/**
 * The Light / Dark / System picker.
 *
 * Shared by ProfileMenu and the signed-out screens rather than copied into
 * each: a radio group is arrow-key driven with a roving tabindex, so Tab lands
 * on the group once rather than three times, and that is exactly the sort of
 * small stateful detail that drifts apart once it exists twice.
 */
export function ThemeControl({ labelledBy, label, compact = false }: Props) {
  const { theme, setTheme } = useTheme();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1
      : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (index + step + THEME_SETTINGS.length) % THEME_SETTINGS.length;
    setTheme(THEME_SETTINGS[next]);
    optionRefs.current[next]?.focus();
  }, [setTheme]);

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={compact
        ? "flex gap-0.5 rounded-lg bg-fill-soft p-0.5"
        : "flex gap-1 rounded-xl bg-fill-soft p-1"}
    >
      {THEME_SETTINGS.map((option, index) => {
        const selected = option === theme;
        return (
          <button
            key={option}
            type="button"
            ref={el => { optionRefs.current[index] = el; }}
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setTheme(option)}
            onKeyDown={e => onKeyDown(e, index)}
            className={`${compact ? "rounded-md px-2 py-1 text-[11px]" : "flex-1 rounded-lg px-2 py-1.5 text-xs"}
              font-bold transition ${
              selected
                ? "bg-accent-soft text-accent-strong"
                : "text-fg-muted hover:text-fg hover:bg-fill"
            }`}
          >
            {THEME_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}
