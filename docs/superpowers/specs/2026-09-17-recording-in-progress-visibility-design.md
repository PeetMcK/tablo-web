# Seeing what is recording, everywhere — design

**Date:** 2026-09-17
**Status:** proposed

## The problem

A recording in progress is visible in exactly one place: its card in the
Library, which gained a `Recording` badge, a coverage bar and two entry points
earlier today. Everywhere else the app is blind to it.

- **The Library card has no way into the show's information.** The info sheet
  exists and is good — artwork, synopsis, season/episode, rating, genre, and
  the record controls — but only Live and Guide can open it.
- **Live and Guide do not know a programme is being recorded right now.** They
  know `scheduled`, which means *will* record, and nothing about in-flight.
- **Their progress bars measure the wrong thing.** Both draw how far through
  the programme the clock is. Neither says how much of it was captured, which
  is the question a viewer actually has once recording is involved.
- **The info sheet cannot stop a recording**, and does not refresh while open,
  so anything it says about an in-progress recording goes stale as you read it.

## What already exists

Worth stating, because it makes this smaller than it looks.

| Thing | Where |
|---|---|
| The info sheet, with Record / Don't Record and series All-New-None | `ShowInfo.tsx`, opened from Live and Guide |
| Stopping an episode recording | `PUT /api/schedule/airing {scheduled: false}` — its docstring is "Record, or stop recording, one episode" |
| The coverage-bar arithmetic | `recordedSpan` in `LibraryView.tsx` |
| True start and expected length | `recorded_seconds`, `expected_seconds`, `recording_started`, from `recorded_offsets` |
| Channel identity on a recording | `airing_details.channel.channel_identifier`, e.g. `S34654_008_01` — already in the device record, not yet projected |

That last row is the key that makes the rest join up: it is the same identifier
the guide is keyed by, so a recording and a guide airing match on
`(channel_identifier, start)` with no fuzzy matching.

## The shape

### One source of truth for "recording now"

Three views need the same answer, so the server answers it once:

```
GET /api/recordings/in-progress
{ "recordings": [ {
    "object_id": 86113,
    "channel_identifier": "S34654_008_01",
    "start": "2026-09-17T16:00Z",      // scheduled — the guide key
    "duration": 3600,                   // the scheduled slot
    "recording_started": "2026-09-17T16:20:59Z",
    "recorded_seconds": 1020,
    "expected_seconds": 2341,
    "title": "Let's Make a Deal"
} ] }
```

**Deliberately its own endpoint rather than fields on the guide.** The guide is
a large payload synced into SQLite and cached hard; recording state is volatile
and changes every few seconds. Threading one into the other would mean
invalidating a synced guide on a timer, which is the wrong trade for a list
that is almost always empty and never longer than the tuner count. A handful of
rows, polled on the interval the view already polls at, keyed client-side into a
`Map` of `` `${channel}|${start}` ``.

Everything in it is already computed for the Library listing; this is a
projection of the same fields, not new arithmetic.

### The coverage bar, shared

The bar built for the Library card is the right one everywhere: **the strip is
the scheduled slot end to end, and the filled span is what was actually
captured, positioned where it falls.** A recording that started twenty minutes
late reads as twenty minutes late at a glance, where a bar drawn flush-left is
indistinguishable from one that caught the whole show.

`recordedSpan` moves out of `LibraryView` into `lib/recording.ts` so the guide
row, the live card and the info sheet draw the identical geometry from the
identical inputs. Live and Guide keep their existing programme-progress bar when
nothing is recording; the coverage bar replaces it when something is.

### The info sheet becomes the place recordings are managed

Reached from all three views, including — new — the Library card, via an info
button beside the title.

While the airing is recording it gains a block above the existing record
controls:

- `REC · RECORDING NOW`, the coverage bar, and `20m of 39m captured of a 1h 0m
  slot, since 10:20 AM`.
- **Stop Recording**, which is `scheduled: false` on the existing endpoint.
  Destructive and irreversible — the captured portion is kept, but recording
  does not resume — so it confirms first through the existing `ConfirmDialog`.
- The series controls stay exactly as they are.

It refreshes on the same poll as everything else while it is open, so the bar
and the figure move rather than freezing at whatever they were when it opened.

### Scope held out, deliberately

- **What the play buttons do on Live and Guide is unchanged.** Explicitly out,
  per the request.
- **No new artwork** for the Library card's info route: the sheet fetches the
  airing's own image as it already does.

## Risks and unknowns

1. **Whether `scheduled: false` stops an in-progress recording** is asserted by
   a docstring and tested by nothing. The only way to find out is to stop a real
   recording. If it turns out only to unschedule future episodes, Stop Recording
   is a lie and the block ships without it until the device offers something
   better. **Must be settled before the control ships.**
2. **A recording with no guide airing.** Something recorded from a channel whose
   EPG has since rolled over has no `(channel, start)` to match, so Live and
   Guide simply will not mark it — correct, since there is no row to mark. The
   Library card is unaffected: it holds the recording itself.
3. **Manual recordings started mid-show** carry a `recorded_offsets.start` of
   twenty minutes or more. The coverage bar is the only thing in the app that
   makes that visible, which is the point, but it means an in-progress card can
   legitimately show a bar that starts a third of the way along and will never
   reach the left edge.

## Testing

- The projection and the endpoint are server-side and get ordinary tests,
  including a recording whose tuner started late and one that started early.
- `recordedSpan` is pure and moves with its existing tests.
- The sheet's recording block, the badge and the bar get component tests.
- **Stopping** is verified against the device once, by hand, on a recording
  nobody minds losing — and that result is written into this document.
