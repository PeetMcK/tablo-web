# Seeing what is recording, everywhere — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans or
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A recording in progress is visible and manageable from the Library,
Live and Guide, with one coverage bar and one source of truth behind all three.

**Spec:** `docs/superpowers/specs/2026-09-17-recording-in-progress-visibility-design.md`

**Architecture:** One small server endpoint answers "what is recording now",
keyed by `(channel_identifier, start)`. A shared `recordedSpan` draws the same
geometry in every view. The existing info sheet becomes the place a recording is
managed, and gains a route in from the Library card.

## Global constraints

- **The guide payload does not gain volatile recording state.** It is synced to
  SQLite and cached hard; recording state changes every few seconds.
- **`recordedSpan` has exactly one definition.** Three views drawing the same
  bar from three copies of the arithmetic is the bug this is meant to avoid.
- **Play-button behaviour on Live and Guide is unchanged.** Out of scope.
- Suites stay green: `cd backend && .venv/bin/python -m pytest -q` (420),
  `cd frontend && npx vitest run` (502). `npx tsc -b` — **not** `--noEmit`,
  which is a no-op on the solution tsconfig.
- Ask before committing.

---

### Task 1: A recording knows its channel

**Files:**
- Modify: `backend/app/state.py` (`_channel_fields`)
- Modify: `frontend/src/api/tablo.ts` (`RecordingChannel`)
- Test: `backend/tests/test_recordings.py`

The identifier is already in the device record and simply not projected.
Everything downstream keys on it.

- [ ] **Step 1: Write the failing test**

```python
def test_a_recording_carries_the_identifier_the_guide_is_keyed_by():
    """Without it a recording cannot be matched to its own airing."""
    out = AppState._recording_fields(DEVICE_RECORDING)
    assert out["channel"]["identifier"] == "S34654_008_01"
```

Add `channel_identifier` to `DEVICE_RECORDING`'s `airing_details.channel` —
the real record carries it beside `call_sign`.

- [ ] **Step 2: Run it, watch it fail**
- [ ] **Step 3: Pass `channel_identifier` through `_channel_fields` as `identifier`**
- [ ] **Step 4: Add `identifier: string | null` to `RecordingChannel`**
- [ ] **Step 5: Run both suites. Commit**

---

### Task 2: One endpoint for what is recording now

**Files:**
- Modify: `backend/app/routes/recordings.py`
- Modify: `frontend/src/api/tablo.ts`
- Test: `backend/tests/test_recordings.py`

**Interfaces:**
- Produces: `GET /api/recordings/in-progress` → `{ recordings: InProgress[] }`
  where each carries `object_id`, `channel_identifier`, `start`, `duration`,
  `recording_started`, `recorded_seconds`, `expected_seconds`, `title`.

- [ ] **Step 1: Write the failing test**

```python
def test_in_progress_lists_only_what_is_recording(monkeypatch):
    # Two recordings, one finished; only the live one is listed, and it
    # carries what a coverage bar needs without a second request.
    body = client.get("/api/recordings/in-progress").json()
    assert [r["object_id"] for r in body["recordings"]] == [86113]
    assert body["recordings"][0]["channel_identifier"] == "S34654_008_01"
    assert body["recordings"][0]["expected_seconds"] == 2341
```

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement**

Reuse `state.get_recordings()` and filter `state == "recording"`. No new device
call and no new arithmetic — every field is already computed for the listing.

- [ ] **Step 4: Test the empty case** — nothing recording returns `[]`, not 404.

- [ ] **Step 5: `api.inProgressRecordings()` in the client. Run both suites. Commit**

---

### Task 3: One coverage bar, shared

**Files:**
- Create: `frontend/src/lib/recording.ts`
- Modify: `frontend/src/components/LibraryView.tsx` (import instead of define)
- Create: `frontend/src/__tests__/recordingSpan.test.ts`

**Interfaces:**
- Consumes: nothing. Pure.
- Produces: `recordedSpan(input: { start: string; duration: number;
  recording_started: string | null; recorded_seconds: number | null })
  -> { left: number; width: number } | null`

Widened from `Recording` to a structural input so a guide airing and a live
programme can pass the same shape without being recordings.

- [ ] **Step 1: Move the function and its five tests across unchanged**

They already cover the late start, the early start, the clamp at the slot end
and the null cases. Moving them proves the move was faithful.

- [ ] **Step 2: Run the suite — the Library card must be unaffected**
- [ ] **Step 3: Commit**

---

### Task 4: The Library card opens the info sheet

**Files:**
- Modify: `frontend/src/components/LibraryView.tsx`
- Modify: `frontend/src/components/ShowInfo.tsx` (accept a recording's identity)
- Test: `frontend/src/__tests__/recordings.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("opens the show's information from the card", async () => {
  renderWith(IN_PROGRESS);
  fireEvent.click(await screen.findByRole("button", { name: /information about/i }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});

it("has no info button when the channel is unknown", async () => {
  // An offline-only copy of something the device has since deleted has no
  // airing left to describe.
  renderWith({ ...REC, channel: { ...REC.channel, identifier: null } });
  await screen.findByText("NFL Football");
  expect(screen.queryByRole("button", { name: /information about/i })).toBeNull();
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Add the info button** beside the title, matching the Live card's
  existing info affordance in shape and label. Hidden when
  `channel.identifier` is null — there is nothing to look up.

- [ ] **Step 4: Run the suite. Commit**

---

### Task 5: Settle whether a recording can be stopped — DONE

Answered 2026-09-17 without sacrificing anything: the user descheduled Let's
Make a Deal mid-recording of their own accord.

- [x] It **stops** the recording. `state` went `recording` → `finished`, the
  captured 2106s were kept and remain playable, and the tuner was released.
- [x] `recorded_offsets` came back `{start: 1259, end: -235}` — `end` goes
  negative on an early stop, and 3600 − 1259 − 235 = 2106 matches the reported
  duration exactly.
- [x] Recorded in the spec. **Stop Recording ships.**

---

### Task 5b: Coverage on a finished recording

**Files:**
- Modify: `frontend/src/lib/recording.ts` (from Task 3)
- Modify: `frontend/src/components/LibraryView.tsx`
- Test: `frontend/src/__tests__/recordingSpan.test.ts`, `recordings.test.tsx`

**Interfaces:**
- `recordedSpan` gains `{ left, width, slotEnd: number | null }`. `slotEnd` is
  where the scheduled slot finished as a percentage, or null when there is no
  overrun worth marking.
- A finished recording passes `recorded_seconds = duration` — what it captured.

- [ ] **Step 1: Write the failing tests, with the measured numbers**

```ts
it("spans the union of the slot and what was captured", () => {
  // NFL pads by thirty minutes on purpose: slot 10800, captured 12615 from
  // -15. Clamping to the slot would hide that the padding is there at all.
  const s = recordedSpan({ start: S, duration: 10800,
                           recording_started: minus15, recorded_seconds: 12615 })!;
  expect(s.left).toBeCloseTo(0, 1);
  expect(s.width).toBeCloseTo(100, 1);
  expect(s.slotEnd).toBeCloseTo(85.6, 0);   // the tick
});

it("marks no slot end when the overrun is not worth seeing", () => {
  // GMA ran 59s past its slot — a tick on the last pixel is noise.
  expect(recordedSpan(GMA)!.slotEnd).toBeNull();
});

it("shows a four-second recording as the sliver it is", () => {
  const s = recordedSpan({ start: S, duration: 3600,
                           recording_started: plus3401, recorded_seconds: 8 })!;
  expect(s.left).toBeCloseTo(94.5, 1);
  expect(s.width).toBeLessThan(1);
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Implement the union span and the tick.** The strip covers
  `[min(0, startOffset), max(slot, startOffset + captured)]`; the tick is drawn
  only when the overrun exceeds 2% of the strip.

- [ ] **Step 4: Draw it for finished recordings too**, and hand the strip over
  from cache progress — which keeps its badge, its detail row and its rate.

- [ ] **Step 5: The `Incomplete` badge.** Under a tenth of the slot captured,
  the card says so where `Recording` sits. Measured, that is exactly the three
  broken recordings and none of the good ones.

- [ ] **Step 6: Run the suite. Commit**

---

### Task 6: The info sheet manages a recording in progress

**Files:**
- Modify: `frontend/src/components/ShowInfo.tsx`
- Test: `frontend/src/__tests__/showInfo.test.tsx`

**Interfaces:**
- Consumes: `api.inProgressRecordings()` (Task 2), `recordedSpan` (Task 3).

- [ ] **Step 1: Write the failing tests**

```tsx
it("says when this airing is recording right now", async () => {
  expect(await screen.findByText(/recording now/i)).toBeInTheDocument();
});

it("draws the coverage bar where recording actually began", async () => {
  // 1259s into a 3600s slot — the same geometry the library card draws.
  expect(parseFloat(fill.style.left)).toBeCloseTo(34.97, 1);
});

it("confirms before stopping, because the rest of the show is lost", async () => {
  fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
  expect(await screen.findByText(/stop recording/i)).toBeInTheDocument();
  expect(stop).not.toHaveBeenCalled();     // not until confirmed
});

it("shows no recording block for an airing that is merely scheduled", async () => {
  expect(screen.queryByText(/recording now/i)).toBeNull();
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Implement the block** above the existing record controls:
  badge, coverage bar, `20m of 39m captured of a 1h 0m slot, since 10:20 AM`,
  and Stop Recording behind `ConfirmDialog`.

- [ ] **Step 4: Poll while open** so the bar moves. Same 15s cadence as the
  Library list; stop polling when the sheet closes.

- [ ] **Step 5: Run the suite. Commit**

---

### Task 6b: Resume position lives on the device

**Files:**
- Modify: `backend/app/routes/recordings.py` (accept a position write)
- Modify: `frontend/src/components/LibraryView.tsx` (write on stop, read on open)
- Test: `backend/tests/test_recordings.py`

The device tracks `user_info.position` and the phone writes it; we keep ours in
`localStorage`, so the two clients disagree and ours dies with the cache.

- [ ] **Step 1: Write the failing test** — posting a position PATCHes the
  device with the flat shape, not the nested one.

The shape matters and is not the read's. Verified against the device:
`{"position": 618}` takes, `{"user_info": {"position": 618}}` answers 200 and
is silently ignored.

- [ ] **Step 2: Run it, watch it fail**
- [ ] **Step 3: `POST /api/recordings/{id}/position`**, PATCHing the device.
- [ ] **Step 4: Write it where the local resume is already saved**, which is
  on close and on the existing position heartbeat.
- [ ] **Step 5: Prefer the device's position when opening**, falling back to
  the local one so nothing regresses if the device is unreachable.
- [ ] **Step 6: Run both suites. Commit**

**Merge rule decided: the greater position wins**, in both directions, with our
own copy always kept and always pushed. Clamp to `duration` once a recording has
finished, so a position captured mid-recording cannot outlive the media it
indexed into.

**Still wants grilling, but no longer blocking:** how the phone app paces its
writes, so ours can match rather than guess. Observed so far - two recordings
both landed on `position: 6` shortly after being opened, which suggests an early
write a few seconds in; and a position held steady at 521 for 84 seconds after
playback stopped, so it is not a heartbeat that keeps ticking.

---

### Task 6c: Watched, marked by hand

**Files:**
- Modify: `backend/app/routes/recordings.py`, `frontend/src/components/ShowInfo.tsx`

The device did not set `watched` for a recording played to 43%, so it flips
near the end or never. Either way the sheet should let a person say so.

- [ ] Project `watched` and `protected` from `user_info`.
- [ ] A Mark watched / Mark unwatched toggle on the sheet, flat-shape PATCH.
- [ ] Clearing `watched` should probably clear the resume position too —
  decide, do not assume.

---

### Task 7: Live and Guide show what is recording

**Files:**
- Modify: `frontend/src/components/ChannelCard.tsx`
- Modify: `frontend/src/components/GuideGridView.tsx`
- Test: `frontend/src/__tests__/liveCard.test.tsx`, `guideGrid.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
it("marks a live card whose programme is being recorded", async () => {
  expect(await screen.findByLabelText(/recording now/i)).toBeInTheDocument();
});

it("draws coverage rather than programme progress while recording", async () => {
  // The existing bar says how far through the show the clock is. Once
  // recording, the useful question is how much of it was captured.
  expect(parseFloat(fill.style.left)).toBeGreaterThan(0);
});

it("leaves a card alone when nothing is recording it", async () => {
  expect(parseFloat(fill.style.left) || 0).toBe(0);
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Implement** — both views take a
  `Map<string, InProgress>` keyed `` `${channel}|${start}` ``, built once by
  their parent from `api.inProgressRecordings()`. A hit swaps the programme bar
  for the coverage bar and shows the badge.

- [ ] **Step 4: Run the suite. Commit**

---

### Task 8: Verify against the device

- [ ] A recording in progress shows a REC badge and a correctly-offset bar in
  **all three** views at once, and all three agree.
- [ ] The info sheet opens from the Library card with the right artwork.
- [ ] Its bar and figure move while it sits open.
- [ ] Stop Recording behaves as Task 5 established.
- [ ] Nothing recording: Live and Guide look exactly as they do today.


---

### Task 9: The skip buttons need debouncing

**Files:**
- Modify: `frontend/src/components/VideoPlayer.tsx`
- Test: `frontend/src/__tests__/playerChrome.test.tsx`

**The problem.** Every tap of Back 10 / Forward 30 calls `seek`, and on the
MPEG-2 path a seek is not cheap: it bumps the epoch, posts a `reset`, tears the
decoder down and rebuilds it, flushes the audio queue and destroys the
presenter's fields. Four quick taps to skip two minutes is four full rebuilds
where one would do, and the picture goes black between each.

There is evidence this already bites: a long live session logged **21 decoder
rebuilds**, recorded in the handoff as an open question and never explained.
Repeated skipping is the obvious candidate.

- [ ] **Step 1: Write the failing test**

```tsx
it("turns a flurry of taps into one seek", async () => {
  // Four taps of Forward 30 is one jump of two minutes, not four rebuilds.
  for (let i = 0; i < 4; i++) fireEvent.click(forward);
  await advance(DEBOUNCE_MS + 50);
  expect(seek).toHaveBeenCalledTimes(1);
  expect(seek).toHaveBeenCalledWith(start + 120);
});

it("shows where it is going before it gets there", async () => {
  // Accumulating silently would read as the button being broken.
  for (let i = 0; i < 3; i++) fireEvent.click(forward);
  expect(screen.getByText(/\+1:30/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Accumulate, then seek once.** Hold a pending delta, add each
  tap to it, and issue a single seek once taps stop for ~400ms. The scrubber and
  the timecode follow the pending target immediately, so the control stays
  responsive while the decoder is left alone.

- [ ] **Step 4: Do not rebuild when the target is already decoded.** A back-10
  usually lands inside what the presenter still holds and what the audio sink
  has buffered; the ring and the VOD index both still hold the segments. Skipping
  the teardown in that case is the difference between an instant jump and a
  rebuild. `readyRange` already knows what is decoded — this is about acting on
  it rather than only clamping to it.

- [ ] **Step 5: Confirm the counts.** `tabloDebug()` reports decoder rebuilds;
  four taps must show one.

- [ ] **Step 6: Run the suite. Commit**

**Open:** the buttons are Back **10** and Forward **30** today, not 20/30.
Whether back should become 20 is a separate decision from the debounce.

---

### Task 10: What happens when a recording ends

**Files:**
- Modify: `backend/app/state.py` (`_recording_fields` — project the episode keys)
- Modify: `backend/app/routes/recordings.py` (a `watched` write)
- Create: `frontend/src/components/SeriesEndCard.tsx`
- Modify: `frontend/src/components/VideoPlayer.tsx`
- Test: `backend/tests/test_recordings.py`, `frontend/src/__tests__/`

Today a recording plays to its end, the frame holds, and nothing happens.

**No autoplay and no countdown.** A card appears carrying the series cover,
and under it every recorded episode of that series, in the best order the data
supports, with the watched ones clearly marked. The viewer picks. An autoplay
setting may come later; this is not it, and nothing here should assume it.

**Mark the finished one watched.** The device never does this itself — one
played to 43% still read `watched: false`, which is why 6c needs a manual
toggle at all. Reaching the end is the unambiguous case. Flat PATCH,
`{"watched": true}`; the nested form answers 200 and does nothing.

### What groups an episode with its siblings

`series_path` where there is one, **and the title where there is not**.

This was `series_path` alone, and that loses the one case the ordering rule
below was written for. Re-measured 2026-09-17 against all 18 recordings: the 6
with no `series_path` are not movies and one-offs, as recorded here earlier —
they are six recordings of **NFL Football**, the sport that has no episode
numbers and is the whole reason clause 2 exists. Grouping on `series_path`
alone would have given every one of them an empty card and left clause 2
unreachable.

A recording with neither a `series_path` nor a title has no group. Nothing
else does.

### The ordering rule

Decided per series, not per episode, because a series either has usable
numbering or it does not:

1. **If every episode in the group carries both a season and an episode
   number**, sort by `(season_number, episode_number)` ascending — **oldest at
   the top**.
2. **Otherwise** — sport, news, anything the guide numbers poorly — sort by
   `orig_air_date`, falling back to the recording's own `start`, again
   **oldest first**.

Every, not any: a group where some episodes are numbered and some are not
sorts incoherently under rule 1, because the unnumbered ones all collapse
together at one end regardless of when they aired.

Both were considered and rejected as a global rule. Measured on the live
library: `Scrambled Up` is S2E7 then S2E8, which episode order gets right and
date order also gets right. `Saturday Night Live` holds S24E16 and S49E7 —
decades apart — and `Carl the Collector` holds S1E5 and S1E30. Sorting those
by number is correct; sorting the NFL by number would not be, because it has
none.

**Ties are real and must be stable.** `First Civilizations` holds three
recordings that are all S1E3 with the same `orig_air_date` — the duplicate
stubs — so both rules tie on all three. Break on `start`, then `object_id`, so
the list does not reshuffle between renders.

**Coverage, measured:** 18 recordings, 8 groups, 4 of them with more than one
recording. 12 of 18 carry both numbers; the 6 that do not are the NFL, and
they group by title.

### Where the cover comes from

A recording record does **not** embed its series: `series` is null on the
episode and only `series_path` is there. So the cover needs the series record,
which is one device fetch — worth making once, when the card appears, rather
than 18 times while listing.

`GET /api/recordings/{object_id}/series` → `{ series_path, title, cover_image }`,
and the card renders `/api/channels/image/{cover_image}`, which already caches
device images for a week.

Addressed through the recording rather than as `/api/recordings/series/{id}`
deliberately: that second form is two segments, the same shape as
`/{object_id}/position`, and FastAPI matches on declaration order and answers
422 rather than falling through when `series` fails to parse as an int.

A group with no `series_path` — the NFL — has no cover and renders without
one. The list is the point; the cover is the dressing.

### What has to be projected

`_recording_fields` drops all of it today, and every field is already in the
record being fetched, so this costs no extra device traffic:

```python
"series_path":    data.get("series_path"),
"season_number":  ep.get("season_number"),
"episode_number": ep.get("number"),
"orig_air_date":  ep.get("orig_air_date"),
```

`series_path` is `/recordings/series/{id}` — the *recordings* series, not the
guide's. That is the right grouping here: it means "other recordings of this
show", which is what the card lists.

- [x] **Step 1: Project the four fields**, with a test that a recording with
  no episode data still lists.
- [x] **Step 2: Group and order**, in a pure helper beside `recordedSpan` so
  both rules can be tested without a device. Include the SNL case, the NFL
  case, and the three-way `First Civilizations` tie.
- [x] **Step 3: `POST /{id}/watched`**, flat shape, read-shape trap documented
  as `position` has it.
- [x] **Step 4: `GET /{id}/series`**, for the cover.
- [x] **Step 5: Mark watched on reaching the end**, once per playback.
- [x] **Step 6: The card** — cover above, list below, watched marked, the
  just-finished episode identified as such.
- [x] **Step 7: Nothing to show is not an error.** A movie, a one-off, or the
  only recording of its group gets no list; the card falls back to closing to
  the Library.
- [x] **Step 8: Run both suites. Commit.**

**The cover — settled.** `GET /recordings/series/{id}` carries it directly:

```
series.cover_image.image_id        e.g. 9345
series.thumbnail_image.image_id    the poster shape, if the list wants per-item art
series.background_image.image_id
```

Present on **7 of 7** series on the live account, so no guide join and no
fallback path. Served through the existing `/api/channels/image/{id}` route.

That record also carries `guide_path`, an explicit link to the guide series —
so the join I earlier said recordings did not have does exist, it is just on
the series record rather than on the airing. Worth knowing for anything else
that needs to cross from a recording to guide metadata.
