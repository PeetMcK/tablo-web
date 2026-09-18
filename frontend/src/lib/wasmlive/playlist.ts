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
  /**
   * The index is complete: this is the whole recording and it will not grow.
   *
   * Read rather than ignored because it is the only thing that separates an
   * ending from a wait. A session that has been handed every segment the index
   * names has stopped for one of two reasons - the media ran out, or the device
   * has not written the next piece yet - and from the decoder's side those look
   * the same. This tag is the difference, and a recording still being written
   * gains it the moment the device finishes.
   */
  endList: boolean;
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
  let endList = false;

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
    } else if (line === "#EXT-X-ENDLIST") {
      endList = true;
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

  return { targetDuration, mediaSequence, programDateTimeMs, segments, endList };
}

export function playlistWindow(
  pl: MediaPlaylist,
  originMs: number,
): { start: number; end: number } {
  if (!pl.segments.length) return { start: 0, end: 0 };
  const held = pl.segments.reduce((sum, s) => sum + s.duration, 0);
  // A playlist with no date is a recording: media time is elapsed time from
  // the start of it, so the window simply begins at zero.
  //
  // Returning an empty window instead — which is what this did — makes every
  // seek look like it is past the end, so `segmentAt` clamps to the last
  // segment. Measured: resuming a 45 minute recording at 42:58 fed segment
  // 2680 of 2680, a final 0.2s fragment with too little in it for the demuxer
  // to name a stream, and the session died with "decode error".
  if (pl.programDateTimeMs === null) return { start: 0, end: held };
  const start = (pl.programDateTimeMs - originMs) / 1000;
  return { start, end: start + held };
}

export function segmentAt(
  pl: MediaPlaylist,
  originMs: number,
  mediaSeconds: number,
): SegmentLocation | null {
  const { start, end } = playlistWindow(pl, originMs);
  if (!pl.segments.length) return null;
  // Rewinding past the window lands on the oldest thing that still exists,
  // rather than refusing to play anything.
  if (mediaSeconds < start) {
    return { index: 0, startSeconds: start, sequence: pl.mediaSequence };
  }
  // And asking for the live edge lands on the newest, for the same reason.
  //
  // This returned null, and the caller read null as "start from the beginning
  // of the window" — so dragging the scrubber to the right-hand end jumped the
  // viewer up to an hour *back*. It is not an edge case: the player clamps
  // inclusively to a range end that is up to half a second stale, and the ring
  // gains a segment every second or so, so roughly half of all drags to the end
  // asked for a time at or past it.
  if (mediaSeconds >= end) {
    const index = pl.segments.length - 1;
    let startSeconds = start;
    for (let i = 0; i < index; i++) startSeconds += pl.segments[i].duration;
    return { index, startSeconds, sequence: pl.mediaSequence + index };
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
