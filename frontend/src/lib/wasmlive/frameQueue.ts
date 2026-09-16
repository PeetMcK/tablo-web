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

export const MAX_QUEUED_FRAMES = 8;

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
