# Watching an in-progress recording from its first frame — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans or
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Open a recording that is still being written and start at its first
frame, seekable across everything recorded so far, with nothing written to disk.

**Spec:** extends `docs/superpowers/specs/2026-09-17-mpeg2-recordings-vod-design.md`.
No new spec: the design decision here was settled by measurement, below.

**Architecture:** An in-progress recording becomes a *growing* VOD index rather
than a ring. The device's playlist is held as an index and re-read as it grows;
segments are fetched from the device by byte range on demand.

---

## What was measured, 2026-09-17 ~08:30Z, against SNL (episode 86091)

This plan exists because the previous session's conclusion — that an
in-progress recording cannot be played from its start — was **wrong**. The
claim rested on one reading (1803 segments covering 07:15–07:45 against a
believed 07:00 start) that a mis-attributed start time explains just as well.

Against a recording that began at 08:00:03Z:

| Question | Answer |
|---|---|
| Does the playlist begin at the recording's start? | **Yes.** First segment `#EXT-X-BYTERANGE:218644@0` at `PROGRAM-DATE-TIME:2026-09-17T08:00:03.000Z`. Offset zero. |
| Is there a ~30 minute cap? | **No.** At 29:56 elapsed (1777 segments) the head was still `@0`. |
| Does it append or slide? | **Appends.** 75s apart: `MEDIA-SEQUENCE:1` unchanged, head byte-range unchanged, 1707 → 1777 segments. |
| Does it carry ENDLIST? | No — that, and only that, is what distinguishes it from a finished one. |
| Will the device serve unnamed byte ranges? | Yes. `206`, `content-range: bytes 0-1000000/101836968`, `accept-ranges: bytes`. |
| Do chunks cut at ragged offsets decode? | Yes. Offsets `5000123` and `31415927` — neither 188-aligned nor on a segment edge — both give `mpeg2video 720x480 SAR 32:27` + `ac3` with real PTS. |

The last two rows are **not needed by this plan**. They are recorded because
they are the escape hatch if a cap ever does appear: the head would still be
reachable by byte range, and MPEG-TS resynchronises.

**Why the player joins late today:** `live_follower.py:167`,
`_start_at_live_edge`, whose own docstring says *"This device is a DVR and its
playlist offers minutes of recording, not a live window."* It discards that
history deliberately. Right for live TV, wrong for a recording.

**Rejected alternative — tell the ring not to skip.** It would ingest the whole
recording to disk at the 3.5x-realtime rate that docstring describes, which is
both that pathology and the opposite of the no-disk rule the VOD path was built
on. The growing index reuses `vod_index.py`, which already parses this exact
playlist shape through the same `parse_device_playlist`, and writes nothing.

## Global constraints

- **Nothing is written to disk.** If a growing session creates anything under
  `RAW_DIR`, the design has been misunderstood.
- **Do not regress** live channels or finished recordings. Both play today.
- Positional segment names (`00042.ts`) are only sound because the device
  appends. Task 1 makes that an enforced invariant rather than an assumption.
- Suites stay green: `cd backend && .venv/bin/python -m pytest -q`,
  `cd frontend && npx vitest run`, `npx tsc -b` (**not** `--noEmit`, which is a
  no-op on the solution tsconfig).
- Ask before committing.

---

### Task 1: An index that can grow

**Files:**
- Modify: `backend/app/vod_index.py`
- Test: `backend/tests/test_vod_index.py`

**Interfaces:**
- Produces: `VodIndex.finished: bool`; `VodIndex.extended_with(VodIndex) -> VodIndex`
- `NotFinished` is **removed** — the condition it guarded is now supported.

- [ ] **Step 1: Write the failing tests**

```python
def test_a_recording_still_being_written_is_an_index_too():
    """It has no ENDLIST, but it does have a beginning, and that is the point."""
    index = parse_vod_playlist(IN_PROGRESS, BASE)
    assert index.finished is False
    assert index.segments[0].byte_range == (0, 218643)


def test_an_unfinished_index_publishes_no_endlist():
    """ENDLIST is what tells the player to stop asking. It is still growing."""
    assert "#EXT-X-ENDLIST" not in parse_vod_playlist(IN_PROGRESS, BASE).playlist()


def test_growth_keeps_every_segment_at_the_position_it_already_had():
    """Positional names are only safe while position 0 stays segment 0.

    A viewer forty minutes into a recording is holding names this index issued
    minutes ago. Renumbering under them would not fail - it would quietly serve
    the wrong content for every name they still hold.
    """
    first = parse_vod_playlist(TWO_SEGMENTS, BASE)
    grown = first.extended_with(parse_vod_playlist(FOUR_SEGMENTS, BASE))
    assert len(grown.segments) == 4
    assert grown.segments[:2] == first.segments


def test_a_refresh_that_dropped_its_head_does_not_shift_the_names():
    """The device appends today. If it ever slides, names must not move."""
    first = parse_vod_playlist(FOUR_SEGMENTS, BASE)
    slid = parse_vod_playlist(FOUR_SEGMENTS_MISSING_HEAD, BASE)
    grown = first.extended_with(slid)
    assert grown.segments[0] == first.segments[0]
    assert len(grown.segments) >= len(first.segments)
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Implement**

`finished` is `"#EXT-X-ENDLIST" in text`, carried on `VodIndex`. `playlist()`
emits `EXT-X-ENDLIST` only when finished, and `EXT-X-PLAYLIST-TYPE:VOD` only
when finished (a growing playlist is neither VOD nor EVENT to us — it simply
omits both and the client re-reads it).

`extended_with(new)` accumulates rather than replaces. Match on
`(url, byte_range)`: find our last segment in `new`; append only what follows
it. If our last segment is not in `new` at all, keep ours and append nothing —
a refresh that cannot be reconciled must never renumber what a viewer holds.

- [ ] **Step 4: Run the backend suite**

`test_a_recording_still_being_written_is_refused` asserts the old behaviour and
is deliberately replaced by the first test above. Delete it; its docstring's
claim ("cannot be played from its beginning by us or by the device's own app")
is the thing this plan disproves.

- [ ] **Step 5: Commit**

---

### Task 2: A session that re-reads a growing index

**Files:**
- Modify: `backend/app/routes/stream.py`
- Test: `backend/tests/test_vod_routes.py`

**Interfaces:**
- `vod_sessions[session_id]` becomes a `VodSession` holding `index`,
  `device_url`, `refreshed_at`. Task 3 constructs it.
- Consumes: `VodIndex.finished`, `VodIndex.extended_with` from Task 1.

- [ ] **Step 1: Write the failing tests**

```python
def test_a_growing_playlist_is_re_read_from_the_device():
    """The whole point: what the viewer can reach grows as it records."""
    # device serves 2 segments, then 4
    r1 = client.get(f"/api/vod/{SESSION}/playlist.m3u8")
    assert r1.text.count("#EXTINF") == 2
    stream.vod_sessions[SESSION].refreshed_at = 0  # past the refresh interval
    r2 = client.get(f"/api/vod/{SESSION}/playlist.m3u8")
    assert r2.text.count("#EXTINF") == 4


def test_a_finished_index_is_never_re_read():
    """It cannot change, and a 1.2MB playlist is not free to re-fetch."""


def test_a_refresh_the_device_fails_keeps_serving_what_we_hold():
    """Losing the device mid-recording must not empty a playing session."""
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Implement**

In the playlist route: if `not session.index.finished` and
`monotonic() - session.refreshed_at > VOD_REFRESH_SECONDS` (3.0 — the device
adds a segment about every second), re-fetch `device_url`, parse, and
`extended_with`. A failed refresh logs and serves the held index.

Segment fetching is unchanged: it already resolves by position and byte range.

- [ ] **Step 4: Run the backend suite. Commit**

---

### Task 3: `watch-vod` accepts a recording still being written

**Files:**
- Modify: `backend/app/routes/recordings.py`
- Test: `backend/tests/test_recording_routes.py`

- [ ] **Step 1: Write the failing test** — an in-progress recording returns
  200 with `"growing": true` and a `/api/vod/...` url, not 409.

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement**

Delete the `NotFinished` 409 branch. Store the variant url on the session so
Task 2 can re-read it — `_fetch_vod_index` already resolves master → variant and
must now return both the index and that url. Response gains
`"growing": not index.finished`; `duration` is what is held so far.

- [ ] **Step 4: Run the backend suite. Commit**

---

### Task 4: The frontend follows a growing index

**Files:**
- Modify: `frontend/src/lib/wasmlive/session.ts`
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

**Interfaces:**
- `SessionDeps.vod` becomes `{ durationSeconds: number; growing?: boolean }`.
  Absent `growing` keeps today's finished-recording behaviour exactly.

- [ ] **Step 1: Write the failing tests**

```ts
it("re-reads a growing recording's playlist, because it is still being written", async () => {
  const h = harness({ vod: { durationSeconds: 120, growing: true }, fetchText: counted });
  await h.session.start();
  await h.session.poll();
  expect(playlistFetches).toBe(2);   // a finished one fetches once
});

it("still starts a growing recording at its first frame", async () => {
  const h = harness({ vod: { durationSeconds: 120, growing: true } });
  await h.session.start();
  expect(h.fetched.filter((u) => u.endsWith(".ts"))[0]).toContain("00000.ts");
});

it("grows what a growing recording can seek over", async () => {
  // The scrubber must not be pinned to the length the recording had at open.
  const h = harness({ vod: { durationSeconds: 120, growing: true }, fetchText: growing });
  await h.session.start();
  await h.session.poll();
  expect(h.session.seekable![1]).toBeGreaterThan(120);
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Implement — two lines, both narrow**

`session.ts:381`: `if (!deps.vod || deps.vod.growing || playlist === null)`.

`session.ts:696`: a growing range ends where the held playlist ends, which
`playlistWindow` already reports as `{start: 0, end: held}` for a dateless
playlist. Fall back to `durationSeconds` until the first playlist arrives.

Nothing else changes. `takenThrough = playlist.mediaSequence - 1` at `:404`
already starts a `vod` session at the beginning — that line is the feature, and
it has been there since the finished-recording work.

- [ ] **Step 4: Run the tests, then the whole suite. Commit**

---

### Task 5: The player opens an in-progress recording as a growing VOD

**Files:**
- Modify: `frontend/src/components/VideoPlayer.tsx`
- Modify: `frontend/src/api/tablo.ts` (`watchRecordingVod` return type)
- Test: `frontend/src/__tests__/recordings.test.tsx`

- [ ] **Step 1: Write the failing test** — an in-progress recording opens
  `watch-vod`, not `watch-raw`, and passes `growing: true` through.

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement**

`VideoPlayer.tsx:778` drops the `inProgress` branch: every recording goes to
`watchRecordingVod`, and `vod` carries `growing` from the response.
`watchRecordingRaw` and the `/api/raw/` ring stay — live TV is their job.

- [ ] **Step 4: Run the suite. Commit**

---

### Task 6: Skip works on the MPEG-2 path

Separate defect, found while reading these controls, and this feature is hard
to judge without it — a 40-minute recording you cannot jump around in.

**Files:**
- Modify: `frontend/src/components/VideoPlayer.tsx:1014`
- Test: `frontend/src/__tests__/playback.test.ts`

- [ ] **Step 1: Write the failing test** — `readyRange` with no cached ranges
  and no buffer returns `[t, t]`, and `clampSkip` on it returns `t`: the skip
  that goes nowhere.

- [ ] **Step 2: Implement**

`whole: isLive || usingWasm || cacheState === "complete"`, and add `usingWasm`
to the dependency array.

The wasm path `return`s before `setCacheState`/`setCachedRanges` ever run, so
`cacheState` is `null` and `cachedRanges` is `[]`; the other input,
`videoRef.current.buffered`, belongs to the hidden `<video>` element that wasm
does not use. `readyRange` therefore finds no run containing the playhead and
returns `[t, t]`, `clampSkip` lands back on `t`, and the `< 0.25` guard returns
without seeking. Live wasm escapes only because `isLive` short-circuits it.

There is no cache to gate on here: the device serves any byte range on demand.

- [ ] **Step 3: Run the suite. Commit**

---

### Task 7: Verify against the device

Not optional, and not a substitute for the tests.

- [ ] Open a recording that is **still recording**. It starts at its first
  frame. `tabloDebug()` reports `kind: "wasm"` and `position` near `0:00`.
- [ ] `/tmp/tablo_raw` stays empty for that session; `/api/device/tuners` shows
  it under `vod`, not `ring`.
- [ ] Leave it playing five minutes. The scrubber's end grows. No FFmpeg starts.
- [ ] Seek to the middle and back to the start. Both land.
- [ ] Back 10 / Forward 30 move the playhead (Task 6).
- [ ] Let the recording **finish** while a session is open: the refresh picks up
  `ENDLIST`, the playlist stops being re-read, and playback continues.
- [ ] Confirm live TV and a finished recording both still play.
