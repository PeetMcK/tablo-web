interface Props {
  title: string;
  /** Omitted where the title already says it. */
  subtitle?: string;
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
 *
 * The subtitle is optional, which costs some of the equal-height property
 * above: Live TV and the Guide now run a line shorter than Library, so moving
 * between them shifts the content by that line. Worth it — both dropped
 * subtitles restated what the heading and the content already said, and the
 * Guide in particular is the tab most starved for vertical space.
 */
export function PageHeader({ title, subtitle }: Props) {
  return (
    <div className="mb-8 min-w-0">
      <h1 className="text-3xl font-black tracking-tight text-fg mb-2 uppercase italic">{title}</h1>
      {subtitle && (
        <p className="text-fg-muted text-sm font-medium tracking-wide uppercase">{subtitle}</p>
      )}
    </div>
  );
}
