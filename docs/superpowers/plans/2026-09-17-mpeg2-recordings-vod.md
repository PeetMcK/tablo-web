# MPEG-2 for finished recordings — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development
> or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Play a finished recording as MPEG-2 in the browser, with full-runtime
seeking and no FFmpeg, by proxying the device's own segments.

**Spec:** `docs/superpowers/specs/2026-09-17-mpeg2-recordings-vod-design.md`

**Architecture:** A backend proxy holds the device's playlist as an in-memory
index and serves segments on demand by byte range; the frontend session gains a
VOD mode that fetches the playlist once, starts at zero, and reports the real
duration as its seekable range.

## Global constraints

- **Nothing is written to disk.** A 3½-hour recording is ~25GB. If a VOD
  session creates anything under `/tmp/tablo_raw`, the design has been
  misunderstood.
- **Do not regress live.** Live channels and in-progress recordings play today;
  the session's live path, the decoder, presenter, audio clock and fallback are
  not to change shape.
- Sessions reuse the existing lifecycle — registered in `state.streams` with
  the device token so the keepalive and reaper cover them.
- Suites stay green: `cd backend && .venv/bin/python -m pytest -q` (380),
  `cd frontend && npx vitest run` (477). `npx tsc -b` clean.
- Ask before committing.

---

### Task 1: The device playlist, parsed into an index

**Files:**
- Create: `backend/app/vod_index.py`
- Test: `backend/tests/test_vod_index.py`

- [ ] **Step 1: Write the failing test**

```python
def test_parses_byte_ranged_segments():
    index = parse_vod_playlist(PLAYLIST, base="http://dev/stream/pls.m3u8")
    assert len(index.segments) == 3
    assert index.duration == pytest.approx(4.5, abs=0.01)
    first = index.segments[0]
    assert first.uri.endswith("segw.ts?tok")
    assert first.byte_range == (0, 1667559)
```

- [ ] **Step 2: Run it, watch it fail** (module does not exist)
- [ ] **Step 3: Implement `parse_vod_playlist`**

Reuse `parse_device_playlist` from `live_follower` where it fits — it already
understands `#EXT-X-BYTERANGE` including the continuation form where an offset
is omitted. What is new is accumulating total duration and resolving uris
against the playlist's own url.

- [ ] **Step 4: Test the continuation form and an absent ENDLIST**

A playlist without `ENDLIST` is an in-progress recording and must be refused
here — that case has its own path and cannot be seeked anyway.

- [ ] **Step 5: Run the backend suite. Commit**

---

### Task 2: The VOD session and its routes

**Files:**
- Modify: `backend/app/routes/recordings.py` (add `watch-vod`)
- Modify: `backend/app/routes/stream.py` (add the `/vod/` routes, session map)
- Test: `backend/tests/test_vod_routes.py`

- [ ] **Step 1: Write the failing test** — a registered session serves a
  playlist whose segment count matches the index and which ends with
  `#EXT-X-ENDLIST`.

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: `POST /api/recordings/{id}/watch-vod`**

Resolve the recording, open a device watch session, fetch the variant playlist
once, parse it, store `vod_sessions[session_id] = VodSession(index, token)`.
Return `{session_id, stream_url, duration}`.

Refuse an in-progress recording with 409 — it has no `ENDLIST` and the ring
path already covers it.

- [ ] **Step 4: `GET /api/vod/{session}/playlist.m3u8`**

The index rewritten with our own segment names and `EXT-X-ENDLIST`. Same
`EXTINF` values. No `PROGRAM-DATE-TIME`: media time is elapsed time from zero.

- [ ] **Step 5: `GET /api/vod/{session}/{n}.ts`**

Fetch that segment's byte range from the device and stream it back. Assert in a
test that nothing appears under `RAW_DIR`.

- [ ] **Step 6: Wire the lifecycle** — `touch_session` on the playlist poll,
  release on `DELETE /api/stream/{id}`, and include VOD sessions in
  `reap_idle_sessions` and `keepalive_forever`.

- [ ] **Step 7: Run the backend suite. Commit**

---

### Task 3: VOD mode in the session

**Files:**
- Modify: `frontend/src/lib/wasmlive/session.ts`
- Modify: `frontend/src/lib/wasmlive/open.ts` (pass the mode through)
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

**Interfaces:**
- `SessionDeps` gains `vod?: { durationSeconds: number }`. Absent means live,
  so every existing caller and test is unaffected.

- [ ] **Step 1: Write the failing tests**

```ts
it("fetches a VOD playlist once, because it will never change", async () => {
  const h = harness({ vod: { durationSeconds: 600 }, fetchText: counted });
  await h.session.start();
  await h.session.poll();
  expect(playlistFetches).toBe(1);
});

it("starts a recording at the beginning, not the live edge", async () => {
  // The live path deliberately joins near the edge. A recording has a
  // beginning and that is where it starts.
  const h = harness({ vod: { durationSeconds: 600 }, fetchText: async () => DEEP_PLAYLIST });
  await h.session.start();
  expect(h.fetched.filter((u) => u.endsWith(".ts"))[0]).toContain("00000.ts");
});

it("reports the recording's duration as its seekable range", async () => {
  const h = harness({ vod: { durationSeconds: 12913 } });
  await h.session.start();
  expect(h.session.seekable).toEqual([0, 12913]);
});
```

- [ ] **Step 2: Run them, watch them fail**

- [ ] **Step 3: Implement the three differences**

Only three: skip the poll timer when `vod` is set, take `startNearEdge` out of
the opening path in favour of segment 0 (or the seek target), and return
`[0, durationSeconds]` from `seekable`. Feeding, pacing, the epoch, the field
queue and the fallback are untouched.

- [ ] **Step 4: Run the tests, then the whole suite**

- [ ] **Step 5: Commit**

---

### Task 4: The player chooses VOD for a finished recording

**Files:**
- Modify: `frontend/src/api/tablo.ts` (`watchRecordingVod`)
- Modify: `frontend/src/components/VideoPlayer.tsx`
- Test: `frontend/src/__tests__/recordings.test.tsx`

- [ ] **Step 1: Write the failing test** — a finished recording opens the VOD
  path; an in-progress one keeps the ring path; an ineligible browser gets the
  transcode.

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Branch on `state`**

`state === "recording"` keeps `watch-raw`; anything else finished tries
`watch-vod` first. Both fall back to `watchRecording` on any failure, exactly
as the current code does.

- [ ] **Step 4: Run the suite. Commit**

---

### Task 5: Verify against the device

Not optional, and not a substitute for the tests.

- [ ] Play a **short** finished recording end to end. `tabloDebug()` shows
  `kind: "wasm"`; no FFmpeg process starts; `/tmp/tablo_raw` stays empty.
- [ ] Play the **3½-hour** one. Seek to the middle, to the last minute, and
  back to the start. Measure how long each seek takes to first frame.
- [ ] Confirm the scrubber reads 215 minutes, not a window.
- [ ] Confirm `Keep` still produces an H.264 copy.
- [ ] Leave one paused for **three minutes** and resume — that is past the
  device's 165-second expiry and the case the keepalive exists for.
