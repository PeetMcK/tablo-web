import { useState, useEffect, useRef, useCallback } from "react";
import { api, type GuideChannel, type GridChannel, type SearchItem } from "../api/tablo";
import { recordingFor, useRecordingsInProgress } from "../lib/useRecordingsInProgress";
import { ChannelCard } from "./ChannelCard";
import { VideoPlayer } from "./VideoPlayer";
import { Inbox, Search, X } from "lucide-react";
import { useMediaQuery } from "../lib/useMediaQuery";
import { CONTENT_FILTERS, type ContentFilter } from "../lib/contentFilters";
import { ContentFilterMenu } from "./ContentFilterMenu";
import { LibraryView } from "./LibraryView";
import { RecordingsView } from "./RecordingsView";
import { ShowInfo } from "./ShowInfo";
import { useSeriesDrawer } from "../lib/useSeriesDrawer";
import { GuideGridView, type GuideJumpTarget } from "./GuideGridView";
import { AppMenu } from "./AppMenu";
import { HeaderClock } from "./HeaderClock";
import { SearchDropdown } from "./SearchDropdown";
import { SearchResultsView } from "./SearchResultsView";
import { CommandPalette } from "./CommandPalette";
import { SettingsModal } from "./SettingsModal";
import { onRoutePop, parseRoute, writeRoute, type Tab } from "../lib/route";

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



/** `7.1 PBS`, or the call sign alone where the device gave no number. */
function channelName(ch: GuideChannel): string {
  return ch.major > 0 ? `${ch.major}.${ch.minor} ${ch.call_sign}` : ch.call_sign;
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
  // Opening the series behind an episode, from its sheet.
  const { openSeries, drawer: seriesDrawer } = useSeriesDrawer();
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
  /**
   * Phone layout: below Tailwind's `sm`, the topbar cannot hold the mark, the
   * three tabs, a search field and the clock at once — the clock was the one
   * that lost, running off the right edge. So the field collapses to its own
   * icon, and expanding it takes the row over for as long as it is open.
   *
   * A media query in JS rather than a `sm:hidden` pair, because both shapes
   * share one input: a second copy behind a breakpoint would mean two fields
   * with the same placeholder and the same value to keep in step.
   */
  const phone = useMediaQuery("(max-width: 639px)");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // A channel picked from search that was not yet in `channels` when picked
  // (the guide stream only runs once the Live TV tab is active). Matched
  // against `channels` below, via `pendingMatch`, as soon as the stream
  // catches up.
  const [pendingChannel, setPendingChannel] = useState<string | null>(null);
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
  const [activeTab, setTab] = useState<Tab>(initialRoute.tab);
  /** The Guide is the one tab laid out as a viewport rather than a document. */
  const isGuide = activeTab === "grid";
  /** Tabs laid out as a viewport (own scroll pane) rather than a document. */
  const isViewport = isGuide || activeTab === "series";
  // Set once the user closes the restored stream, so it does not reopen.
  const [restoreDone, setRestoreDone] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped on every library-target search activation, and used as
  // LibraryView's `key` below. Library hands off through the hash alone
  // (see `handleSearchActivate`), which LibraryView reads once at mount —
  // that is enough when the activation also switches tabs, because the tab
  // switch mounts LibraryView fresh. It is not enough from a click made
  // while ALREADY on Library: the tab conditional below doesn't change, so
  // LibraryView never remounts and never re-reads the hash. Changing its key
  // forces that remount regardless of which tab the click came from.
  const [libraryActivation, setLibraryActivation] = useState(0);
  // The airing a guide-target search result asked for. Carries its own nonce
  // rather than reusing a counter like `libraryActivation`, because the guide
  // needs the channel and start as well - and unlike Library, it cannot be
  // handed off through the hash: the route encodes what is playing, and an
  // upcoming airing is not something that plays.
  const [guideJump, setGuideJump] = useState<GuideJumpTarget | null>(null);
  // The sheet a Live TV card's programme half opens, keyed the way the guide's
  // is. `start` is null for a channel with nothing listed, and `label` names
  // the channel in that case, since the sheet builds its eyebrow from an
  // airing it will not have.
  const [cardInfo, setCardInfo] = useState<
    { channel: string; start: string | null; label: string } | null>(null);

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
  const inProgress = useRecordingsInProgress(activeTab === "live");


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

  // The browser's Back, out of a player, means the same thing as Escape. The
  // entry it pops is the tab the player was opened from, so an empty `watch`
  // is the close. The route effect above then finds the hash already correct
  // and writes nothing, which is what keeps this from bouncing.
  useEffect(() => onRoutePop((route) => {
    if (!route.watch) closePlayer();
  }), [closePlayer]);

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
  // Library it hands off through the same hash LibraryView reads at mount
  // (see `initialRoute` above and in LibraryView), plus bumping
  // `libraryActivation` so that read happens even when Library was already
  // the active tab and would not otherwise remount.
  const handleSearchActivate = useCallback((item: SearchItem) => {
    const { tab, watch, at, channel_id } = item.target;
    setSearchOpen(false);
    setFilter("");

    if (tab === "live" && typeof watch === "string") {
      const ch = channels.find(c => c.identifier === watch);
      if (ch) setPlaying(ch);
      else setPendingChannel(watch);
    } else if (tab === "library" && typeof watch === "number") {
      writeRoute({ tab: "library", watch: { kind: "recording", id: watch } });
      setLibraryActivation(n => n + 1);
    } else if (tab === "grid" && at && channel_id) {
      // Both halves or nothing: an airing indexed before the target carried
      // `channel_id` still switches to the Guide, which is what this did for
      // every airing until now. Better than opening a sheet keyed on half a
      // key and showing an error in it.
      setGuideJump(j => ({ channel: channel_id, start: at, nonce: (j?.nonce ?? 0) + 1 }));
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

  /** Collapse the phone search back to its icon, dropping the query with it. */
  const collapseSearch = useCallback(() => {
    setSearchExpanded(false);
    setSearchOpen(false);
    setFilter("");
  }, []);

  // Focus follows the expansion: tapping the icon should put the caret in the
  // field, not merely reveal it. Effect rather than `autoFocus`, which only
  // fires on mount and would do nothing on the second open.
  useEffect(() => {
    if (searchExpanded) searchInputRef.current?.focus();
  }, [searchExpanded]);

  // Widening the window while the phone field is open leaves the row hiding
  // its own tabs and clock, since the expanded shape is what renders them out.
  useEffect(() => {
    if (!phone) setSearchExpanded(false);
  }, [phone]);

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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
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

      {/* The sheet a Live TV card's programme half opens. The same component
          the guide opens, so the two tabs describe a programme the same way,
          and its Watch Live is the second way to tune from a card. */}
      {cardInfo && (
        <ShowInfo
          channel={cardInfo.channel}
          start={cardInfo.start}
          channelLabel={cardInfo.label}
          onOpenSeries={(guidePath, title) => {
            setCardInfo(null);
            void openSeries(guidePath, title);
          }}
          onClose={() => setCardInfo(null)}
          onTune={() => {
            const ch = channels.find(c => c.identifier === cardInfo.channel);
            setCardInfo(null);
            if (ch) setPlaying(ch);
          }}
        />
      )}

      {/* The series panel, when the sheet sent us to one. */}
      {seriesDrawer}

      {/* The Guide is a viewport; Live TV and Library are documents.
          A guide is a fixed instrument you look into — chrome pinned, one
          scrollable body, bottom anchored — so it gets `h-dvh` and owns its own
          scrolling. The other two are grids of cards that want the window
          scroller, which is what makes find-on-page, scroll restoration and the
          mobile URL-bar collapse work. Converting them too would cost all three
          to solve a problem only the Guide has.
          `dvh`, not `vh`: on mobile `vh` is the LARGEST viewport, so `h-screen`
          is taller than what you can actually see whenever the URL bar shows. */}
      <div className={`flex flex-col bg-surface ${isViewport ? "h-dvh overflow-hidden" : "min-h-screen"}`}>
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
        {/* z-40, not z-10. A sticky element with a z-index creates a stacking
            context, so the AppMenu panel's own z-50 only orders it WITHIN this
            header — against the page, everything in here competes at the
            header's value. At z-10 that put the whole bar, panel included,
            underneath the guide's hour row (z-20) and its now-line (z-30),
            which drew straight through the open menu. The bar is app chrome and
            belongs above every page layer; the player (z-50) and confirm dialog
            (z-60) are still above it, which is right — both are modal. */}
        <header className="sticky top-0 z-40 bg-surface border-b border-border">
          {/* `gap-1` so the mark reads as the first item in the tab run rather
              than a separate block sat off to the left. Nothing downstream goes
              short of air: the nav's `mr-auto` opens the whole remaining gap
              before the search field, and the clock brings its own `ml-4`. */}
          {/* `px-4` below sm, matching main's — the two set the page's left
              edge between them, and the mark has to line up with the cards
              under it. The narrower gutter is also 16px of the row back: at
              320px the topbar did not fit, and what did not fit pushed the
              whole document sideways. */}
          {/* A fixed height, not `py-4`. The row is as tall as its tallest
              child, and on a phone that child changes: the search icon is 38px
              closed and the field is 42px open, so opening search grew the bar
              by 4px and shoved the whole page down under it. 74px is what the
              field's own 42 plus that 16px of padding already came to, so the
              wide layout is unchanged and the phone simply stops moving. */}
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-[74px] flex items-center gap-1">
            {/* The mark is also the settings menu — see AppMenu for why. */}
            <AppMenu
              email={userEmail}
              onLogout={onLogout}
              onOpenSettings={() => setSettingsOpen(true)}
            />

            {/* Navigation Tabs.
                `ml-4` is measured against the letterforms, not the boxes. Two
                tab labels sit 36px apart — 16px of pill padding, the 4px gap,
                16px more padding — but a pill's padding only counts once
                against the mark, so the flex gap alone left "Live" 20px off it
                and the mark looked glued on. 16 + 4 + 16 either side. */}
            <nav className={`items-center gap-1 mr-auto ml-2 sm:ml-4 ${searchExpanded ? "hidden" : "flex"}`}>
              <button
                onClick={() => goToTab("live")}
                className={`touch-target flex items-center justify-center px-3 sm:px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "live" ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
              >
                Live
              </button>
              <button
                onClick={() => goToTab("grid")}
                className={`touch-target flex items-center justify-center px-3 sm:px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "grid" ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
              >
                Guide
              </button>
              <button
                onClick={() => goToTab("library")}
                className={`touch-target flex items-center justify-center px-3 sm:px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "library" ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
              >
                Library
              </button>
              <button
                onClick={() => goToTab("series")}
                className={`touch-target flex items-center justify-center px-3 sm:px-4 py-1.5 rounded-full text-sm font-bold tracking-wide transition
                           ${activeTab === "series" ? "bg-accent-soft text-accent-strong" : "text-fg-muted hover:text-fg-secondary"}`}
              >
                Series
              </button>
            </nav>

            {/* Phone, closed: the field is an icon, and it is the last thing in
                the row — top right, where a phone expects it. Tapping it
                expands the row into the field below. Above 640px the field is
                simply always there. */}
            {phone && !searchExpanded && (
              <button
                onClick={() => setSearchExpanded(true)}
                aria-label="Search"
                aria-expanded={false}
                className="touch-target shrink-0 flex items-center justify-center p-2.5 rounded-xl bg-fill-soft border border-border-subtle
                           text-fg-muted hover:text-fg-secondary hover:bg-fill transition
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Search className="w-4 h-4" aria-hidden />
              </button>
            )}

            {/* Search — global, not just a Live TV filter. Mounted on every tab
                so the header height stays put across tab switches. The dropdown
                shows server results for any tab; the Live list below is
                filtered locally too, since that is instant and free. */}
            {/* `ml-4` while expanded for the same reason the nav carries one:
                open, the field is what sits next to the mark, and without it
                the two touched. */}
            <div className={`relative flex-1 max-w-sm ${searchExpanded ? "ml-4" : ""} ${phone && !searchExpanded ? "hidden" : ""}`}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-muted" aria-hidden />
              <input
                ref={searchInputRef}
                type="text"
                value={filter}
                onChange={e => { setFilter(e.target.value); setSearchOpen(true); }}
                onFocus={() => setSearchOpen(true)}
                onBlur={() => setSearchOpen(false)}
                onKeyDown={e => {
                  if (e.key !== "Escape") return;
                  // One Escape, one dismissal: on a phone the field IS the
                  // row, so leaving it open with the dropdown gone would hide
                  // the tabs behind an empty box.
                  if (searchExpanded) collapseSearch(); else closeSearch();
                }}
                placeholder="Search programs, channels..."
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-fill-soft border border-border-subtle
                           text-sm placeholder-fg-subtle focus:outline-none focus:ring-2 focus:ring-accent
                           focus:bg-fill transition shadow-inner"
              />
              {/* Not on the search tab: the results page below is the same
                  query answered at fifty rows a group, so floating a
                  three-row summary of it over the top says less and hides
                  more. Everywhere else the dropdown is the only answer
                  there is. */}
              {searchOpen && activeTab !== "search" && filter.trim().length >= 2 && (
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

            {/* The way back to the tabs. `onMouseDown` preventDefault for the
                same reason the dropdown does it: the input's own blur must not
                land first and take the dropdown down under the tap. */}
            {searchExpanded && (
              <button
                onMouseDown={e => e.preventDefault()}
                onClick={collapseSearch}
                aria-label="Close search"
                className="touch-target shrink-0 ml-1 flex items-center justify-center p-2.5 rounded-xl text-fg-muted hover:text-fg-secondary
                           hover:bg-fill-soft transition
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X className="w-4 h-4" aria-hidden />
              </button>
            )}

            {/* The clock is the first thing to go on a phone. It is the least
                of the four — the time is in the status bar an inch above it —
                and dropping it is what puts the search icon at the top right
                corner, which is where a hand reaches for it. It comes back at
                640px, tablet included, where the row has the width for it. */}
            <div className={`items-center gap-4 ml-4 ${phone || searchExpanded ? "hidden" : "flex"}`}>
              <HeaderClock now={now} />
            </div>
          </div>
        </header>

        {/* Main content */}
        {/* `pt-4`, matching the gap the filter chips leave below themselves.
            It was `py-10`: 40px of air above the chips against 16px below
            them, on every page, which read as the controls sitting low in
            their own band rather than as deliberate room. The foot of the
            page keeps its 40px — only the top was out. */}
        {/* The guide loses the 40px foot on a phone: the grid runs to both
            edges there (see GuideGridView's own `-mx-4`), and a band of page
            under it would be the one side still framed.
            `px-4` below sm — the same gutter the header uses, since the two
            have to agree on where the page starts. */}
        <main className={`flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4
                          ${isViewport ? "pb-0 sm:pb-10 min-h-0 flex flex-col" : "pb-10"}`}>
          {activeTab === "live" && (
            <>
              {/* Content type filter chips */}
              {/* Wrapping, for the reason the guide's chips wrap: as a
                  hidden-scrollbar scroller the last of the eight ran off the
                  edge with nothing to say it was there. `mb-4` so the gap
                  below them is the same 16px the top of the page now uses. */}
              {/* And below a phone's width they are not a row at all but one
                  pill-and-popover, the same control the guide collapses to. */}
              <div data-filter-menu className="sm:hidden mb-4">
                <ContentFilterMenu value={contentFilter} onChange={setContentFilter} />
              </div>

              <div data-filter-chips className="hidden sm:flex flex-wrap gap-2 mb-4">
                {CONTENT_FILTERS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setContentFilter(f.id)}
                    className={`touch-target shrink-0 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition
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
                <div
                  className="grid gap-4"
                  style={{
                    // `min(320px, 100%)`, not a bare 320px: a track floor wider
                    // than the container does not shrink to fit it, it
                    // overflows — and one card 20px too wide scrolls the whole
                    // document sideways, which reads as every page being
                    // off-centre. The min() lets the single column collapse to
                    // whatever a 320px-class phone actually has.
                    gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))",
                  }}
                >
                  {filtered.map(ch => (
                    <ChannelCard
                      key={ch.identifier}
                      channel={ch}
                      now={now}
                      recording={recordingFor(inProgress, ch.identifier,
                                              ch.current_program?.start)}
                      infoOpen={cardInfo?.channel === ch.identifier}
                      onPlay={() => setPlaying(ch)}
                      onInfo={() => setCardInfo({
                        channel: ch.identifier,
                        // No programme means no airing to key a sheet by; the
                        // sheet has a mode for that and names the channel
                        // instead.
                        start: ch.current_program?.start ?? null,
                        label: channelName(ch),
                      })}
                    />
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
               <GuideGridView onPlay={handlePlay} jumpTo={guideJump} />
            </div>
          )}

          {activeTab === "library" && (
            <div className="flex flex-col">
              {/* Keyed on the activation counter so searching a recording while
                  already on this tab genuinely remounts. Without it the panel
                  keeps the route it snapshotted at its own mount and the
                  activation silently does nothing. */}
              <LibraryView key={libraryActivation} />
            </div>
          )}

          {activeTab === "series" && (
            <div className="flex flex-col flex-1 min-h-0">
              <RecordingsView />
            </div>
          )}

          {activeTab === "search" && (
            <div className="flex flex-col">
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
