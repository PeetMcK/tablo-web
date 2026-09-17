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
 * nine tenths of every segment before its moment arrived.
 *
 * It has to exceed what the transport will feed ahead, or it stops being a
 * backstop and becomes the policy. At 59.94 fields a second, the session's
 * lookahead is about 75 fields; a cap of 96 sat close enough to that to fill in
 * normal running, and a full queue evicting from the front drew three fields a
 * second out of sixty on the real device. 120 leaves real headroom.
 *
 * The cost is memory: the two fields of a frame share one 3.1MB I420 buffer,
 * so 120 fields is ~60 frames, ~190MB at a theoretical peak that pacing means
 * we do not reach. That is the going rate for buffering decoded 1080p, and it
 * is why the transport paces at all rather than letting the decoder run at 8x.
 */
export const MAX_QUEUED_FRAMES = 150;

/**
 * How far behind the clock may fall before entries are skipped rather than shown.
 *
 * Presentation is driven by animation frames at 60Hz against fields that are
 * due every 16.68ms, so the two are always on the point of sliding past each
 * other: one frame that takes a millisecond too long leaves two fields due at
 * once. Skipping straight to the newest on every such tick threw one field in
 * five away as ordinary jitter - measured at 47 presentations a second against
 * the 59.94 offered, with the queue backing up to its cap.
 *
 * Below the threshold the oldest due field is drawn, so a late tick costs a
 * millisecond of lateness instead of a discarded field, and the next tick
 * catches up. Above it there is a real backlog - a hidden tab coming back, a
 * stall - and jumping to the newest is right, because the viewer needs to see
 * where the programme is now rather than a second of history at high speed.
 */
export const MAX_LATE_FIELDS = 3;

export function selectFrame<T extends Timed>(queue: T[], clockSeconds: number): Selection<T> {
  let lastDue = -1;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].ptsSeconds <= clockSeconds) lastDue = i;
    else break;
  }
  if (lastDue < 0) return { present: null, drop: [], keep: queue.slice() };

  // Ordinary running draws the oldest due field and lets the next tick take
  // the next; only a real backlog skips ahead to the newest.
  const presentIndex = lastDue >= MAX_LATE_FIELDS ? lastDue : 0;

  return {
    present: queue[presentIndex],
    drop: queue.slice(0, presentIndex),
    keep: queue.slice(presentIndex + 1),
  };
}

/**
 * Add an entry, dropping from the far end if the queue is full.
 *
 * The queue is time-ordered, so its front is the next field due and its back
 * is the one furthest from being needed. Evicting the front — which this did —
 * discards the picture that was about to be drawn in order to make room for
 * one over a second away, and with a decoder running at 8x realtime it does
 * that for almost every field: measured on the real device at three fields a
 * second reaching the screen against the 59.94 offered, in sync and stuttering,
 * because only the few that survived to their own moment were ever drawn.
 */
export function admit<T extends Timed>(
  queue: T[],
  entry: T,
  cap: number = MAX_QUEUED_FRAMES,
): { queue: T[]; dropped: T[] } {
  const next = [...queue, entry];
  const dropped: T[] = [];
  while (next.length > cap) dropped.push(next.pop() as T);
  return { queue: next, dropped };
}
