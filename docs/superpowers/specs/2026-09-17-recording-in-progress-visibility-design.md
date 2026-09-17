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

### Resume position belongs on the device

The device already tracks it, in `user_info.position`, in seconds — and the
official app writes it. Measured: of eight recordings, only the Saturday Night
Live watched on a phone carried a position (33s); everything watched in our own
player read zero, because we keep resume in `localStorage`.

So the two clients each hold half the picture. Ours is *not* in localStorage —
an earlier draft of this document said so and was wrong; positions already moved
to our own server, with localStorage kept only as a one-shot legacy import. The
argument is therefore about agreement between clients, not durability: our
server and the device each know something the other does not, and only the
device is shared with the phone. **Position should be written to the device.**

The write works, and its shape is not the read's:

```
PATCH /recordings/series/episodes/{id}  {"position": 618}            → takes
PATCH /recordings/series/episodes/{id}  {"user_info": {"position": 618}}
                                                → 200, silently ignored
```

The nested form is the shape the GET returns, answers `200`, and does nothing —
the same trap `schedule.py` documents for `scheduled`. Verified by writing 618
to a recording and reading it back, then restoring zero.

**Proposed rule: change detection, not a timestamp.** The device carries no
modified time — `user_info` is exactly `{position, watched, protected}`, and a
search of the whole record found nothing time-shaped but the airing's own
datetime. So no honest last-writer-wins is possible from its data alone.

It does not need to be. Store, beside our own position, *the device value we
last saw*. On open: if the device's position differs from that, something else
wrote it — the phone — so it is newer and wins; if it matches, nobody else
touched it and ours is newer. That gets both directions right without the device
cooperating, and it avoids the cost of adopting the device wholesale, which
today would rewind eleven recordings (Saturday Night Live from 21:36 back to
33 seconds). The one case it cannot resolve is genuine simultaneous playback on
two clients, which nothing could without a clock.

**The device is the source of authority**, once we write to it. Our own server
keeps positions today and the device keeps the phone's, and they disagree
plainly: SNL reads 1296s on ours and 33s on the device. Rather than invent a
merge rule neither side can support — nothing carries a timestamp — the device
wins, and our server becomes a cache of it. That is the only arrangement where
"where was I" has one answer no matter which client asks.

**How often to write is an open question with an empirical answer.** The phone
app already solved it, so the cadence should be measured rather than guessed:
watch something on the phone and sample `user_info.position` to see how often it
moves, then force-quit mid-episode and read it again to learn whether the app
writes on the way out or only on a timer. Whatever it does is what a Tablo
expects, and matching it avoids both hammering the device and losing the last
minute of a session. **Needs a phone in hand; do it before building the write.**

### Watched, and why position cannot be trusted blindly — GRILL FIRST

`watched` sits beside `position` and is presumably writable the same flat way.
The info sheet wants an explicit **Mark watched / unwatched** toggle: the device
never set `watched` for a recording played to 43% (521 of 1213), so it evidently
flips near the end or not at all, and either way a person wants to say so
themselves.

**The open problem, to be settled before any of this is built:** a position
recorded while the programme was still recording may not mean what the same
number means afterwards. Measured facts that bear on it — `recorded_offsets.end`
goes *negative* when a recording is cut short, and `duration` is 0 throughout
recording and only settles at the end — so the media a position indexes into is
still changing while it is being written. Whether the device re-bases position
when a recording finishes, whether the phone app stores it relative to the
recording's first frame or to something else, and what happens to a position
captured past the point a stopped recording actually ends, are all unknown.

Until they are known, a position observed on a recording that was in progress
at the time is not safe to resume from. Ways it could be handled, none chosen:
ignore positions captured while `state` was `recording`; re-validate a position
against `duration` once a recording finishes and discard anything beyond it; or
record alongside our own positions whether the recording was live when we saw
them. **Grill the device before implementing — this decides whether resume is
trustworthy at all for the case we have spent today making possible.**

### Delete and protect belong on the info sheet

Both are device-side states we do not touch at all today:

- **`protected`** is in `user_info` and guards a recording against the device
  reclaiming space. Verified writable, flat, and reversible:
  `PATCH {"protected": true}` → 200, the flag flips, and `false` restores it.
  This is the device's own version of the offline "keep" we already offer, and
  the two want distinguishing in the UI rather than conflating: keep copies it
  here, protect stops the Tablo deleting it there.
- **Delete** removes the recording from the device. Nothing in the app does
  this — our two delete routes are cache-side (`/keep`, `/cache`) and only ever
  remove our own copy. The device call is presumably `DELETE {recording_path}`
  but **has deliberately not been tested**: it destroys content irreversibly,
  and probing it needs a recording nobody wants.

Both go on the info sheet beside the record controls. Delete confirms, names
the programme, and says plainly that the recording is gone from the Tablo
rather than merely from here — a distinction the existing "delete cached video"
wording already has to make.

### A past airing should say what happened, not what it will do

`REC · RECORD: THIS EPISODE ONLY` renders on any airing where `scheduled` is
true, which stays true after the airing has recorded. `recordScope` then
describes the scope from the *series* rule, so a programme that finished hours
ago is labelled with a future intent — and when the series rule is None, it
reads "Record: This Episode Only" underneath a series control set to None,
which is both stale and self-contradictory.

A past airing should report its outcome: `Recorded`, with a way into the
recording it produced, or nothing at all when none exists. The scope label
belongs only on something not yet recorded.

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
2. **Setting a series rule starts recording the episode already airing,
   immediately — and nothing warns you.**

   Corrected: an earlier draft of this document said a rule did *not* touch the
   current episode. It does, at once, with no confirmation.

   The consequence is already in the library, and it is what the three
   "broken" recordings above actually are:

   ```
   86040  slot 09-16 22:00Z  began 22:56:41  ended 22:56:49    8s  ep=Cities
   86043  slot 09-16 22:00Z  began 22:57:02  ended 22:57:06    4s  ep=Cities
   86045  slot 09-16 22:00Z  began 22:57:09  ended 23:00:51  222s  ep=Cities
   ```

   The same episode, the same slot, three recordings inside 28 seconds —
   record, stop, record, stop, record, with the last running to the end of the
   slot. Not a device fault: the footprint of someone cycling through All /
   New / None to decide on a rule. Each press started a recording; each change
   of mind stopped it and left a stub. The `Incomplete` badge added today
   labels the debris, which is useful, but the better fix is not to create it.

   **Requirement: any control that would start a recording of something airing
   now must confirm first**, naming the programme and how much of it is left.
   That covers the per-episode Record button and — the case that produced the
   debris — the series rule buttons, which look like preference toggles and are
   not. Stopping is already destructive and already confirms.

   Still to settle by grilling the device, before Task 6 ships its controls:
   what a rule change does to an episode already recording (does moving All →
   New stop it?), whether stopping an episode under an active rule simply
   re-schedules it — which would make Stop Recording misleading — and what
   `skip_reason` says once an episode has been stopped by hand.

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
