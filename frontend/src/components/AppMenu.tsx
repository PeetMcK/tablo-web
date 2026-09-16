import { useState, useRef, useEffect, useCallback, useId } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api/tablo";
import { ThemeControl } from "./ThemeControl";

interface Props {
  email: string | null;
  onLogout: () => void;
}

/**
 * The app mark, doubling as the settings menu.
 *
 * This was a monogram in the top-right corner, which is the conventional place
 * for an account menu — but the monogram was `email.slice(0, 2)`, the first two
 * characters of the address rather than anything derived from a name, and the
 * app is single-tenant and self-hosted, so there is no second identity for an
 * avatar to disambiguate from. It identified nothing and never could.
 *
 * What the menu actually holds is app settings: appearance, a debug report, and
 * a sign-out that on your own server is close to never used. Settings hanging
 * off the app mark is coherent in a way it would not be in a multi-user
 * product, and it gives the mark — previously inert — something to do.
 *
 * The trade is discoverability: a logo conventionally goes home or does
 * nothing, so nothing about it says "click here to sign out". The chevron is
 * what keeps that from being mystery meat, and is not optional. It is affordable
 * here only because everything behind it is low-frequency.
 */
export function AppMenu({ email, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const themeLabelId = useId();
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Escape and focus return. Without these the menu could be opened by
    // keyboard but not dismissed by it, and a screen reader was never told it
    // had opened at all — the trigger carried no `aria-expanded`.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * Re-read the channel list, then reload.
   *
   * The guide is fed by `useGridStream`, which runs once on mount and is not a
   * react-query cache, so an open grid would keep showing the list the server
   * has just replaced. A reload is near-transparent here — `route.ts` restores
   * the tab and whatever is playing from the hash — and this is a rare
   * maintenance action, which is a better trade than threading a refresh
   * signal from this menu down into the grid.
   */
  const refreshChannels = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.refreshChannels();
      window.location.reload();
    } catch (e) {
      console.error("Channel refresh failed:", e);
      setRefreshing(false);
      setOpen(false);
    }
  }, []);

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

  return (
    // No trailing margin here: the header sets the gap to the nav, and it is
    // the same 4px the tab pills sit apart from each other.
    <div className="relative" ref={ref}>
      {/* A disclosure, not a `role="menu"`: the panel holds a radiogroup and a
          couple of buttons, and `menu` would promise menuitem children it does
          not have. `aria-expanded` carries the state. */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="true"
        aria-label="Tablo-Web menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="group flex items-center -m-1 p-1 rounded-xl hover:bg-fill-soft
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition"
      >
        {/* The brand ramp, via `.accent-gradient` — both stops are the brand's
            own in either theme, since a mark is not a themed surface. */}
        <div className="accent-gradient w-8 h-8 rounded-lg flex items-center justify-center shrink-0 shadow-lg shadow-accent-glow">
          {/* `text-brand-fg`, not `text-accent-fg`: accent-fg is ink in dark (it
              labels flat accent fills), which would vanish into the ramp.
              brand-fg is white in both themes and clears the 3:1 graphic bar at
              the worst stop. */}
          <svg className="w-5 h-5 text-brand-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
               strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            {/* Stadium screen: corner radius is half the height, so both ends
                are true semicircles — the brand mark, wearing a TV stand. */}
            <rect x="2.97" y="2.75" width="18.06" height="13" rx="6.5" />
            <path d="M12 15.75v5.25" />
            <path d="M8 21h8" />
          </svg>
        </div>
        {/* Wordmark and chevron are both gone: the mark alone is the trigger.
            `aria-label` carries the button's name and `aria-expanded` its
            state, so nothing an assistive reader needs went with them. */}
      </button>

      {open && (
        // Anchored left now that the trigger is, rather than right.
        <div
          id={panelId}
          className="absolute left-0 top-12 w-64 rounded-2xl bg-surface-raised border border-border shadow-2xl shadow-shade z-50 overflow-hidden"
        >
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
          </div>

          <div className="p-2">
            <button
              onClick={refreshChannels}
              disabled={refreshing}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-fg-secondary hover:text-fg hover:bg-fill-soft transition text-left disabled:opacity-50 disabled:cursor-wait"
            >
              <RefreshCw className={`w-4 h-4 shrink-0 ${refreshing ? "animate-spin" : ""}`} strokeWidth={2} aria-hidden />
              {refreshing ? "Refreshing…" : "Refresh Channel List"}
            </button>

            <div className="my-1 border-t border-border-subtle" />

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
