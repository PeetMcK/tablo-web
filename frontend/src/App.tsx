import { useState, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, setDirectOrigin } from "./api/tablo";
import { LoginScreen } from "./components/LoginScreen";
import { ChannelGrid } from "./components/ChannelGrid";
import { hydrateResume, flushResume } from "./lib/resume";

const qc = new QueryClient();

function Inner() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api.status()
      .then(s => {
        setAuthed(s.authenticated);
        setDirectOrigin(s.direct_origin);
        // Positions live on the server now. Pull them in - and hand over
        // anything this browser still holds - before anything reads one.
        if (s.authenticated) void hydrateResume();
      })
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    // Writes are batched, so a close or a tab switch must not strand the last
    // position. pagehide fires in cases unload does not, notably on iOS.
    const flush = () => flushResume();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      flushResume();
    };
  }, []);

  const logout = async () => {
    await api.logout().catch(() => {});
    qc.clear();
    setAuthed(false);
  };

  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!authed) return <LoginScreen onSuccess={() => setAuthed(true)} />;

  return <ChannelGrid onLogout={logout} />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <Inner />
    </QueryClientProvider>
  );
}
