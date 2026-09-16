import { useState, useRef, useEffect, useCallback, useId } from "react";
import { api } from "../api/tablo";
import { useTheme, THEME_LABELS } from "../lib/theme";
import { ThemeControl } from "./ThemeControl";

interface Props {
  email: string | null;
  onLogout: () => void;
}

export function ProfileMenu({ email, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const themeLabelId = useId();
  const { theme, resolvedTheme } = useTheme();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const generateDebugReport = useCallback(async () => {
    setGenerating(true);
    try {
      const serverReport = await api.debugReport().catch((e) => ({ error: String(e) }));
      const report = {
        generated_at: new Date().toISOString(),
        browser: {
          user_agent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
          screen: `${screen.width}x${screen.height}`,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          online: navigator.onLine,
        },
        server: serverReport,
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tablo-debug-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setGenerating(false);
      setOpen(false);
    }
  }, []);

  const initials = email
    ? email.slice(0, 2).toUpperCase()
    : "?";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-black text-fg-secondary hover:text-fg transition border border-border hover:border-border-medium bg-fill-soft hover:bg-fill"
        title="Account"
      >
        {initials}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-64 rounded-2xl bg-surface-raised border border-border shadow-2xl shadow-shade z-50 overflow-hidden">
          {email && (
            <div className="px-4 py-3 border-b border-border-subtle">
              {/* 10px is nowhere near WCAG's "large text" threshold, so these
                  section labels are body text and need the fg-muted rung -
                  fg-faint measured 3.70:1 light / 3.63:1 dark on this card. */}
              <p className="text-[10px] font-black text-fg-muted uppercase tracking-widest mb-0.5">Signed in as</p>
              <p className="text-sm font-semibold text-fg-secondary truncate">{email}</p>
            </div>
          )}

          <div className="px-4 py-3 border-b border-border-subtle">
            <p className="text-[10px] font-black text-fg-muted uppercase tracking-widest mb-1.5" id={themeLabelId}>
              Appearance
            </p>
            <ThemeControl labelledBy={themeLabelId} />
            <p className="mt-1.5 text-[10px] font-medium text-fg-muted">
              {theme === "system"
                ? `Following your system · ${THEME_LABELS[resolvedTheme].toLowerCase()}`
                : `Always ${THEME_LABELS[theme].toLowerCase()}`}
            </p>
          </div>

          <div className="p-2">
            <button
              onClick={generateDebugReport}
              disabled={generating}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-fg-secondary hover:text-fg hover:bg-fill-soft transition text-left disabled:opacity-50 disabled:cursor-wait"
            >
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {generating ? "Generating…" : "Download Debug Report"}
            </button>

            <div className="my-1 border-t border-border-subtle" />

            <button
              onClick={() => { setOpen(false); onLogout(); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-danger hover:bg-danger-soft transition text-left"
            >
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
