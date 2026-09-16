import { useState, useEffect, useRef, useCallback } from "react";
import { api, type GuideChannel, type GridChannel, type SearchItem } from "../api/tablo";
import { ChannelCard } from "./ChannelCard";
import { VideoPlayer } from "./VideoPlayer";
import { Inbox, Search } from "lucide-react";
import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { LibraryView } from "./LibraryView";
import { GuideGridView } from "./GuideGridView";
import { ProfileMenu } from "./ProfileMenu";
import { PageHeader } from "./PageHeader";
import { SearchDropdown } from "./SearchDropdown";
import { SearchResultsView } from "./SearchResultsView";
import { CommandPalette } from "./CommandPalette";
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
  // Seeded from the hash so a deep link to `#/search?q=broncos` lands on
  // the same query rather than an empty box. Only meaningful when the
  // route opened directly on the search tab — `writeRoute` only ever
  // writes `q` for that tab (see the effect below), so `initialRoute.q`
  // is otherwise noise.
  const [filter, setFilter] = useState(() =>
    initialRoute.tab === "search" ? initialRoute.q ?? "" : ""
  );
  // Whether the results dropdown should be showing. Deliberately NOT derived
  // from the input's real DOM focus state: the dropdown's own mousedown guard
  // (below) keeps the input DOM-focused through a click on a result, so a
  // flag that claimed to track focus would drift from the DOM the moment
  // activation set it back to false — and nothing would ever true it up
  // again, since no further focus/blur event fires while the DOM element
  // never actually lost focus. This is set explicitly by the handlers that
  // care, never inferred from focus except via the real onFocus/onBlur pair.
  const [searchOpen, setSearchOpen] = useState(false);
  // A channel picked from search that was not yet in `channels` when picked
  // (the guide stream only runs once the Live TV tab is active). Matched
  // against `channels` below, via `pendingMatch`, as soon as the stream
  // catches up.
  const [pendingChannel, setPendingChannel] = useState<string | null>(null);
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
  const [activeTab, setTab] = useState<Tab>(initialRoute.tab);
  // Set once the user closes the restored stream, so it does not reopen.
  const [restoreDone, setRestoreDone] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Cmd-K / Ctrl-K from anywhere, including while watching. A window
  // listener rather than something scoped to a focused element: the whole
  // point is that it works no matter what has focus, including the player.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Also closes the topbar dropdown: without this, opening the
        // palette leaves `searchOpen` untouched, and it silently reappears
        // underneath once the palette closes again.
        setSearchOpen(false);
        setPaletteOpen(o => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
  // A channel picked from search before the guide stream had it: matched the
  // same way `restoredChannel` above is — watch `channels` as it streams in
  // and pick it up the moment it appears, rather than an effect calling
  // setState (which would cascade a render on every guide-stream tick).
  // Cleared by `closePlayer`, which is what stops it reappearing once shown.
  const pendingMatch =
    !playing && pendingChannel
      ? channels.find(c => c.identifier === pendingChannel) ?? null
      : null;
  const nowPlaying = playing ?? restoredChannel ?? pendingMatch;

  // Keep the URL in step with what is on screen, so a refresh lands here
  // again. Deliberately NOT keyed on `filter`: this effect owns `tab` and
  // `watch`, and Library owns a deeper route of its own
  // (`#/library/rec/<id>`, written by LibraryView's own effect) — folding
  // `filter` in here as a dependency would re-run this on every keystroke
  // typed in the topbar, on ANY tab, and stomp that deeper route back down
  // to a bare `#/library` since this component's own `nowPlaying` only ever
  // tracks a live channel.
  useEffect(() => {
    writeRoute({
      tab: activeTab,
      watch: nowPlaying ? { kind: "live", id: nowPlaying.identifier } : null,
    });
  }, [activeTab, nowPlaying]);

  // The search tab's query string round-trips through the hash too, but only
  // while that tab is actually showing — writing it unconditionally here
  // would be the same clobbering bug as above, just for `q` instead of
  // `watch`.
  useEffect(() => {
    if (activeTab !== "search") return;
    writeRoute({
      tab: "search",
      watch: nowPlaying ? { kind: "live", id: nowPlaying.identifier } : null,
      q: filter,
    });
  }, [activeTab, nowPlaying, filter]);

  const closePlayer = useCallback(() => {
    setPlaying(null);
    // Also drops a still-unmatched pending channel: without this, closing a
    // channel that `pendingMatch` just resolved would immediately reopen it
    // on the next render (`playing` goes back to null, `pendingMatch` is
    // still there to fall back to).
    setPendingChannel(null);
    setRestoreDone(true);
  }, []);

  // Every tab switch goes through here rather than the raw `setTab`, so that
  // a `pendingChannel` left unresolved cannot outlive the tab it was queued
  // on. Without this, leaving Live TV before the guide stream delivers it
  // (which aborts the stream — see `useGuideStream`'s cleanup — so it never
  // resolves there) would leave `pendingChannel` sitting in plain component
  // state with nothing to time it out. Return to Live TV later, on some
  // unrelated visit, and the stream restarts, finds the channel, and
  // auto-opens a selection the user made and forgot about, having clicked
  // nothing this time.
  //
  // This intentionally is NOT a `useEffect` watching `activeTab`: that would
  // fire on the very same render that `handleSearchActivate` queues a fresh
  // `pendingChannel` and switches to Live TV in one go, and — depending on
  // ordering — could eat the value it just queued. Clearing it here, in the
  // same handler that performs the switch, keeps "am I leaving Live TV" and
  // "did I just queue something for Live TV" from ever racing.
  //
  // Guarded on `!pendingMatch`: `pendingChannel` means two different things
  // depending on whether the guide stream has caught up to it yet. Unresolved,
  // it is exactly the stale-queue hole described above and must be dropped on
  // the way out. Resolved, `pendingMatch` is feeding `nowPlaying` below — the
  // player is on screen because of it — and clearing it here would unmount
  // the player just for switching tabs, breaking "watch while browsing" the
  // same way `restoredChannel` deliberately supports it.
  const goToTab = useCallback((tab: Tab) => {
    if (tab !== "live" && !pendingMatch) setPendingChannel(null);
    setTab(tab);
  }, [pendingMatch]);

  // Activating a search result routes via its `target` rather than a second,
  // parallel navigation path. For Live TV this plays the channel directly when
  // it is already in hand, or queues it as `pendingChannel` for the derived
  // `pendingMatch` above when the guide stream has not caught up yet; for
  // Library it hands off through the same hash the page reads on mount (see
  // `initialRoute` above and in LibraryView) since that panel remounts fresh
  // on every tab switch.
  const handleSearchActivate = useCallback((item: SearchItem) => {
    const { tab, watch } = item.target;
    setSearchOpen(false);
    setFilter("");

    if (tab === "live" && typeof watch === "string") {
      const ch = channels.find(c => c.identifier === watch);
      if (ch) setPlaying(ch);
      else setPendingChannel(watch);
    } else if (tab === "library" && typeof watch === "number") {
      writeRoute({ tab: "library", watch: { kind: "recording", id: watch } });
    }
    // `goToTab` only clears `pendingChannel` for a tab other than "live" —
    // this call is always "live" in the branch above that just set it, so
    // the value set two lines up survives.
    goToTab(tab);
  }, [channels, goToTab]);

  const handleSearchSeeAll = useCallback(() => {
    setSearchOpen(false);
    goToTab("search");
  }, [goToTab]);

  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // The palette activates through the very same path as the topbar dropdown
  // (`handleSearchActivate`) rather than a second, parallel one - it only
  // adds closing itself on top.
  const handlePaletteActivate = useCallback((item: SearchItem) => {
    setPaletteOpen(false);
    handleSearchActivate(item);
  }, [handleSearchActivate]);

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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onActivate={handlePaletteActivate}
      />

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
              <span className="font-black text-lg tracking-tight uppercase italic italic-accent">Tablo-Web</span>
            </div>

            {/* Navigation Tabs */}
            <nav className="flex items-center gap-1 mr-auto">
              <button
                onClick={() => goToTab("live")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "live" ? "bg-accent/15 text-accent" : "text-white/40 hover:text-white/60"}`}
              >
                Live TV
              </button>
              <button
                onClick={() => goToTab("grid")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "grid" ? "bg-accent/15 text-accent" : "text-white/40 hover:text-white/60"}`}
              >
                Guide
              </button>
              <button
                onClick={() => goToTab("library")}
                className={`px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "library" ? "bg-accent/15 text-accent" : "text-white/40 hover:text-white/60"}`}
              >
                Library
              </button>
            </nav>

            {/* Search — global, not just a Live TV filter. Always mounted so the
                header height stays put across tab switches. The dropdown shows
                server results for any tab; the Live TV list below is filtered
                locally too, since that is instant and free. */}
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" aria-hidden />
              <input
                type="text"
                value={filter}
                onChange={e => { setFilter(e.target.value); setSearchOpen(true); }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setSearchOpen(false)}
                onKeyDown={e => { if (e.key === "Escape") closeSearch(); }}
                placeholder="Search programs, channels..."
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/5 border border-white/5
                           text-sm placeholder-white/20 focus:outline-none focus:ring-1 focus:ring-accent/40
                           focus:bg-white/10 transition shadow-inner"
              />
              {searchOpen && filter.trim().length >= 2 && (
                // Keeps the input focused through the click so `onBlur` above
                // does not dismiss the dropdown before `onActivate` fires.
                <div onMouseDown={e => e.preventDefault()}>
                  <SearchDropdown
                    query={filter}
                    onActivate={handleSearchActivate}
                    onSeeAll={handleSearchSeeAll}
                  />
                </div>
              )}
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

          {activeTab === "search" && (
            <div className="flex flex-col">
              <PageHeader
                title="Search"
                subtitle="Every channel, program and recording, in one place"
                now={now}
              />
              {/* Shares `filter` with the topbar box above rather than
                  owning a second query state — the effect that writes
                  `route.q` already keys off this same value. Activation
                  goes through `handleSearchActivate`, the same path the
                  dropdown and palette use, so this surface cannot drift
                  from their pendingChannel/goToTab handling. */}
              <SearchResultsView
                query={filter}
                onQueryChange={setFilter}
                onActivate={handleSearchActivate}
              />
            </div>
          )}
        </main>
      </div>
    </>
  );
}
