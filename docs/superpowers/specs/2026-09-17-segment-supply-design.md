# Fetching ahead of the decoder — design

**Date:** 2026-09-17
**Status:** approved, not implemented
**Touches:** `frontend/src/lib/wasmlive/session.ts`, new
`frontend/src/lib/wasmlive/supply.ts`

## The symptom

Playback stutters, with short gaps in the sound. Measured on recording 86137
(704x480 480i) on 2026-09-17: the audio buffer oscillates between about 1.3s
and zero, touching zero several times a minute, and each touch is a dropped
field and a hole in the sound.

## What it is not

Decode. Instrumenting `ff_decode_multi` gave **0.021–0.042** of the realtime
budget — about 1ms per frame — across every window sampled. Even at six times
the pixels, 1080i leaves decode near a fifth of budget. The decoder is not
the constraint and adding buffer in front of it was never the fix.

Supply throughput either. A segment fetch through the backend to the device
measured **~310ms for ~1s of media**, so supply costs about 0.31 of realtime,
and four concurrent fetches finished in 478ms against 1267ms serial — a
**2.65x** speedup, so the device pipelines happily.

The instrumentation showed `readMs` consuming almost the whole window, which
looked like device latency and is not: the read pump is blocked waiting for
the transport to hand it the next segment, and the transport is holding back
on purpose.

## What it is

**Fetching and decoding are the same act.** `poll()` in `session.ts` awaits
`fetchBytes` inline and posts the result straight to the worker, which decodes
it immediately. There is nowhere for compressed bytes to wait.

That forces the only buffer in the system to be decoded fields, which cost
about 1.5MB each at 1080i — hence `MAX_QUEUED_FRAMES = 200`, and hence the
comment on `LOOKAHEAD_SECONDS` that it "must stay comfortably under what the
field queue holds". Two seconds is not a tuning mistake; it is the largest
window a raw-field buffer can afford.

Two seconds of slack against a supply that costs 0.31 of realtime is
comfortable on average and fails on variance. One slow device round trip, one
delayed poll, and the buffer is empty — which is exactly the pattern in the
log.

Every mature player avoids this by keeping two queues: ffplay pairs a
byte-sized `PacketQueue` with a three-frame picture queue; hls.js and
ExoPlayer hold tens of seconds of *compressed* media and let the decoder run
on its own. We have the picture queue and no packet queue.

## The design

A segment supply sits between the playlist and the decoder. It fetches ahead,
concurrently, and holds compressed bytes; the transport takes from it instead
of awaiting the network.

```ts
export interface SegmentSupply {
  /** Bytes for this segment: immediate if held, otherwise the fetch in flight. */
  take(sequence: number, url: string): Promise<ArrayBuffer>;
  /** What exists and where feeding has reached, so it knows what to fetch. */
  advise(upcoming: PlannedSegment[]): void;
  /** Abandon everything held and in flight — a seek, or a new epoch. */
  reset(): void;
  /** Compressed media held, in seconds, for diagnostics. */
  readonly heldSeconds: number;
  readonly inFlight: number;
}
```

Three rules govern it:

- **Fetch ahead by time, not by count.** A target in seconds of compressed
  media, so a device with long segments and one with short segments behave the
  same.
- **Bounded concurrency.** Enough to beat per-request latency, few enough not
  to bury the device. The measurement says the returns are there at four.
- **Bounded memory.** A byte ceiling as well as a time target, because bitrate
  varies and a time target alone does not bound anything.

### What does not change

The decode pacing. `LOOKAHEAD_SECONDS`, `MIN_BUFFER_SECONDS`,
`COMFORTABLE_BUFFER_SECONDS`, `QUEUE_HIGH_WATER` and the field queue all stay
exactly as they are, and they keep meaning what they mean: how far *decode*
may run ahead, which is bounded by memory in raw planes. This change gives
the transport a place to wait that costs 20MB instead of 2GB — it does not
ask the decoder to run further ahead.

The wire format, the backend, the worker protocol and the presenter are
untouched.

### Seeks

A seek abandons the supply. Bytes fetched for the old position are worthless,
and worse than worthless if they reach the worker after a reset — the seek
race this codebase already knows about. `reset()` drops held bytes and marks
in-flight fetches stale, and the epoch check that already guards the worker
post stays where it is.

## How it will be known to work

The audio buffer stops touching zero. That is the measurement: today it dips
to 0.0–0.06 several times a minute on a 480i recording; after this it should
sit near its `COMFORTABLE_BUFFER_SECONDS` mark with the supply holding
seconds of compressed media behind it.

Diagnostics gain `heldSeconds` and `inFlight`, so `tabloDebug()` can answer
"is the transport waiting on the network, or on its own pacing?" — the
question this investigation could not answer without a temporary build.

## Deliberately not doing

**Backend read-ahead.** Complementary and cheaper than it looks, but it helps
only while the backend guesses right about what comes next, and the browser
still has nowhere to put bytes. Do it after, if the measurement still asks
for it.

**Caching MPEG-2 rather than H.264.** The cache stores a transcode, so a
recording kept offline plays the worse picture and a cached recording still
round-trips to the device for every segment. Storing the original segments
would make kept recordings local, original-quality and immune to this
entirely — at roughly 5GB/hour against 2GB. It is the better architecture and
it is a different project.

**Raising the decode lookahead.** The constraint that keeps it at two seconds
is real and stays real.
