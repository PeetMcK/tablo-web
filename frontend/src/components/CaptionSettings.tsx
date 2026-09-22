/**
 * The caption settings panel, on the CC button's secondary click.
 *
 * Secondary rather than primary because the button already has a job and it
 * is the one people want: click turns captions on and off. The settings are
 * the rarer errand, so they go where a rarer errand goes — a right-click, or
 * a long press for anyone without a right button.
 *
 * Two choices, and they are independent. Placement is the one viewers
 * disagree about; standard is mostly a way to find out which decoder is at
 * fault without leaving the picture.
 */

import { useEffect, useRef } from "react";

import type {
  CaptionPlacement, CaptionPreferences, CaptionStandardChoice,
} from "../lib/captions/preferences";

const PLACEMENTS: Array<{ value: CaptionPlacement; label: string; hint: string }> = [
  {
    value: "broadcast",
    label: "As broadcast",
    hint: "Follows the window the broadcaster sent",
  },
  {
    value: "bottom",
    label: "Bottom center",
    hint: "Always the same place",
  },
];

const STANDARDS: Array<{ value: CaptionStandardChoice; label: string; hint: string }> = [
  { value: "auto", label: "Auto", hint: "Whichever the channel carries" },
  { value: "cea608", label: "CEA-608", hint: "The older standard" },
  { value: "cea708", label: "CEA-708", hint: "The newer one" },
];

export function CaptionSettings({
  preferences, onChange, onClose,
}: {
  preferences: CaptionPreferences;
  onChange: (next: CaptionPreferences) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Escape closes it, and so does clicking anywhere else — including on
    // the picture, where a click would otherwise reach the player and pause
    // what you are watching.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    const onPointer = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel && !panel.contains(event.target as Node)) onClose();
    };
    // The document this panel is in, which in the picture-in-picture pop-out
    // is not the tab's - listening on the tab's would leave the panel deaf to
    // every key and click in the window it is actually showing in.
    const host = panelRef.current?.ownerDocument ?? document;
    host.addEventListener("keydown", onKey, true);
    // Captured, and on the next tick: the click that opened this panel is
    // still travelling and would otherwise close it again immediately.
    const timer = setTimeout(() => {
      host.addEventListener("pointerdown", onPointer, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      host.removeEventListener("keydown", onKey, true);
      host.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose]);

  const group = <T extends string>(
    title: string,
    options: Array<{ value: T; label: string; hint: string }>,
    current: T,
    pick: (value: T) => void,
  ) => (
    <div className="px-1 py-1.5">
      <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide
                      text-player-fg/60">
        {title}
      </div>
      {options.map((option) => (
        <button
          key={option.value}
          role="menuitemradio"
          aria-checked={current === option.value}
          onClick={(event) => { event.stopPropagation(); pick(option.value); }}
          className={`w-full rounded px-2 py-1.5 text-left transition
            hover:bg-fill ${current === option.value ? "bg-fill" : ""}`}
        >
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-block h-2 w-2 shrink-0 rounded-full
                ${current === option.value ? "bg-player-fg" : "bg-player-fg/25"}`}
            />
            <span className="text-sm text-player-fg">{option.label}</span>
          </span>
          <span className="block pl-4 text-[11px] text-player-fg/55">{option.hint}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label="Caption settings"
      onClick={(event) => event.stopPropagation()}
      /* Sized to the window it is in, which in the pop-out is small: a panel
         taller than its window is clipped at the top, and the first thing
         clipped is the heading that says what the choices are for. `vh` here
         is the pop-out's own viewport, since this is rendered in that
         document. */
      className="absolute bottom-full right-0 mb-2 w-56 max-w-[calc(100vw-1rem)]
                 max-h-[70vh] overflow-y-auto overscroll-contain rounded-lg glass
                 shadow-lg ring-1 ring-white/10 divide-y divide-white/10
                 pointer-events-auto z-20"
    >
      {group("Placement", PLACEMENTS, preferences.placement,
        (placement) => onChange({ ...preferences, placement }))}
      {group("Captions from", STANDARDS, preferences.standard,
        (standard) => onChange({ ...preferences, standard }))}
    </div>
  );
}
