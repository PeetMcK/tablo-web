# The transcode stops being a rescue — design

**Date:** 2026-09-17
**Status:** approved, not implemented
**Touches:** `frontend/src/components/VideoPlayer.tsx`

## The change in one line

The transcode is no longer what happens when MPEG-2 fails. It is what
happens when MPEG-2 was never possible, or when a complete local copy is
the thing being played.

## Why

The two paths do not produce the same picture. MPEG-2 decoded in WASM is the
device's own broadcast, deinterlaced and drawn at its native sample aspect.
The transcode is H.264 re-encoded from that, and side by side it is visibly
worse.

The fallback was written so that a decode error cost a rebuffer rather than
the programme. What it actually does is swap the good picture for the bad one
and say nothing — the viewer sees the stream get worse and has no way to know
why, or that anything happened at all. It also hides real faults: the
starvation measured on 2026-09-17 (a recording feeding at 0.77x realtime with
the decoded buffer at zero) never surfaced as a bug, because the player
quietly stopped using the path that was starving.

## What replaces it

### 1. Failure rebuilds once, then says so

A WASM session that fails is torn down and reopened — once per player
session. A second failure sets the error with the decoder's own reason and
stops. Nothing switches decoders behind the viewer's back.

Live reopens **at the live edge**, not at the playhead. The rewind position is
lost, which is a real cost, but reopening where it died risks landing on the
packet that killed it. A recording reopens at the playhead, read before
teardown, because VOD can seek and the bad packet is not necessarily where
the viewer is.

The report to `/api/debug/wasm-fallback` stays. It is the only account of
these failures that reaches the server, where whoever is diagnosing usually
is.

### 2. The transcode keeps two jobs

**A browser that cannot decode MPEG-2.** Safari has no WebGL2 pipeline here,
and a machine with acceleration disabled has no context. Those have no other
option, so they transcode exactly as they do now. The rule is "never fall
back", not "never transcode".

**A complete local copy.** A recording kept offline — `offline_only`, or
pinned with `cache_state === "complete"` — plays from that copy. It is
complete, it is local, and it plays when the device is off or no longer holds
the recording, which is the entire reason for keeping one.

### 3. A partial copy is a last resort, and says so

An incidental partial cache never pre-empts MPEG-2, which is already true
today. The one case it plays is a recording the device no longer has, where
a partial copy is the difference between watching some of it and watching
none. That case gets a notice on screen rather than a stream that ends early
with no explanation.

## What this will look like

Worse, at first. The recording that starves at 0.77x realtime currently
rescues itself into a working H.264 stream; after this it stalls visibly.
That is the intended behaviour — the fault was always there, and the player
was concealing it — but it is a regression in what the viewer experiences
until the starvation itself is fixed.

## Deliberately not doing

**Offering the viewer the choice at the moment of failure.** A dialogue
between a decode error and a black frame is worse than either answer.

**Removing the transcode encoder.** Caching a recording for offline still
produces H.264, and that is unchanged — this is about what gets *played*.

**Fixing the starvation.** Separate, measured, and not this.

## How it will be known to work

Open a recording on the MPEG-2 path and kill the session: it rebuilds at the
playhead, and a second failure reports rather than switches. Open live and do
the same: it rebuilds at the live edge. A Safari-class browser still plays
both. A pinned, fully cached recording still plays from the cache. And a
recording whose MPEG-2 will not open, with no complete copy, now shows an
error instead of quietly playing the transcode.
