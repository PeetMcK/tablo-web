import { useState, useEffect, useRef, useCallback } from "react";
import { api, type GuideChannel, type GridChannel } from "../api/tablo";
import { ChannelCard } from "./ChannelCard";
import { VideoPlayer } from "./VideoPlayer";
import { Inbox, Search } from "lucide-react";
import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { LibraryView } from "./LibraryView";
import { GuideGridView } from "./GuideGridView";
import { ProfileMenu } from "./ProfileMenu";
import { PageHeader } from "./PageHeader";

function useGuideStream(enabled: boolean) {
  const [channels, setChannels] = useState<GuideChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const channelsRef = useRef<GuideChannel[]>([]);

  useEffect(() => { channelsRef.current = channels; }, [channels]);

  const startStream = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Seed from existing data so cards stay visible during refresh
    const map = new Map<string, GuideChannel>(channelsRef.current.map(c => [c.identifier, c]));
    if (map.size === 0) setLoading(true);

    try {
      for await (const ch of api.guideStream(controller.signal)) {
        if (controller.signal.aborted) break;
        // Preserve existing logo/program when incoming row is a bare stub (Phase 1)
        const existing = map.get(ch.identifier);
        map.set(ch.identifier, {
          ...ch,
          logo_url: ch.logo_url ?? existing?.logo_url ?? null,
          current_program: ch.current_program ?? existing?.current_program ?? null,
        });
        setChannels([...map.values()]);
        setLoading(false);
      }
    } catch (e) {
      if (!controller.signal.aborted) console.error("Guide stream error:", e);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    void startStream();
    // 5 min — aligns with backend 10-min cache; programs are at minimum 30 min
    const interval = setInterval(() => void startStream(), 300_000);

    return () => {
      abortRef.current?.abort();
      clearInterval(interval);
    };
  }, [enabled, startStream]);

  return { channels, loading };
}

interface Props {
  onLogout: () => void;
}

type Tab = "live" | "grid" | "library";


function matchesContentFilter(ch: GuideChannel, f: ContentFilter): boolean {
  if (f === "all") return true;
  if (f === "ota")  return ch.kind === "ota";
  if (f === "fast") return ch.kind === "ott";
  const prog = ch.current_program;
  if (!prog) return false;
  const genres = prog.genres ?? [];
  if (f === "movies")       return prog.kind === "movieAiring";
  if (f === "sports")       return prog.kind === "sportEvent" || genres.some(g => /sport/i.test(g));
  if (f === "news")         return genres.some(g => /news/i.test(g));
  if (f === "reality")      return genres.some(g => /reality/i.test(g));
  if (f === "documentary")  return genres.some(g => /documentary/i.test(g));
  return true;
}

export function ChannelGrid({ onLogout }: Props) {
  const [playing, setPlaying] = useState<GuideChannel | null>(null);
  const [filter, setFilter] = useState("");
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
  const [activeTab, setTab] = useState<Tab>("live");
  const [now, setNow] = useState(() => Date.now());
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    api.status().then(s => setUserEmail(s.email)).catch(() => {});
  }, []);

  const { channels, loading: isLoading } = useGuideStream(activeTab === "live");

  const filtered = channels.filter(ch => {
    if (!matchesContentFilter(ch, contentFilter)) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      ch.call_sign.toLowerCase().includes(q) ||
      ch.network.toLowerCase().includes(q) ||
      ch.display_name.toLowerCase().includes(q) ||
      (ch.current_program?.title?.toLowerCase().includes(q) ?? false)
    );
  });

  const handlePlay = (ch: GuideChannel | GridChannel) => {
    const isGrid = 'airings' in ch;
    const guideCh: GuideChannel = {
      identifier: ch.identifier,
      call_sign: ch.call_sign,
      major: ch.major,
      minor: ch.minor,
      network: ch.network,
      kind: ch.kind,
      display_name: ch.display_name,
      logo_url: ch.logo_url,
      current_program: isGrid ? (ch as GridChannel).airings[0] : (ch as GuideChannel).current_program
    };
    setPlaying(guideCh);
  };

  return (
    <>
      {playing && (
        <VideoPlayer
          key={playing.identifier}
          source={{
            kind: "live",
            channel: {
              identifier: playing.identifier,
              call_sign: playing.call_sign,
              major: playing.major,
              minor: playing.minor,
              network: playing.network,
              kind: playing.kind,
              display_name: playing.display_name
            }
          }}
          onClose={() => setPlaying(null)}
        />
      )}

      <div className="min-h-screen flex flex-col bg-surface">
        {/* Header */}
        <header className="sticky top-0 z-10 glass border-b border-surface-border">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
            {/* Logo */}
            <div className="flex items-center gap-2.5 mr-6">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 shadow-lg shadow-accent/20"
                   style={{ background: "linear-gradient(135deg, #5b8af5, #7c5bf5)" }}>
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875C21 4.254 20.496 3.75 19.875 3.75H4.125C3.504 3.75 3 4.254 3 4.875v11.25c0 .621.504 1.125 1.125 1.125z" />
                </svg>
              </div>
              <span className="font-black text-lg tracking-tight uppercase italic italic-accent">Tablo</span>
            </div>

            {/* Navigation Tabs */}
            <nav className="flex items-center gap-1 mr-auto">
              <button 
                onClick={() => setTab("live")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "live" ? "bg-accent/15 text-accent" : "text-white/40 hover:text-white/60"}`}
              >
                Live TV
              </button>
              <button 
                onClick={() => setTab("grid")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "grid" ? "bg-accent/15 text-accent" : "text-white/40 hover:text-white/60"}`}
              >
                Guide
              </button>
              <button 
                onClick={() => setTab("library")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "library" ? "bg-accent/15 text-accent" : "text-white/40 hover:text-white/60"}`}
              >
                Library
              </button>
            </nav>

            {/* Search — always mounted. Rendering it only on Live TV changed the
                header height and shifted the page on every tab switch. */}
            <div className={`relative flex-1 max-w-sm ${activeTab === "live" ? "" : "invisible"}`}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" aria-hidden />
              <input
                type="text"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Search programs, channels..."
                tabIndex={activeTab === "live" ? 0 : -1}
                aria-hidden={activeTab !== "live"}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/5
                           text-sm placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-accent/40
                           focus:bg-white/10 transition shadow-inner"
              />
            </div>

            <div className="flex items-center gap-4 ml-4">
              <ProfileMenu email={userEmail} onLogout={onLogout} />
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-10">
          {activeTab === "live" && (
            <>
              <PageHeader
                title="On Air Now"
                subtitle="Browse your local guide and start watching instantly"
                now={now}
              />

              {/* Content type filter chips */}
              <div className="flex gap-2 mb-6 overflow-x-auto pb-1 no-scrollbar">
                {CONTENT_FILTERS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setContentFilter(f.id)}
                    className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition
                      ${contentFilter === f.id
                        ? "bg-accent text-white shadow-lg shadow-accent/30"
                        : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 border border-white/5"
                      }`}
                  >
                    <f.Icon className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />
                    <span>{f.label}</span>
                  </button>
                ))}
              </div>

              {isLoading && !channels.length ? (
                <div className="flex flex-col items-center justify-center py-48 gap-6 bg-white/5 rounded-3xl border border-white/5 shadow-2xl">
                  <div className="w-12 h-12 rounded-full border-4 border-accent border-t-transparent animate-spin" />
                  <p className="text-white font-black tracking-tighter text-xl uppercase mb-1">Building Your Guide</p>
                </div>
              ) : (
                <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                  {filtered.map(ch => (
                    <ChannelCard key={ch.identifier} channel={ch} now={now} onClick={() => setPlaying(ch)} />
                  ))}
                  {filtered.length === 0 && channels.length > 0 && (
                    <div className="col-span-full flex flex-col items-center justify-center py-24 text-white/20">
                      <Inbox className="w-12 h-12 mb-3" strokeWidth={1.5} aria-hidden />
                      <p className="text-sm font-bold uppercase tracking-widest">Nothing on right now</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {activeTab === "grid" && (
            <div className="flex flex-col">
               <PageHeader
                 title="TV Guide"
                 subtitle="Traditional timeline view of all upcoming airings"
                 now={now}
               />
               <GuideGridView onPlay={handlePlay} />
            </div>
          )}

          {activeTab === "library" && (
            <div className="flex flex-col">
              <PageHeader
                title="Recordings"
                subtitle="Watch and manage your saved content"
                now={now}
              />
              <LibraryView />
            </div>
          )}
        </main>
      </div>
    </>
  );
}
