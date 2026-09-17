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

## Coverage on a finished recording

The same bar, for the same reason, and it turns out to matter more here than on
something still recording.

Surveyed across all fourteen recordings on the device, 2026-09-17:

```
  oid   slot    dur  start    end          covers  title
86113   3600   2106   1259   -235   35.0%- 93.5%  Let's Make a Deal  (stopped by hand)
86087   3600   2684    916      0   25.4%-100.0%  Saturday Night Live
86105   7200   3473   3786     59   52.6%-100.8%  Good Morning America
86040   3600      8   3401   -191   94.5%- 94.7%  First Civilizations
86043   3600      4   3422   -174   95.1%- 95.2%  First Civilizations
86045   3600    222   3429     51   95.2%-101.4%  First Civilizations
80888  10800  12615    -15   1800   -0.1%-116.7%  NFL Football
```

Three of those captured **four seconds, eight seconds and 3.7 minutes** of an
hour, each starting ~95% of the way through its slot. Their cards read "0m" and
"4m" today and look unremarkable. The device does not help: `error` is null and
`warnings` is empty on all three, so it does not consider them failures. The
only way to know is the coverage arithmetic.

**Decisions:**

- **The strip is coverage, everywhere.** Cache progress gives it up, and keeps
  the corner badge, the `45% · 27m of 1h 0m` detail row and the live transfer
  rate — three other places it is already reported. The strip's own comment
  says it exists because "the corner badge alone was too easy to miss", written
  when caching was the only way to watch a recording; the MPEG-2 path ended
  that. Nothing about caching is removed or disabled, only this 1px bar
  reassigned. Stacking two strips was considered and rejected: two adjacent 1px
  lines in different colours read as one striped texture rather than two facts,
  and it spends 2px of every card on a line that is empty on 10 of 14 of them.

- **An overrun extends the strip.** The strip spans the union of the scheduled
  slot and what was captured, with a tick where the slot ended. Sports pad by
  thirty minutes deliberately — 116% of the slot — and clamping would hide that
  the padding is there. The tick is drawn only when the overrun is worth seeing
  (>2% of the strip), so GMA's 59 seconds does not put a mark on the edge.

- **A recording that captured less than a tenth of its slot says so**, with an
  `Incomplete` badge where `Recording` sits. Measured, that threshold catches
  exactly the three broken ones (0.1%, 0.2%, 6.2%) and leaves alone the
  deliberately-stopped Deal (58.5%) and the late-starting SNL (74.6%). A
  four-second recording is not a short recording, it is a broken one, and a
  sliver on a 1px strip leaves too much to inference.

- **No slot, or no offsets, means no bar.** It does not occur in this library —
  every recording has both — but a manual recording on a channel with no EPG
  could lack them, and there is then nothing honest to draw. The badge still
  reports the duration, as it does today.

## Risks and unknowns

1. ~~**Whether `scheduled: false` stops an in-progress recording.**~~
   **Settled 2026-09-17, on Let's Make a Deal.** It stops it. `state` went
   `recording` → `finished`, the captured 2106 seconds were kept and remain
   playable, and the tuner was released (`/server/tuners` fell to zero in use).
   `recorded_offsets` came back `{start: 1259, end: -235}` — `end` goes
   **negative** when a recording is cut short, which also confirms the
   expected-length arithmetic on an early stop: 3600 − 1259 − 235 = 2106,
   exactly the reported duration. Stop Recording is real and ships.
2. **What a series rule does to the episode already airing — open, and to be
   settled before Task 6 ships its controls.**

   Observed: setting a series to record *All* does not start recording the
   episode on air right now, and does not offer to. Two endpoints exist and
   they are separate — `PUT /schedule/series` sets the rule, `PUT
   /schedule/airing` schedules one episode — so the device is behaving
   consistently; the question is whether that is what a person means.

   The case for the current behaviour: a rule is about the future, and
   silently starting a recording of a show already half-finished produces a
   partial recording nobody asked for — precisely the thing the coverage bar
   now exists to make visible.

   The case against: someone pressing *Record All* while watching the show
   almost certainly wants this one too.

   Neither is obviously right, so the sheet should probably *ask*, which is
   also the only option that needs no guess about intent. Wants deciding with
   real behaviour in front of us: what the device does to an in-flight episode
   when a rule is set, unset, or changed, and what "stop" means against a rule
   that will simply re-schedule it. **Grill this once the current work is
   deployed, then write the answer here.**

3. **A recording with no guide airing.** Something recorded from a channel whose
   EPG has since rolled over has no `(channel, start)` to match, so Live and
   Guide simply will not mark it — correct, since there is no row to mark. The
   Library card is unaffected: it holds the recording itself.
4. **Manual recordings started mid-show** carry a `recorded_offsets.start` of
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
