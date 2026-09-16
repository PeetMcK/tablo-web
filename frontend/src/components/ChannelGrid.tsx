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
import { parseRoute, writeRoute, type Tab } from "../lib/route";

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
  // Read once on mount so a refresh lands on the same tab / stream. A lazy
  // useState rather than a ref: the value is needed during render.
  const [initialRoute] = useState(parseRoute);
  const [playing, setPlaying] = useState<GuideChannel | null>(null);
  const [filter, setFilter] = useState("");
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
  const [activeTab, setTab] = useState<Tab>(initialRoute.tab);
  // Set once the user closes the restored stream, so it does not reopen.
  const [restoreDone, setRestoreDone] = useState(false);
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


  // A channel named in the URL reopens as soon as the guide contains it.
  // Derived rather than assigned from an effect, which would cascade renders.
  const routeWatch = initialRoute.watch;
  const restoredChannel =
    !restoreDone && !playing && routeWatch?.kind === "live"
      ? channels.find(c => c.identifier === routeWatch.id) ?? null
      : null;
  const nowPlaying = playing ?? restoredChannel;

  // Keep the URL in step with what is on screen, so a refresh lands here again.
  useEffect(() => {
    writeRoute({
      tab: activeTab,
      watch: nowPlaying ? { kind: "live", id: nowPlaying.identifier } : null,
    });
  }, [activeTab, nowPlaying]);

  const closePlayer = useCallback(() => {
    setPlaying(null);
    setRestoreDone(true);
  }, []);

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
      {nowPlaying && (
        <VideoPlayer
          key={nowPlaying.identifier}
          source={{
            kind: "live",
            // current_program was previously dropped here, which is why the
            // player could only show a channel name.
            program: nowPlaying.current_program,
            channel: {
              identifier: nowPlaying.identifier,
              call_sign: nowPlaying.call_sign,
              major: nowPlaying.major,
              minor: nowPlaying.minor,
              network: nowPlaying.network,
              kind: nowPlaying.kind,
              display_name: nowPlaying.display_name
            }
          }}
          onClose={closePlayer}
        />
      )}

      <div className="min-h-screen flex flex-col bg-surface">
        {/* Header */}
        {/* `.glass` carries an all-sides border, which is right for the rounded
            glass buttons but not for a full-bleed sticky header — it drew
            hairlines down the viewport edges. Zero the other three explicitly:
            `.glass` is a components-layer rule, so these utilities win. */}
        <header className="sticky top-0 z-10 glass border-x-0 border-t-0 border-b border-border">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
            {/* Logo */}
            <div className="flex items-center gap-2.5 mr-6">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 shadow-lg shadow-accent-glow
                              bg-gradient-to-br from-brand-from to-brand-to">
                <svg className="w-4 h-4 text-accent-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875C21 4.254 20.496 3.75 19.875 3.75H4.125C3.504 3.75 3 4.254 3 4.875v11.25c0 .621.504 1.125 1.125 1.125z" />
                </svg>
              </div>
              {/* No colour class: the wordmark inherits `text-fg` from <body>,
                  which is white in dark and ink in light. */}
              <span className="font-black text-lg tracking-tight uppercase italic">Tablo</span>
            </div>

            {/* Navigation Tabs */}
            <nav className="flex items-center gap-1 mr-auto">
              <button 
                onClick={() => setTab("live")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "live" ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
              >
                Live TV
              </button>
              <button 
                onClick={() => setTab("grid")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "grid" ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
              >
                Guide
              </button>
              <button 
                onClick={() => setTab("library")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "library" ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
              >
                Library
              </button>
            </nav>

            {/* Search — always mounted. Rendering it only on Live TV changed the
                header height and shifted the page on every tab switch. */}
            <div className={`relative flex-1 max-w-sm ${activeTab === "live" ? "" : "invisible"}`}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-muted" aria-hidden />
              <input
                type="text"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Search programs, channels..."
                tabIndex={activeTab === "live" ? 0 : -1}
                aria-hidden={activeTab !== "live"}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-fill-soft border border-border-subtle
                           text-sm placeholder-fg-disabled focus:outline-none focus:ring-2 focus:ring-accent
                           focus:bg-fill transition shadow-inner"
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
                        ? "bg-accent text-accent-fg shadow-lg shadow-accent-glow"
                        : "bg-fill-soft text-fg-muted hover:bg-fill hover:text-fg-secondary border border-border-subtle"
                      }`}
                  >
                    <f.Icon className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />
                    <span>{f.label}</span>
                  </button>
                ))}
              </div>

              {isLoading && !channels.length ? (
                <div className="flex flex-col items-center justify-center py-48 gap-6 bg-fill-soft rounded-3xl border border-border-subtle shadow-2xl">
                  <div className="w-12 h-12 rounded-full border-4 border-accent border-t-transparent animate-spin" />
                  <p className="text-fg font-black tracking-tighter text-xl uppercase mb-1">Building Your Guide</p>
                </div>
              ) : (
                <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                  {filtered.map(ch => (
                    <ChannelCard key={ch.identifier} channel={ch} now={now} onClick={() => setPlaying(ch)} />
                  ))}
                  {filtered.length === 0 && channels.length > 0 && (
                    <div className="col-span-full flex flex-col items-center justify-center py-24 text-fg-muted">
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
