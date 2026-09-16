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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-surface-raised border border-white/10 shadow-2xl shadow-black/60 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {danger && (
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" aria-hidden />
          )}
          <div className="min-w-0">
            <h2 className="text-base font-bold text-white leading-snug">{title}</h2>
            {body && <p className="mt-2 text-sm text-white/50 leading-relaxed">{body}</p>}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-white/60
                       hover:text-white hover:bg-white/5 transition"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={() => { onConfirm(); onClose(); }}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition
              focus:outline-none focus:ring-2 focus:ring-offset-0
              ${danger
                ? "bg-red-500/90 text-white hover:bg-red-500 focus:ring-red-400/50"
                : "accent-gradient text-white hover:opacity-90 focus:ring-accent/50"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
