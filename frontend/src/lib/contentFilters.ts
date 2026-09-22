import {
  LayoutGrid,
  Clapperboard,
  Trophy,
  Newspaper,
  Tv,
  Film,
  RadioTower,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type ContentFilter =
  | "all" | "movies" | "sports" | "news" | "reality" | "documentary" | "ota" | "fast";

export interface ContentFilterDef {
  id: ContentFilter;
  label: string;
  Icon: LucideIcon;
}

/**
 * Single source of truth for the filter chips.
 *
 * This list previously existed verbatim in both ChannelGrid and GuideGridView,
 * so the two could drift apart silently.
 */
export const CONTENT_FILTERS: ContentFilterDef[] = [
  { id: "all",         label: "All",         Icon: LayoutGrid },
  { id: "movies",      label: "Movies",      Icon: Clapperboard },
  { id: "sports",      label: "Sports",      Icon: Trophy },
  { id: "news",        label: "News",        Icon: Newspaper },
  { id: "reality",     label: "Reality",     Icon: Tv },
  { id: "documentary", label: "Documentary", Icon: Film },
  { id: "ota",         label: "Broadcast",   Icon: RadioTower },
  { id: "fast",        label: "Streaming",   Icon: Zap },
];

/** What the Library needs of a recording to file it under a filter. */
export interface FilterableRecording {
  /** "episode", "sport" or "movie" — the recording's own path says which. */
  kind: string | null;
  /** The show's, not the recording's. Empty is ordinary. */
  genres: string[];
  channel: { kind: string | null } | null;
}

/**
 * Whether a recording belongs under a content filter.
 *
 * The same eight buckets Live and the guide use, answered from what a
 * *recording* knows. Two differences from the channel matchers, both forced by
 * the device:
 *
 * * Movies and Sports are settled by `kind` first. A film carries no genres at
 *   all — there is no show record behind it — so genre matching alone would
 *   drop every one of them out of the filter named after it.
 * * Broadcast and Streaming read the station the recording came from. Only an
 *   aerial one can have been recorded, so Streaming is ordinarily empty; it is
 *   kept because the menu is the same eight everywhere and a filter that
 *   silently did nothing would be worse than one that honestly finds nothing.
 */
export function recordingMatchesFilter(
  rec: FilterableRecording, f: ContentFilter,
): boolean {
  if (f === "all") return true;
  if (f === "ota")  return rec.channel?.kind === "ota";
  if (f === "fast") return rec.channel?.kind === "ott";
  const genres = rec.genres ?? [];
  if (f === "movies")      return rec.kind === "movie";
  if (f === "sports")      return rec.kind === "sport" || genres.some(g => /sport/i.test(g));
  if (f === "news")        return genres.some(g => /news/i.test(g));
  if (f === "reality")     return genres.some(g => /reality/i.test(g));
  if (f === "documentary") return genres.some(g => /documentary/i.test(g));
  return false;
}
