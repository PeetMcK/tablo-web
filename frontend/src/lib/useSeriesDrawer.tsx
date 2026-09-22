/**
 * Opening a series panel from anywhere that shows one of its episodes.
 *
 * The Guide, Live and Library all render the same info sheet, and the sheet
 * knows only the guide series path. The panel wants a card - rule, keep,
 * counts, and the recordings path its episode list is read from - so this
 * resolves one from the series index, a single request.
 *
 * A series the index does not carry still opens: one is built from what the
 * sheet knew, and the panel fills in the rest from the guide path. That is the
 * ordinary case for a series with no rule and nothing recorded, where the
 * panel is how you give it one.
 */
import { useState } from "react";
import { api, type SeriesCard } from "../api/tablo";
import { SeriesDetail } from "../components/SeriesDetail";

/** Whether a show path addresses the library rather than the guide. */
function isRecordingsPath(path: string): boolean {
  return path.startsWith("/recordings/");
}

/** What the sheet knew, in the shape the panel takes. */
function cardFromPath(path: string, title: string): SeriesCard {
  const recordings = isRecordingsPath(path);
  return {
    recordings_path: recordings ? path : null,
    identifier: null,
    guide_path: recordings ? null : path,
    kind: null,
    title,
    cover_image_id: null,
    rule: "none",
    keep: { rule: "none", count: null },
    offsets: { start: 0, end: 0, source: "none" },
    episode_count: 0,
    unwatched_count: 0,
    protected_count: 0,
    failed_count: 0,
    scheduled_count: 0,
    conflict: false,
    recording_now: false,
  };
}

export function useSeriesDrawer() {
  const [card, setCard] = useState<SeriesCard | null>(null);

  /**
   * Open the panel for a show, named by either of its two paths.
   *
   * A guide airing knows the show as `/guide/series/{id}` or
   * `/guide/sports/{id}`; a recording knows it as `/recordings/…`, which is
   * the only one still true once the airing has aged out of the guide. Both
   * are on the index card, so either finds it.
   */
  async function openSeries(path: string, title: string) {
    // A plain fetch rather than the query cache: this hook is called from the
    // Guide and Live, whose components carry no QueryClient of their own, and
    // requiring one of them to get here would be the tail wagging the dog.
    let known: SeriesCard | undefined;
    try {
      const index = await api.series.index();
      known = index.series.find((s) => (
        isRecordingsPath(path) ? s.recordings_path === path : s.guide_path === path
      ));
    } catch {
      // The index is an optimisation, not a requirement.
    }
    setCard(known ?? cardFromPath(path, title));
  }

  const drawer = card
    ? <SeriesDetail card={card} onClose={() => setCard(null)} />
    : null;

  return { openSeries, drawer };
}
