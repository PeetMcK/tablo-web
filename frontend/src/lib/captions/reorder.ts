/**
 * Holding caption bytes until their order is settled.
 *
 * The decoder hands packets over in decode order, a read round at a time, and
 * MPEG-2 reorders for B-frames — so a picture that belongs earlier in display
 * order routinely arrives in the next round. Sorting within a round is not
 * enough.
 *
 * Both caption standards need this and neither tolerates disorder. 608 is a
 * command stream, where the wrong order spells the wrong words: measured
 * against a live broadcast, "[cheers, applause]" arrived as
 * "[cheerpps, alause]". DTVCC is worse — it is a sequenced packet protocol, so
 * bytes out of order corrupt packet reassembly rather than merely scrambling
 * text.
 */

/** How far behind the newest picture the consumer is fed from. */
export const REORDER_SECONDS = 0.5;

export interface Held<T> {
  seconds: number;
  item: T;
}

export interface ReorderBuffer<T> {
  /** Offer an item at its presentation time. */
  add(seconds: number, item: T): void;
  /**
   * Everything old enough that nothing earlier can still arrive, oldest
   * first. Half a second is well past any display reordering distance — a
   * handful of frames — and costs nothing visible, because the decoder
   * already runs seconds ahead of the playhead.
   */
  take(): Array<Held<T>>;
  /** Everything held, settled or not. For end of stream. */
  takeAll(): Array<Held<T>>;
  reset(): void;
}

export function createReorderBuffer<T>(
  windowSeconds: number = REORDER_SECONDS,
): ReorderBuffer<T> {
  let pending: Array<Held<T>> = [];
  let newest = Number.NEGATIVE_INFINITY;

  const drainTo = (upTo: number): Array<Held<T>> => {
    if (!pending.length) return [];
    // Stable, so items sharing a picture keep the order the encoder wrote
    // them in — within a picture the sequence is already correct.
    pending.sort((a, b) => a.seconds - b.seconds);

    let i = 0;
    while (i < pending.length && pending[i].seconds <= upTo) i++;
    const out = pending.slice(0, i);
    pending = i === pending.length ? [] : pending.slice(i);
    return out;
  };

  return {
    add(seconds: number, item: T) {
      pending.push({ seconds, item });
      if (seconds > newest) newest = seconds;
    },
    take: () => drainTo(newest - windowSeconds),
    takeAll: () => drainTo(Number.POSITIVE_INFINITY),
    reset() {
      pending = [];
      newest = Number.NEGATIVE_INFINITY;
    },
  };
}
