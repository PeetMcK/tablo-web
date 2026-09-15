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
