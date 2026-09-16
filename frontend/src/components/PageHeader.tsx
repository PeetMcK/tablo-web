interface Props {
  title: string;
  subtitle: string;
}

/**
 * Title block shared by every tab.
 *
 * Previously each tab rendered its own heading and only Live TV carried the
 * clock, so switching tabs both lost the clock and shifted the content down.
 * One component keeps the height identical across tabs.
 *
 * The clock has since moved to the bar (see HeaderClock). It scrolled away with
 * this block, and on the Guide that is the one reading it cannot afford to
 * lose: the red NOW line means nothing without the time it is measured from.
 * Keeping this block on the Guide is still right, though — dropping it there
 * would buy height back at the cost of the cross-tab shift the paragraph above
 * describes, which is the problem this component exists to solve.
 */
export function PageHeader({ title, subtitle }: Props) {
  return (
    <div className="mb-8 min-w-0">
      <h1 className="text-3xl font-black tracking-tight text-fg mb-2 uppercase italic">{title}</h1>
      <p className="text-fg-muted text-sm font-medium tracking-wide uppercase">{subtitle}</p>
    </div>
  );
}
