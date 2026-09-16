/**
 * What to put on screen, and what to throw away.
 *
 * Video is slaved to the audio clock: the presenter shows the newest entry
 * that is due and discards everything it skipped past. The queue holds field
 * presentations rather than frames — an interlaced frame is drawn twice, half
 * a frame apart — but nothing here needs to know that, only that entries carry
 * a time.
 *
 * The cap is not housekeeping. At 60p, 1080p frames arriving faster than they
 * are drawn will exhaust memory in seconds, so admission evicts from the front.
 */

export interface Timed {
  ptsSeconds: number;
}

export interface Selection<T> {
  present: T | null;
  drop: T[];
  keep: T[];
}

/**
 * How many field presentations may be held at once.
 *
 * Decode is bursty: a 1.5s segment arrives whole and decodes in about a fifth
 * of a second, producing ~45 frames and so ~90 field presentations, all of
 * them timestamped across the next second and a half. A cap of 8 threw away
 * nine tenths of every segment before its moment arrived — measured at half a
 * field per second reaching the screen, against the 60 it should be.
 *
 * The cost is memory: the two fields of a frame share one 3.1MB I420 buffer,
 * so 96 fields is ~48 frames, ~150MB at the theoretical peak and far less in
 * practice because presentation drains the queue as fast as decode fills it.
 * That is the going rate for buffering decoded 1080p; it is why the transport
 * paces at all rather than letting the decoder run at its full 8x.
 */
export const MAX_QUEUED_FRAMES = 96;

export function selectFrame<T extends Timed>(queue: T[], clockSeconds: number): Selection<T> {
  let presentIndex = -1;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].ptsSeconds <= clockSeconds) presentIndex = i;
    else break;
  }
  if (presentIndex < 0) return { present: null, drop: [], keep: queue.slice() };

  // The newest due entry is drawn however late it is: showing something the
  // viewer can see beats showing nothing while the clock runs on.
  return {
    present: queue[presentIndex],
    drop: queue.slice(0, presentIndex),
    keep: queue.slice(presentIndex + 1),
  };
}

export function admit<T extends Timed>(
  queue: T[],
  entry: T,
  cap: number = MAX_QUEUED_FRAMES,
): { queue: T[]; dropped: T[] } {
  const next = [...queue, entry];
  const dropped: T[] = [];
  while (next.length > cap) dropped.push(next.shift() as T);
  return { queue: next, dropped };
}
