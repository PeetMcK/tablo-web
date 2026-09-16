interface Props {
  /** Epoch ms, re-rendered on the shell's minute tick. */
  now: number;
}

/**
 * Wall clock in the top bar.
 *
 * It used to live in PageHeader, which scrolls with the page. On the Guide that
 * is the one reading that must never leave: the red NOW line is a position on a
 * timeline, and without the time it is measured from it says nothing. Putting
 * it in the bar fixes that for every tab at once.
 *
 * Sized for a 72px bar rather than a title block, so the time is `text-sm`
 * rather than `text-2xl`. Deliberately `text-fg` and not `text-accent`: the bar
 * already spends the accent on the active nav pill, and a second accent item
 * two elements away reads as a second selection.
 *
 * `tabular-nums` so the minute changing does not shift the date under it.
 */
export function HeaderClock({ now }: Props) {
  const date = new Date(now);
  return (
    <div className="text-right shrink-0 leading-tight">
      <p className="text-sm font-mono font-bold tabular-nums text-fg">
        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </p>
      <p className="text-[10px] text-fg-muted font-black tracking-widest uppercase">
        {date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
      </p>
    </div>
  );
}
