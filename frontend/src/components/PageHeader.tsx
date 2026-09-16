interface Props {
  title: string;
  subtitle: string;
  /** Epoch ms, re-rendered on the parent's minute tick. */
  now: number;
}

/**
 * Title block shared by every tab.
 *
 * Previously each tab rendered its own heading and only Live TV carried the
 * clock, so switching tabs both lost the clock and shifted the content down.
 * One component keeps the height identical across tabs.
 */
export function PageHeader({ title, subtitle, now }: Props) {
  const date = new Date(now);
  return (
    <div className="mb-8 flex items-baseline justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-3xl font-black tracking-tight text-fg mb-2 uppercase italic">{title}</h1>
        <p className="text-fg-muted text-sm font-medium tracking-wide uppercase">{subtitle}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-2xl font-mono text-accent font-bold tabular-nums">
          {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
        <p className="text-[10px] text-fg-muted font-black tracking-widest uppercase">
          {date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
        </p>
      </div>
    </div>
  );
}
