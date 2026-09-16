import { useState } from "react";
import { api } from "../api/tablo";
import { ThemeControl } from "./ThemeControl";

interface Props {
  onSuccess: () => void;
}

export function LoginScreen({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.login(email, password);
      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center p-6"
         style={{ background: "radial-gradient(ellipse at 50% 0%, rgb(var(--c-accent) / 0.08) 0%, transparent 60%)" }}>
      {/* ProfileMenu owns the theme picker once you are signed in, but it never
          mounts before then - so someone who prefers light on a dark machine had
          a dark login screen and no way out. Same control, sized down and parked
          in the corner so it does not compete with the form. */}
      <div className="absolute top-4 right-4">
        <ThemeControl label="Appearance" compact />
      </div>

      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          {/* The tile is a GRAPHIC surface, so it keeps the brand ramp in both
              themes and the glyph takes `brand-fg` - white, 3.58:1 at the worst
              stop, past the 3:1 bar for a non-text graphic. `accent-fg` would be
              wrong here: it is ink in dark, which is a label colour, not a mark. */}
          <div className="accent-gradient inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4">
            <svg className="w-10 h-10 text-brand-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                 strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              {/* Same stadium mark as the app header — see ChannelGrid.tsx. */}
              <rect x="2.97" y="2.75" width="18.06" height="13" rx="6.5" />
              <path d="M12 15.75v5.25" />
              <path d="M8 21h8" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold">Tablo Web</h1>
          <p className="text-fg-muted text-sm mt-1">Sign in with your Tablo account</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-fg-subtle uppercase tracking-wider mb-1.5 block">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
              className="w-full px-4 py-3 rounded-xl bg-surface-raised border border-border
                         text-fg placeholder-fg-faint text-sm
                         focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent
                         transition"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-fg-subtle uppercase tracking-wider mb-1.5 block">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="w-full px-4 py-3 rounded-xl bg-surface-raised border border-border
                         text-fg placeholder-fg-faint text-sm
                         focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent
                         transition"
            />
          </div>

          {error && (
            <p className="text-danger text-sm px-1">{error}</p>
          )}

          {/* Flat `bg-accent`, not the brand gradient that backs the tile above.
              "Sign In" is a text label and has to clear 4.5:1, which nothing does
              against both ramp stops - white measures 3.58:1 at #478cc9 and ink
              3.04:1 at #2c6296. Flat accent carries the label at 6.37:1 in light
              and 5.40:1 in dark, and the tile still shows the gradient. */}
          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full py-3 rounded-xl font-semibold text-sm transition bg-accent text-accent-fg
                       disabled:opacity-40 disabled:cursor-not-allowed
                       hover:opacity-90 active:scale-[0.98]"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-accent-fg/40 border-t-accent-fg rounded-full animate-spin" />
                Connecting…
              </span>
            ) : "Sign In"}
          </button>
        </form>

        <p className="text-center text-fg-muted text-xs mt-8">
          Uses your Tablo account credentials · Runs entirely on your local network
        </p>
      </div>
    </div>
  );
}
