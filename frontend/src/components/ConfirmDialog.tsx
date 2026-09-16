import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

export interface Confirmation {
  title: string;
  body?: string;
  /** Label for the affirmative action. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Styles the action as destructive and warns in the body. */
  danger?: boolean;
  onConfirm: () => void;
}

interface Props {
  confirmation: Confirmation | null;
  onClose: () => void;
}

/**
 * In-app confirmation.
 *
 * Replaces `window.confirm`, which renders as a browser chrome dialog with the
 * origin in its title, ignores the app's styling, and blocks the main thread.
 */
export function ConfirmDialog({ confirmation, onClose }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirmation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Focus the action so the dialog is operable from the keyboard alone.
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmation, onClose]);

  if (!confirmation) return null;
  const { title, body, confirmLabel = "Confirm", danger, onConfirm } = confirmation;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim backdrop-blur-sm p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-surface-raised border border-border shadow-2xl shadow-shade p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {danger && (
            <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" aria-hidden />
          )}
          <div className="min-w-0">
            <h2 className="text-base font-bold text-fg leading-snug">{title}</h2>
            {body && <p className="mt-2 text-sm text-fg-subtle leading-relaxed">{body}</p>}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-fg-muted
                       hover:text-fg hover:bg-fill-soft transition"
          >
            Cancel
          </button>
          {/* `outline-none` makes the ring the only focus indicator, so it has to
              carry 3:1 on its own. At /50 it washed out to ~2.1:1 against the
              dialog; the full token measures 5.1:1 (accent) and 6.0:1 (danger). */}
          <button
            ref={confirmRef}
            onClick={() => { onConfirm(); onClose(); }}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition
              focus:outline-none focus:ring-2 focus:ring-offset-0
              ${danger
                ? "bg-danger-solid text-danger-fg hover:brightness-90 focus:ring-danger"
                : "bg-accent text-accent-fg hover:opacity-90 focus:ring-accent"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
