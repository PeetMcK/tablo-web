/**
 * What the viewer wants from captions, beyond on and off.
 *
 * Two settings, because two different people complained about two different
 * things and neither answer is right for both.
 *
 * Placement is the one viewers have opinions about. Following the
 * broadcaster's window is what the standards are for - it dodges a news
 * banner, it moves off a speaker's face - and it is also restless, because
 * the captions move whenever the broadcaster moves them. Some people want
 * them to sit still.
 *
 * Standard is mostly for us. Both decoders run on every stream, so choosing
 * between them costs nothing and makes "which of these two is wrong" a
 * question you can answer by flipping a switch on live television instead of
 * by reading a log.
 */

export type CaptionPlacement = "broadcast" | "bottom";
export type CaptionStandardChoice = "auto" | "cea608" | "cea708";

export interface CaptionPreferences {
  placement: CaptionPlacement;
  standard: CaptionStandardChoice;
}

export const DEFAULT_CAPTION_PREFERENCES: CaptionPreferences = {
  // As broadcast, because that is what the broadcaster meant and what a
  // television does.
  placement: "broadcast",
  // Whichever the stream carries, which is what it did before there was a
  // choice at all.
  standard: "auto",
};

const PLACEMENT_KEY = "tablo.cc.placement";
const STANDARD_KEY = "tablo.cc.standard";

const PLACEMENTS: CaptionPlacement[] = ["broadcast", "bottom"];
const STANDARDS: CaptionStandardChoice[] = ["auto", "cea608", "cea708"];

/**
 * Read the stored preferences, falling back to the defaults.
 *
 * Anything unrecognized is treated as unset rather than honored: the values
 * come from a store a person can edit, and a typo should not put the player
 * in a state with no name.
 */
export function loadCaptionPreferences(): CaptionPreferences {
  const read = <T extends string>(key: string, allowed: T[], fallback: T): T => {
    try {
      const stored = localStorage.getItem(key) as T | null;
      return stored && allowed.includes(stored) ? stored : fallback;
    } catch {
      // A browser with storage switched off still gets to watch television.
      return fallback;
    }
  };

  return {
    placement: read(PLACEMENT_KEY, PLACEMENTS, DEFAULT_CAPTION_PREFERENCES.placement),
    standard: read(STANDARD_KEY, STANDARDS, DEFAULT_CAPTION_PREFERENCES.standard),
  };
}

export function saveCaptionPreferences(preferences: CaptionPreferences): void {
  try {
    localStorage.setItem(PLACEMENT_KEY, preferences.placement);
    localStorage.setItem(STANDARD_KEY, preferences.standard);
  } catch {
    /* not worth failing over */
  }
}
