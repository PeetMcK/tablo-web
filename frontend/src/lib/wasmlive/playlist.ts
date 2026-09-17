/**
 * The ring's playlist, read as media time.
 *
 * Media time is seconds since the session began, which is what the player's
 * bar and scrubber are already drawn in. The ring dates its first held segment
 * with EXT-X-PROGRAM-DATE-TIME, so the offset survives the window sliding out
 * from under a viewer who is paused.
 */

export interface PlaylistSegment {
  uri: string;
  duration: number;
}

export interface MediaPlaylist {
  targetDuration: number;
  mediaSequence: number;
  programDateTimeMs: number | null;
  segments: PlaylistSegment[];
}

export interface SegmentLocation {
  index: number;
  startSeconds: number;
  /** Absolute media sequence, which is stable as the window slides. */
  sequence: number;
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const segments: PlaylistSegment[] = [];
  let targetDuration = 6;
  let mediaSequence = 0;
  let programDateTimeMs: number | null = null;
  let duration: number | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || targetDuration;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const parsed = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      if (Number.isFinite(parsed) && programDateTimeMs === null) programDateTimeMs = parsed;
    } else if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice("#EXTINF:".length));
    } else if (line.startsWith("#")) {
      // Another tag between the EXTINF and its uri — a discontinuity, say. It
      // must not clear the duration waiting to be claimed.
      continue;
    } else if (duration !== null) {
      segments.push({ uri: line, duration });
      duration = null;
    }
  }

  return { targetDuration, mediaSequence, programDateTimeMs, segments };
}

export function playlistWindow(
  pl: MediaPlaylist,
  originMs: number,
): { start: number; end: number } {
  if (!pl.segments.length || pl.programDateTimeMs === null) return { start: 0, end: 0 };
  const start = (pl.programDateTimeMs - originMs) / 1000;
  const held = pl.segments.reduce((sum, s) => sum + s.duration, 0);
  return { start, end: start + held };
}

export function segmentAt(
  pl: MediaPlaylist,
  originMs: number,
  mediaSeconds: number,
): SegmentLocation | null {
  const { start, end } = playlistWindow(pl, originMs);
  if (!pl.segments.length) return null;
  if (mediaSeconds >= end) return null;
  // Rewinding past the window lands on the oldest thing that still exists,
  // rather than refusing to play anything.
  if (mediaSeconds < start) {
    return { index: 0, startSeconds: start, sequence: pl.mediaSequence };
  }

  let at = start;
  for (let index = 0; index < pl.segments.length; index++) {
    const next = at + pl.segments[index].duration;
    if (mediaSeconds < next) {
      return { index, startSeconds: at, sequence: pl.mediaSequence + index };
    }
    at = next;
  }
  return null;
}

/**
 * The first segment to take when starting near the live edge.
 *
 * Counted back from the newest segment by duration, deliberately, rather than
 * looked up by media time. The ring dates its segments when it fetched them,
 * and a primed session fetches the device's whole backlog in one go — so forty
 * seconds of media arrive carrying almost the same timestamp, and a media-time
 * target computed from those stamps lands far behind the live edge. Measured:
 * a window of 0:01-1:20 starting playback at 0:55, twenty-five seconds late,
 * and every fresh session on a channel replaying the same content.
 *
 * Segment durations are the device's own and need no such interpretation.
 */
export function startNearEdge(
  playlist: MediaPlaylist,
  behindSeconds: number,
): SegmentLocation | null {
  const { segments } = playlist;
  if (!segments.length) return null;

  let index = segments.length - 1;
  let behind = segments[index].duration;
  while (index > 0 && behind + segments[index - 1].duration <= behindSeconds) {
    index -= 1;
    behind += segments[index].duration;
  }

  let startSeconds = 0;
  for (let i = 0; i < index; i++) startSeconds += segments[i].duration;
  return { index, startSeconds, sequence: playlist.mediaSequence + index };
}
