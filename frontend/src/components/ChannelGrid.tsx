import { useState, useEffect, useRef, useCallback } from "react";
import { api, type GuideChannel, type GridChannel } from "../api/tablo";
import { ChannelCard } from "./ChannelCard";
import { VideoPlayer } from "./VideoPlayer";
import { Inbox, Search } from "lucide-react";
import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { LibraryView } from "./LibraryView";
import { GuideGridView } from "./GuideGridView";
import { AppMenu } from "./AppMenu";
import { HeaderClock } from "./HeaderClock";
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
  /** The Guide is the one tab laid out as a viewport rather than a document. */
  const isGuide = activeTab === "grid";
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

      {/* The Guide is a viewport; Live TV and Library are documents.
          A guide is a fixed instrument you look into — chrome pinned, one
          scrollable body, bottom anchored — so it gets `h-dvh` and owns its own
          scrolling. The other two are grids of cards that want the window
          scroller, which is what makes find-on-page, scroll restoration and the
          mobile URL-bar collapse work. Converting them too would cost all three
          to solve a problem only the Guide has.
          `dvh`, not `vh`: on mobile `vh` is the LARGEST viewport, so `h-screen`
          is taller than what you can actually see whenever the URL bar shows. */}
      <div className={`flex flex-col bg-surface ${isGuide ? "h-dvh overflow-hidden" : "min-h-screen"}`}>
        {/* Header */}
        {/* Opaque, not `.glass`. Frosted glass means "there is live content
            behind this that you should still perceive" — true of the player's
            controls over video, false of a nav bar over a list you have already
            scrolled past.

            It also made this bar the one element in the app whose contrast
            could not be stated. `.glass` is a 4.5% wash, so the ground was
            whatever scrolled under it, and blur averages colour rather than
            removing it: a 20px blur over a football field is saturated green,
            not neutral grey. The nav tabs measure 5.92:1 against the page, but
            that only held at scroll-top. Both themes were affected — dark's
            page is dark, but the thumbnails passing under it are bright.

            Matching the page colour rather than `surface-raised` keeps it
            reading as the page continuing under the content; the hairline does
            the separating. Also drops a `backdrop-filter` compositor layer that
            was re-rasterising the full header width on every scroll frame, over
            a grid of video thumbnails. */}
        <header className="sticky top-0 z-10 bg-surface border-b border-border">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
            {/* The mark is also the settings menu — see AppMenu for why. */}
            <AppMenu email={userEmail} onLogout={onLogout} />

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
                           text-sm placeholder-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent
                           focus:bg-fill transition shadow-inner"
              />
            </div>

            <div className="flex items-center gap-4 ml-4">
              <HeaderClock now={now} />
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className={`flex-1 max-w-7xl mx-auto w-full px-6 py-10 ${isGuide ? "min-h-0 flex flex-col" : ""}`}>
          {activeTab === "live" && (
            <>
              {/* Content type filter chips */}
              <div className="flex gap-2 mb-6 overflow-x-auto pb-1 no-scrollbar">
                {CONTENT_FILTERS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setContentFilter(f.id)}
                    className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition
                      ${contentFilter === f.id
                        /* Flat accent, not the ramp — see GuideGridView's copy
                           of this chip: no foreground clears 4.5:1 against both
                           brand stops, and this one carries a label. */
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

          {isGuide && (
            <div className="flex flex-col flex-1 min-h-0">
               <GuideGridView onPlay={handlePlay} />
            </div>
          )}

          {activeTab === "library" && (
            <div className="flex flex-col">
              <LibraryView />
            </div>
          )}
        </main>
      </div>
    </>
  );
}
