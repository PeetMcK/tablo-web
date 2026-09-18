/**
 * A place for compressed segments to wait.
 *
 * Fetching and decoding used to be the same act: the transport awaited a
 * segment and posted it straight to the worker, which decoded it on arrival.
 * That left decoded fields as the only buffer in the system, and a field is
 * about 1.5MB at 1080i — which is why the field queue holds 200 of them and
 * why the decode lookahead has to stay near two seconds.
 *
 * Two seconds is comfortable against a supply costing 0.31 of realtime, and
 * fails on variance: one slow device round trip empties the audio buffer, and
 * an empty audio buffer is a dropped field and a hole in the sound. Measured
 * on 2026-09-17, the buffer touched zero several times a minute.
 *
 * So bytes queue here instead, ahead of the decoder and concurrently, in the
 * pairing every mature player has — ffplay's byte-sized packet queue beside
 * its three-frame picture queue; the tens of seconds hls.js holds in a
 * SourceBuffer. Twelve seconds of compressed media costs about 20MB. The same
 * depth in decoded fields would cost two gigabytes, which is the whole reason
 * this is a separate queue rather than a bigger one.
 */

export interface PlannedSegment {
  sequence: number;
  url: string;
  durationSeconds: number;
}

export interface SegmentSupply {
  /**
   * Bytes for this segment: immediately if held, otherwise the fetch already
   * in flight, otherwise one started now.
   */
  take(sequence: number, url: string): Promise<ArrayBuffer>;
  /** What is coming, in playlist order, so it knows what to fetch ahead. */
  advise(upcoming: PlannedSegment[]): void;
  /** Abandon everything held and in flight. A seek, or a new epoch. */
  reset(): void;
  /** Compressed media held, in seconds. */
  readonly heldSeconds: number;
  readonly heldBytes: number;
  readonly inFlight: number;
}

/**
 * Seconds of compressed media to keep ahead of the decoder.
 *
 * About four times the worst gap measured, and 15-20MB at this device's 1080i
 * rate. Deliberately far larger than the decode lookahead, which is bounded
 * by what raw planes cost and cannot grow.
 */
const TARGET_SECONDS = 12;

/**
 * And a ceiling in bytes, because seconds bound nothing on their own.
 *
 * This device runs about 4 Mbit/s for 480i and up to 17 for 1080i, so a time
 * target alone varies fourfold in memory.
 */
const MAX_BYTES = 24 * 1024 * 1024;

/**
 * Fetches in flight at once.
 *
 * Measured against the device on 2026-09-17: four concurrent segment fetches
 * finished in 478ms where four serial ones took 1267ms — a 2.65x speedup,
 * with per-request time rising only from about 310ms to 440ms, so it
 * pipelines rather than serialising internally. Three keeps most of that and
 * leaves the device a lane for the live ring's own follower.
 */
const CONCURRENCY = 3;

interface Held {
  bytes: ArrayBuffer;
  durationSeconds: number;
}

export function createSegmentSupply(deps: {
  fetchBytes(url: string): Promise<ArrayBuffer>;
  targetSeconds?: number;
  maxBytes?: number;
  concurrency?: number;
}): SegmentSupply {
  const targetSeconds = deps.targetSeconds ?? TARGET_SECONDS;
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  const concurrency = deps.concurrency ?? CONCURRENCY;

  const held = new Map<number, Held>();
  const pending = new Map<number, Promise<ArrayBuffer>>();
  /** Seconds of media each in-flight fetch will add, for the target sum. */
  const pendingSeconds = new Map<number, number>();
  let plan: PlannedSegment[] = [];
  /**
   * Which era of the stream this is.
   *
   * A seek makes everything outstanding worthless, and worse than worthless
   * if it lands afterwards and is treated as current — the same race the
   * worker's epoch guard exists for. A fetch resolving into a stale
   * generation is dropped rather than held.
   */
  let generation = 0;

  let heldBytes = 0;
  let heldSeconds = 0;

  const inFlightSeconds = () => {
    let total = 0;
    for (const seconds of pendingSeconds.values()) total += seconds;
    return total;
  };

  const start = (segment: PlannedSegment) => {
    const mine = generation;
    pendingSeconds.set(segment.sequence, segment.durationSeconds);
    const fetching = deps.fetchBytes(segment.url);
    pending.set(segment.sequence, fetching);
    void fetching.then(
      (bytes) => {
        pending.delete(segment.sequence);
        pendingSeconds.delete(segment.sequence);
        if (mine !== generation) return;
        held.set(segment.sequence, { bytes, durationSeconds: segment.durationSeconds });
        heldBytes += bytes.byteLength;
        heldSeconds += segment.durationSeconds;
        pump();
      },
      () => {
        // A dropped request is not the end of the session — the transport
        // asks again on the next poll, and `take` still surfaces the error to
        // whoever was waiting on this segment. Latching it here would make a
        // transient failure permanent.
        pending.delete(segment.sequence);
        pendingSeconds.delete(segment.sequence);
        if (mine !== generation) return;
        unplan(segment.sequence);
        // Deliberately no `pump()`. Every ceiling below is measured on media
        // *held*, and a failed fetch holds nothing — so a failure could never
        // reach the target and pumping on one walked the entire remaining
        // plan at full concurrency, as fast as the endpoint could refuse.
        //
        // That is where the 404 storms came from. Measured: one advise over a
        // 1,260-segment plan against an endpoint answering 404 issued 1,260
        // requests in under 200ms, and since `takenThrough` only advances on
        // success, the next poll re-planned the lot and swept again. Two
        // sweeps is the 2,316 messages in the console screenshot; four is the
        // 4,716.
        //
        // Stopping here costs nothing real. This queue is speculative: the
        // transport's own `take` fetches what it actually needs and surfaces
        // the failure to whoever is waiting, and the next `advise` restarts
        // the prefetch a poll later.
      },
    );
  };

  const pump = () => {
    for (const segment of plan) {
      if (pending.size >= concurrency) return;
      if (heldBytes >= maxBytes) return;
      if (heldSeconds + inFlightSeconds() >= targetSeconds) return;
      if (held.has(segment.sequence) || pending.has(segment.sequence)) continue;
      start(segment);
    }
  };

  /**
   * Forget a segment, so the pump does not fetch it again.
   *
   * The transport walks a playlist forwards and never asks twice, so once it
   * has taken a segment the plan is done with it — and without this the pump
   * sees a sequence that is neither held nor pending and fetches it straight
   * back. The same applies to one that failed: retrying it here would spin on
   * it for ever, where `take` surfaces the error to the caller who actually
   * wanted it.
   */
  const unplan = (sequence: number) => {
    plan = plan.filter((segment) => segment.sequence > sequence);
  };

  const drop = (sequence: number) => {
    const entry = held.get(sequence);
    if (!entry) return;
    held.delete(sequence);
    heldBytes -= entry.bytes.byteLength;
    heldSeconds -= entry.durationSeconds;
  };

  return {
    take(sequence: number, url: string): Promise<ArrayBuffer> {
      const ready = held.get(sequence);
      if (ready) {
        drop(sequence);
        unplan(sequence);
        pump();
        return Promise.resolve(ready.bytes);
      }

      const inFlight = pending.get(sequence);
      if (inFlight) {
        // Joining rather than starting a second fetch: the transport reaching
        // a segment the supply is already fetching is the ordinary case.
        return inFlight.then((bytes) => {
          drop(sequence);
          unplan(sequence);
          pump();
          return bytes;
        });
      }

      // Never planned for — a seek lands somewhere the last advise did not
      // cover, and playback must not wait for the next poll to say so.
      const mine = generation;
      const fetching = deps.fetchBytes(url);
      pending.set(sequence, fetching);
      pendingSeconds.set(sequence, 0);
      return fetching.then(
        (bytes) => {
          pending.delete(sequence);
          pendingSeconds.delete(sequence);
          if (mine === generation) { unplan(sequence); pump(); }
          return bytes;
        },
        (e) => {
          pending.delete(sequence);
          pendingSeconds.delete(sequence);
          if (mine === generation) pump();
          throw e;
        },
      );
    },

    advise(upcoming: PlannedSegment[]) {
      plan = upcoming;
      // Anything held that the plan has moved past is dead weight: the
      // transport only ever walks forwards through a playlist, and after a
      // seek the generation has turned over anyway.
      const wanted = new Set(upcoming.map((s) => s.sequence));
      for (const sequence of [...held.keys()]) {
        if (!wanted.has(sequence)) drop(sequence);
      }
      pump();
    },

    reset() {
      generation += 1;
      held.clear();
      pending.clear();
      pendingSeconds.clear();
      plan = [];
      heldBytes = 0;
      heldSeconds = 0;
    },

    get heldSeconds() { return heldSeconds; },
    get heldBytes() { return heldBytes; },
    get inFlight() { return pending.size; },
  };
}
