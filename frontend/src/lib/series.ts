/**
 * Which recordings belong to the same show, and what order they go in.
 *
 * Pure, and kept apart from the card that draws it, because the rules are the
 * part with consequences: both were decided against the live library rather
 * than from the shape of the data, and neither is obvious from a type.
 */

/** Everything the grouping and ordering need, from a recording. */
export interface Episode {
  object_id: number;
  title: string | null;
  /** `/recordings/series/{id}`, or null for anything the device files as sport. */
  series_path: string | null;
  /** `/recordings/sports/{id}` — what a game has instead of a series. */
  sport_path: string | null;
  season_number: number | null;
  episode_number: number | null;
  /** When it first aired, `YYYY-MM-DD`, or null. */
  orig_air_date: string | null;
  /** Scheduled start of this recording, ISO. Always present. */
  start: string;
}

/**
 * What files a recording with the rest of its show.
 *
 * `series_path` where there is one, `sport_path` where the show is a sport, and
 * the title only when the device offers neither.
 *
 * The sport path is not a special case, it is the same thing named differently:
 * `/recordings/sports/{id}` carries a title, a description, the same three
 * images and its own airing count, and the Tablo app heads its sheet "Series
 * Recording Scheduled" over the league's picture. Every NFL game on this
 * device hangs off one such record.
 *
 * The title remains as a floor. It was carrying sport on its own before the
 * path was projected, which worked — six games do share a title — but only by
 * accident: two different shows can share one, and a device that files them
 * properly should be believed over a string match.
 *
 * Null when there is none of the three, which is the signal to show no list.
 */
export function seriesKey(
  // Only the three fields it reads, so the Library's grouping — which knows a
  // recording by a different shape — files a card under exactly the same rule
  // rather than a second copy of it.
  rec: Pick<Episode, "title" | "series_path" | "sport_path">,
): string | null {
  if (rec.series_path) return rec.series_path;
  if (rec.sport_path) return rec.sport_path;
  return rec.title ? `title:${rec.title}` : null;
}

/** Whether an episode is placed by number rather than by date. */
function numbered(rec: Episode): boolean {
  return rec.season_number !== null && rec.episode_number !== null;
}

/** Epoch milliseconds, or +Infinity for a date nothing can be made of. */
function stamp(value: string | null): number {
  if (!value) return Infinity;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Infinity : ms;
}

/**
 * One show's recordings, oldest first.
 *
 * The rule is chosen per series rather than per episode, because a series
 * either has usable numbering or it does not:
 *
 * 1. **Every** episode carries a season and an episode number — sort by those.
 * 2. Otherwise, sort by `orig_air_date`, falling back to when it was recorded.
 *
 * Every, not any. A group where some are numbered and some are not sorts
 * incoherently under the first rule: the unnumbered ones collapse together at
 * one end whatever their dates say.
 *
 * Measured, which is why it is not one global rule. `Saturday Night Live`
 * holds S24E16 and S49E7 — a quarter-century apart, and both recorded the same
 * morning, so recording order says nothing and episode order says everything.
 * `Carl the Collector` holds S1E5 and S1E30, where the two agree. The NFL has
 * no numbers at all, and sorting it by them would put six games in an
 * arbitrary order.
 *
 * Ties are broken on `start` and then `object_id`, always. They are not
 * hypothetical: `First Civilizations` holds three recordings that are all
 * S1E3 with one air date, so every comparison above ties on all three, and
 * without a stable tail the list reshuffles between renders.
 */
export function orderEpisodes<T extends Episode>(episodes: T[]): T[] {
  const byNumber = episodes.length > 0 && episodes.every(numbered);
  return [...episodes].sort((a, b) => {
    if (byNumber) {
      const season = a.season_number! - b.season_number!;
      if (season !== 0) return season;
      const episode = a.episode_number! - b.episode_number!;
      if (episode !== 0) return episode;
    } else {
      const aired = stamp(a.orig_air_date ?? a.start) - stamp(b.orig_air_date ?? b.start);
      if (aired !== 0) return aired;
    }
    const started = stamp(a.start) - stamp(b.start);
    if (started !== 0) return started;
    return a.object_id - b.object_id;
  });
}

/**
 * The rest of this show, in order, including the one just watched.
 *
 * Including it deliberately: the card is a list of the show, with the finished
 * episode marked in its place, not a list of what is left. Seeing where you
 * are in a run is most of what the list is for.
 *
 * Empty when the recording has no group, and also when it is the only
 * recording of its show — a one-off has no list, and drawing a list of one is
 * worse than drawing none.
 */
export function siblingEpisodes<T extends Episode>(rec: T, all: T[]): T[] {
  const key = seriesKey(rec);
  if (key === null) return [];
  const group = all.filter((e) => seriesKey(e) === key);
  return group.length > 1 ? orderEpisodes(group) : [];
}
