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
 * backstop and becomes the policy. At 59.94 fields a second the session's
 * lookahead of two seconds is about 120 fields; a cap of 96 sat below that and
 * filled in normal running, and a full queue evicting from the front drew
 * three fields a second out of sixty on the real device.
 *
 * The cost is memory, and it is the real argument against this design. The two
 * fields of a frame share one 3.1MB I420 buffer, so 200 fields is 100 frames
 * and 311MB at the cap; pacing keeps it nearer 120-150 fields, 190-230MB, in
 * normal running. ffplay holds *three frames* and blocks its decoder thread on
 * a condvar when they are full, bounding compressed input at 15MB instead;
 * jsmpeg keeps no decoded queue at all and decodes inside the animation frame.
 * Both hold bytes and decode just in time, which is what this should become —
 * the worker keeping the compressed segments and decoding only while the page
 * has credit. That is a redesign of the transport rather than a constant.
 */
export const MAX_QUEUED_FRAMES = 200;

/**
 * Draw the newest field whose moment has come, and discard what it passed.
 *
 * There was a rule here that drew the *oldest* due field unless three or more
 * were waiting, and it was wrong. It came from a real measurement — 47
 * presentations a second against the 59.94 offered — but the wrong diagnosis:
 * those were animation frames the main thread had missed, and drawing an old
 * field on the next tick does not recover a missed one, it just shows the
 * viewer something stale.
 *
 * What it produced at any tick rate below the field rate was an oscillation.
 * At 30Hz — battery saver, an occluded window, a main thread under load — two
 * fields are due and the oldest is drawn 33ms late; then three are due and the
 * oldest is drawn 50ms late; then four, and the rule finally jumps to the
 * newest and throws three away. The picture slides up to 66ms behind the sound
 * and snaps back, three times a second.
 *
 * Neither reference does this. ffplay's `video_refresh` drops a frame whenever
 * the one after it is also due, so it never shows a frame whose successor has
 * already arrived; jsmpeg simply shows the newest. Both keep the picture on the
 * clock and let the display rate be whatever it is.
 */
export function selectFrame<T extends Timed>(queue: T[], clockSeconds: number): Selection<T> {
  let lastDue = -1;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].ptsSeconds <= clockSeconds) lastDue = i;
    else break;
  }
  if (lastDue < 0) return { present: null, drop: [], keep: queue.slice() };

  return {
    present: queue[lastDue],
    drop: queue.slice(0, lastDue),
    keep: queue.slice(lastDue + 1),
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
