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

**Blocked until grilled.** Two questions the spec records and nothing answers:
what a position means when it was captured while the programme was still
recording, and how the phone app paces its writes. Both need the device and a
phone in hand.

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
