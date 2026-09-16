# The Live Bar Is a Programme, Not a Buffer

The live scrubber spans the airing you are watching — 8:00 to 9:00 for the news
hour — and the playhead sits where you are inside it. Joining at 8:15 lands a
quarter of the way along.

## Problem

The live bar today spans `video.seekable`: whatever FFmpeg has written to the
rolling DVR window. That window starts empty when you tune in and grows a second
per second, so the bar means something different every second it is open.

Concretely, tuning into an 8:00–9:00 news hour at 8:15 gives a bar reading
`0:00 … LIVE` with the thumb pinned at the right edge. Five minutes later it is
still pinned at the right edge, and the bar is five minutes wider. Nothing on
screen says the programme is an hour long, that a quarter of it happened before
you arrived, or how much of it you could rewind into. The only readable state is
"live", which the LIVE badge already says.

The recording player has none of these problems, because a recording has a fixed
length and a bar that maps onto it. Live should read the same way. The
information exists — the guide mirror knows every airing, and the DVR window
knows what is on disk — it is simply not what the bar is drawn from.

## Approach

Draw the bar over **the airing's wall-clock window**, and draw what is on disk
as a band inside it.

Three layers, from the outside in:

1. **The domain** is the airing: `start` to `start + duration`. It is fixed for
   the length of the programme, so the bar stops moving under the viewer.
2. **The ready band** is the DVR window — the part of the programme that exists
   on disk and can be seeked into. It grows from the moment you tuned in toward
   the live edge, and keeps growing while paused until it hits the disk cache
   limit.
3. **The playhead** is where you are, which during normal live playback sits at
   the right edge of the ready band and drifts left as you pause or rewind.

The stretch before you tuned in is drawn as empty track: visible, so the quarter
you missed is legible, and not seekable, because it does not exist anywhere.

### Anchoring media time to wall clock

The player's timeline is in media seconds from the start of the FFmpeg session.
The airing is in wall-clock time. The bar needs both, so one anchor ties them
together: the first moment a playlist exists, `anchor = { wallMs: Date.now(),
media: seekableEnd }`. Every later conversion is arithmetic on that anchor —
media and wall clock advance at the same rate, and the encoder's lag is a
constant that the anchor absorbs.

Anchoring once, rather than recomputing from `Date.now()` on every render, is
what keeps the bar still. A live recomputation would jitter by however long ago
the clock last ticked, and would fight the playhead on every frame.

### Why not the alternatives

**Keep the DVR window, add a programme label.** Cheapest, and it was the
starting point. Rejected because the bar is the thing being read: a viewer
scrubbing back looks at where the thumb is, not at a caption, and a bar whose
width changes every second cannot answer "how far into the show am I".

**Scale the bar to a fixed rolling hour ending at the live edge.** Stable width,
no guide data needed. Rejected because the hour it draws is not any hour that
exists — the show does not start at "60 minutes ago", and the thumb would sit at
the right edge forever, which is the current problem with extra steps.

**Derive the programme window from the DVR window's start.** No guide lookup:
assume the show started when you tuned in. Wrong by construction for every
viewer who did not tune in exactly on the hour, which is all of them.

## Rollover

At 9:00 the bar re-scales to the 9:00 airing and the title block follows. That
needs the channel's *upcoming* airings, which the player does not have: the live
tab carries `current_program` only, one airing deep.

The guide mirror already holds them. A small read-only endpoint —
`GET /api/channels/{identifier}/airings` — serves the airings for one channel
from SQLite, and the player picks whichever contains **the instant being
watched**, re-picking as the playhead passes each boundary. No device round
trip, no new sync, and the same query answers "what is on next" for any later
caller.

The instant being watched, rather than the current time: they are the same at
the live edge, and only the first is right anywhere else. A viewer who paused
at 8:55 and came back at 9:10 is still watching the eight o'clock show, and a
bar that re-scaled to the nine o'clock one would strand the thumb at the far
left of a programme that is not on screen, under a title naming the wrong
thing.

When the mirror has nothing for the channel, the player keeps the airing it was
opened with until that ends, then falls back to the DVR bar below.

## Without a schedule

An OTT channel, or any channel the guide does not cover, keeps exactly today's
behaviour: the bar spans the DVR window, `0:00 … LIVE`. The programme bar is an
enhancement on top of a fallback that must stay working, not a replacement for
it. The same fallback catches an airing whose `duration` is missing or zero.

## What the viewer sees

- **Ends of the bar** read as clock times — `8:00 PM` and `9:00 PM` — rather than
  elapsed durations. A duration on a live bar would have to be measured from a
  moment the viewer did not choose.
- **Hovering** anywhere reads back the clock time under the pointer, so scrubbing
  to "about 8:40" is aimable.
- **Clicking before the ready band** snaps to the earliest moment on disk rather
  than doing nothing: the intent is unambiguous, and refusing it silently reads
  as a broken control.
- **Pausing** leaves the playhead where it is and lets the ready band grow past
  it — the show spooling onto disk ahead of you, until the DVR window's limit.
- **Passing the live edge** is impossible: the right end of the ready band is the
  live edge, and both the scrubber and the skip buttons stop there.

## Boundaries

Out of scope: recording the programme to keep, any change to the DVR window's
length, catch-up into airings that finished before the session started (nothing
is on disk for them), and the guide grid's own timeline.
