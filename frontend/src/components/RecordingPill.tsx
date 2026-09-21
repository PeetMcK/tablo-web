/**
 * The "● RECORDING" badge — one bold red pill with a pulsing dot, so a file
 * still being written reads the same on a Library card, a Recordings series
 * card, and a drawer episode row.
 *
 * The pulse is the only motion and it stops under `prefers-reduced-motion`,
 * where the solid dot alone still reads as recording.
 */

export function RecordingPill({
  label = "Recording",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={
        "inline-flex items-center gap-1.5 px-2 py-1 rounded bg-danger-solid " +
        "text-[10px] font-bold text-danger-fg uppercase tracking-wider " + className
      }
    >
      <span className="relative flex w-2 h-2" aria-hidden>
        <span className="motion-safe:animate-ping absolute inline-flex w-full h-full rounded-full bg-danger-fg opacity-60" />
        <span className="relative inline-flex w-2 h-2 rounded-full bg-danger-fg" />
      </span>
      {label}
    </div>
  );
}
