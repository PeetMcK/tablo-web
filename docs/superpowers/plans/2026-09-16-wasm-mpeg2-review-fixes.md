# WASM MPEG-2 review fixes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every defect an adversarial review against ffplay and jsmpeg
found in the WASM live path, in the order that retires the most downstream
special cases per line changed.

**Architecture:** Four mechanisms account for nine of the eleven confirmed
findings. (1) An *epoch* stamped on every message across the worker boundary,
so nothing from before a seek can be mistaken for something after it. (2) An
audio clock anchored on the decoder's own timestamps and read from the worklet
rather than reconstructed on the main thread. (3) A heartbeat that covers ring
sessions, not only transcodes. (4) Presenting the newest due field instead of
the oldest. The rest are local.

**Tech stack:** TypeScript, Vitest, React; FastAPI/pytest on the backend;
libav.js 6.10.9 in a module worker; AudioWorklet; WebGL2.

**Spec:** `/private/tmp/tablo-wasm-mpeg2-handoff-3.md` §1 is the finding list
and the argument for each. `docs/superpowers/specs/2026-09-16-wasm-mpeg2-live-design.md`
is the original design; `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md`
holds the measurements. Do not re-derive those.

## Global constraints

- **Do not regress the nine bugs already fixed.** Every one has a test that
  encodes the measured failure. If a change here makes one of those tests fail,
  the change is wrong until proven otherwise — they cost hours each to find.
- The flag is currently **off** (`capability.ts`: unset means on, `"0"`
  disables). Leave it off for this work; it is how these bugs surface.
- Frontend suite must stay green: `cd frontend && npx vitest run` (441 tests at
  the start of this plan). Backend: `cd backend && .venv/bin/pytest -q` (328).
- Lint clean except the two pre-existing errors on main (`ChannelGrid.tsx`,
  `useMediaQuery.ts`).
- Comments in this codebase carry the measurement that justifies the constant.
  Keep that convention: when a constant changes, the comment says what was
  measured, not what was intended.
- Ask before committing. Commit per task.

---

### Task 1: Epoch across the worker boundary (F2, F10-part, F8-part)

Fixes the seek race the `awaitingReset` gate does not close: a `fetchBytes`
already awaiting when the seek happens still posts its segment after the
`reset`, and its output re-anchors the new position on old media time.

**Files:**
- Modify: `frontend/src/lib/wasmlive/workerProtocol.ts`
- Modify: `frontend/src/lib/wasmlive/session.ts:248-303, 325-435, 529-544`
- Modify: `frontend/src/lib/wasmlive/libavClient.ts:539-547`
- Test: `frontend/src/__tests__/wasmliveWorkerProtocol.test.ts`,
  `frontend/src/__tests__/wasmliveSession.test.ts`

**Interfaces:**
- Produces: `ToWorker` gains `epoch: number` on `segment` and `reset`;
  every `FromWorker` variant gains `epoch: number`. Session holds
  `let epoch = 0`, incremented in `seek()`.

- [ ] **Step 1: Write the failing test — a segment fetched before the seek must not reach the worker**

```ts
it("drops a segment whose fetch was in flight when a seek happened", async () => {
  let release: (b: ArrayBuffer) => void = () => {};
  const posted: ToWorker[] = [];
  const session = createSession({
    ...deps,
    worker: fakeWorker((m) => posted.push(m)),
    fetchBytes: () => new Promise((r) => { release = r; }),
  });
  const polling = session.poll();
  session.seek(30);                      // while the fetch is outstanding
  release(new ArrayBuffer(8));
  await polling;
  const segments = posted.filter((m) => m.type === "segment");
  expect(segments).toHaveLength(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest run wasmliveSession -t "in flight"`
Expected: FAIL — one segment posted.

- [ ] **Step 3: Stamp and check the epoch**

In `workerProtocol.ts`, add `epoch` to `ToWorker`'s `segment` and `reset`, and
to every `FromWorker` variant. The handler tracks the epoch its decoder belongs
to, updates it on `reset`, and stamps everything it posts:

```ts
let epoch = 0;
const post = (message: Omit<FromWorker, "epoch">, transfer: Transferable[]) =>
  rawPost({ ...message, epoch } as FromWorker, transfer);
// in "reset": epoch = message.epoch, then `finally` posts the ack
```

In `session.ts`, capture the epoch at the top of `poll()` and return after
every await if it moved:

```ts
const poll = async () => {
  const mine = epoch;
  ...
  const bytes = await deps.fetchBytes(segmentUrl(...));
  if (mine !== epoch) return;            // a seek overtook this fetch
  post({ type: "segment", bytes, epoch }, [bytes]);
```

Replace the `awaitingReset` gate in `onmessage` with `if (message.epoch !== epoch) return;`.

- [ ] **Step 4: Run the test; it passes. Run the whole suite; nothing regresses**

Run: `cd frontend && npx vitest run`

- [ ] **Step 5: Test that two seeks in quick succession do not open a window**

The old gate cleared on the first ack and let everything between the two resets
through. With an epoch there is no window; assert it.

- [ ] **Step 6: Clear the decode queue before tearing down**

`libavClient.reset()` calls `teardown()` first, which feeds the queue to EOF —
so every seek decodes up to a lookahead of media it is about to discard. Move
`queue = []` above the `await teardown()`.

- [ ] **Step 7: Commit**

---

### Task 2: An audio clock that follows the decoder's timestamps (F1)

The largest correctness gain in the plan. Today `notePts` keeps only the first
timestamp and `libavClient` synthesises the rest from a running sample count,
so one dropped AC-3 frame biases the clock by 32ms *for ever*, and a pts jump
freezes the picture into a fallback labelled `decode error`.

**Files:**
- Modify: `frontend/src/lib/wasmlive/libavClient.ts:236-238, 420-448`
- Test: `frontend/src/__tests__/wasmliveDecoderTiming.test.ts` (new)

- [ ] **Step 1: Write the failing test for a gap on the input side**

The unit under test is the pts mapping, so extract it from the pump first as a
pure function and test that:

```ts
// audioTimeline.ts
export interface AudioTimeline {
  anchorOut: number | null; expectedIn: number | null; framesEmitted: number; drift: number;
}
export function noteDecoded(t: AudioTimeline, ptsSeconds: number, frames: number, rate: number): void
export function nextOutputPts(t: AudioTimeline, rate: number): number
```

```ts
it("carries an input gap into the output timeline", () => {
  const t = createTimeline();
  noteDecoded(t, 10.000, 1536, 48000);          // 32ms of AC-3
  expect(nextOutputPts(t, 48000)).toBeCloseTo(10.000);
  noteDecoded(t, 10.064, 1536, 48000);          // 10.032 is missing
  // The output timeline must skip the gap, not close it.
  expect(t.drift).toBeCloseTo(0.032, 3);
});
```

- [ ] **Step 2: Run it and watch it fail** (module does not exist)

- [ ] **Step 3: Implement the timeline**

Detect the gap on the **input** side, where it is unambiguous, rather than
comparing filtered output against the decoder — the graph holds a steady
fraction of a frame and that delay would masquerade as drift. For each decoded
frame: if `expectedIn` is set and `|pts − expectedIn| > GAP_SECONDS`, add the
difference to `drift`. Then `expectedIn = pts + frames/rate`. Output pts is
`anchorOut + framesEmitted/rate + drift`.

`GAP_SECONDS = 0.02` — under one AC-3 frame (32ms), over any rounding.

- [ ] **Step 4: Run the test; it passes**

- [ ] **Step 5: Wire it into the pump**

Replace `audioAnchorPts`/`audioFramesEmitted` at `libavClient.ts:431-445` with
the timeline. `noteDecoded` runs over `decoded` (pre-filter, where the
decoder's own timestamps are), `nextOutputPts` stamps each filtered frame.

- [ ] **Step 6: Test the discontinuity case**

A jump of an hour — what resuming after a pause longer than the ring window
produces — must land the output timeline an hour on, not freeze it.

- [ ] **Step 7: Run the whole suite. Commit**

---

### Task 3: A clock read from the worklet, with output latency (F8, claim 2)

Three defects in one place: the anchor is stamped on main-thread receipt while
that thread is uploading 3MB textures; `outputLatency` is never subtracted, so
video is early by 10–50ms wired and 150ms+ on Bluetooth; and `flush()` zeroes
the counters while the worklet keeps its own partial `rendered`, which then
lands on the zeroed total.

**Files:**
- Modify: `frontend/src/lib/wasmlive/pcmWorklet.js:16-24, 58-63`
- Modify: `frontend/src/lib/wasmlive/audioSink.ts:24-33, 82-97, 106-133`
- Modify: `frontend/src/lib/wasmlive/audioClock.ts`
- Test: `frontend/src/__tests__/wasmliveAudioSink.test.ts`

- [ ] **Step 1: Write the failing test for the flush race**

```ts
it("ignores a worklet report that predates the flush", () => {
  const state = createSinkState(48000);
  notePts(state, 100); onSamplesPlayed(state, 48000, 1.0, 0);   // epoch 0
  flushState(state);                                            // epoch -> 1
  onSamplesPlayed(state, 2400, 1.1, 0);                         // in flight, old epoch
  notePts(state, 90);
  expect(sinkClockSeconds(state, 1.2)).toBeCloseTo(90, 1);      // not 90.05
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Give the worklet a timestamp, an epoch, and a real flush**

```js
// pcmWorklet.js
if (event.data === null || event.data?.flush) {
  this.queue = []; this.offset = 0;
  this.rendered = 0;                       // was leaking a partial count
  this.epoch = event.data?.epoch ?? this.epoch + 1;
  return;
}
...
if (this.rendered >= 4800) {
  this.port.postMessage({ rendered: this.rendered, at: currentTime, epoch: this.epoch });
  this.rendered = 0;
}
```

`currentTime` is a global in `AudioWorkletGlobalScope`, so the anchor is taken
where the samples are actually rendered rather than where the message lands.

- [ ] **Step 4: Subtract output latency**

`audioClockSeconds` takes the sink's `outputLatency` and subtracts it: the
clock should read what is *audible now*, not what has been handed to the
hardware. ffplay subtracts `(2*hw_buf + write_buf)/bytes_per_sec` for the same
reason. Default 0 where the browser does not report it.

- [ ] **Step 5: Run the suite. Commit**

---

### Task 4: Ring sessions must be reaped like transcodes (F3)

The worst operational finding: `touch_session` and `reap_idle_transcoders`
both consider `transcode_procs` only, and `sweep_stale_raw_dirs` explicitly
skips anything in `ring_sessions`. A closed laptop therefore holds a tuner and
grows a ring for the life of the backend — up to `LIVE_DVR_SECONDS` of raw
1080i, ~7–8GB.

**Files:**
- Modify: `backend/app/routes/stream.py:172-176, 189-209, 486-493`
- Test: `backend/tests/test_ring_reaping.py` (new)

- [ ] **Step 1: Write the failing test**

```python
async def test_idle_ring_session_is_reaped(monkeypatch):
    stream.ring_sessions["abc123ff"] = (ring, follower, task)
    stream.session_touched["abc123ff"] = time.monotonic() - stream.LIVE_IDLE_SECONDS - 1
    reaped = stream.reap_idle_sessions()
    assert "abc123ff" in reaped
    assert "abc123ff" not in stream.ring_sessions
    assert task.cancelled()
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Make the heartbeat and the reaper cover both kinds**

`touch_session` touches a session that is in *either* dict. Rename
`reap_idle_transcoders` to `reap_idle_sessions` and have it cancel the
follower task, drop the ring, and `rmtree` the raw directory as well — reusing
the teardown `stop_stream` already performs, so there is one code path for
"this session is over".

- [ ] **Step 4: Heartbeat from the playlist**

`raw_playlist` is polled every 500ms by the player; call `touch_session` there.
That is a far better liveness signal than the transcode's 30s status ping, so
`LIVE_IDLE_SECONDS` is generous for it rather than tight.

- [ ] **Step 5: Run the backend suite. Commit**

---

### Task 5: Replace the starvation rule (F4)

The rule cannot detect what it is named for: `tick()` runs the presenter before
reading `starvedBy`, and an empty queue reports `newestPts = null` → 0. It
fires only on stale fields left by other bugs, and two consecutive animation
frames (~33ms) end the session. Separately, `waiting` is emitted with no
matching `playing`, so one spurious event pins the stall overlay on screen.

**Files:**
- Modify: `frontend/src/lib/wasmlive/fallback.ts`
- Modify: `frontend/src/lib/wasmlive/session.ts:437-511`
- Test: `frontend/src/__tests__/wasmliveFallback.test.ts`,
  `frontend/src/__tests__/wasmliveSession.test.ts`

- [ ] **Step 1: Write the failing test — a real stall must not end the session**

```ts
it("does not fail the session when the queue merely empties", () => {
  // Two ticks with nothing queued is a rebuffer, not a broken decoder.
  // ffplay's AV_NOSYNC_THRESHOLD is 10s and it resyncs rather than quitting.
  const session = createSession(depsWithEmptyQueue());
  session.tick(); session.tick();
  expect(session.failure).toBeNull();
});

it("says playing again once fields are flowing", () => {
  const events: string[] = [];
  session.on("waiting", () => events.push("waiting"));
  session.on("playing", () => events.push("playing"));
  // ... empty, then refilled
  expect(events).toEqual(["waiting", "playing"]);
});
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Delete the rule, keep the signal**

Remove `"starved"` from `FallbackEvent`, the `starvations` array,
`STARVATION_WINDOW_MS`, `STARVATION_LIMIT` and `STARVED_SECONDS`. The
frozen-picture watchdog at `session.ts:487-496` already covers the genuine
failure — a picture that has stopped — and it measures presentations, which an
empty queue does affect.

Replace the event with a stall *state*, which is what the UI wanted all along:

```ts
const stalled = !paused && sawAudio && deps.presenter.queued === 0;
if (stalled !== wasStalled) {
  wasStalled = stalled;
  emit(stalled ? "waiting" : "playing");
}
```

- [ ] **Step 4: Run the tests; they pass. Run the suite**

- [ ] **Step 5: Commit**

---

### Task 6: Present the newest due field (F9)

`presentIndex = lastDue >= MAX_LATE_FIELDS ? lastDue : 0` was my change, and
the review is right that it is the wrong policy. At any tick rate below the
field rate it oscillates between ~66ms behind the audio and current, with a
4-field jump every third tick. ffplay never shows a frame whose successor is
already due; jsmpeg shows the newest.

**Files:**
- Modify: `frontend/src/lib/wasmlive/frameQueue.ts:45-80`
- Test: `frontend/src/__tests__/wasmliveFrameQueue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("shows the field whose moment has come, not the one before it", () => {
  const queue = [{ ptsSeconds: 1.0 }, { ptsSeconds: 1.016 }, { ptsSeconds: 1.033 }];
  // A tick at 1.04: all three are due. The viewer must see the newest.
  expect(selectFrame(queue, 1.04).present).toEqual({ ptsSeconds: 1.033 });
});
```

- [ ] **Step 2: Run it and watch it fail** (returns 1.0)

- [ ] **Step 3: Present `queue[lastDue]`; delete `MAX_LATE_FIELDS`**

Rewrite the comment to record what was actually learned: the 47 presentations a
second that motivated the old rule were the main thread missing ticks, and
turning a missed tick into lag hides that rather than fixing it.

- [ ] **Step 4: Run the suite. Commit**

---

### Task 7: Do not start the failure clock against a suspended context (F6)

`open.ts` resumes once and swallows the refusal. Suspended, the worklet renders
nothing, so no field is ever due, `presentedCount` stays 0, and the session
fails `no first frame` after 8 seconds — before the viewer has had a chance to
click. Deep links, background tabs and first visits under Chrome's MEI all land
here.

**Files:**
- Modify: `frontend/src/lib/wasmlive/audioSink.ts` (expose `contextState`)
- Modify: `frontend/src/lib/wasmlive/session.ts:437-455, 480-497`
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("does not give up while the audio context is suspended", () => {
  const session = createSession({ ...deps, audio: { ...sink, contextState: "suspended" } });
  await session.start();
  advance(FIRST_FRAME_DEADLINE_MS + 1000);
  session.tick();
  expect(session.failure).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Hold both timers while the context is not running**

The same shape as the paused hold already in `tick()`: push
`fallback.startedAtMs` and `lastProgressAtMs` forward rather than skipping the
check, so the first tick after the context starts does not look back over the
whole wait and call it a stall.

- [ ] **Step 4: Run the suite. Commit**

---

### Task 8: Seeking to the right-hand end (F7)

`VideoPlayer.tsx:905` clamps inclusive to `rangeEnd`; `segmentAt` returns null
for `>= end`; `session.ts:333` then sets `takenThrough = -1` and the `else if`
below it skips `startNearEdge` — so the feed loop starts from `mediaSequence`,
the *oldest* segment in the window. `rangeEnd` is up to 500ms stale against a
ring that grows every second, so roughly half of all drags to the end jump up
to an hour back.

**Files:**
- Modify: `frontend/src/lib/wasmlive/playlist.ts:72-95`
- Modify: `frontend/src/lib/wasmlive/session.ts:330-344`
- Test: `frontend/src/__tests__/wasmlivePlaylist.test.ts`

- [ ] **Step 1: Write the failing tests** — `segmentAt` at and past the end
  returns the last segment; a seek past the end starts near the edge, not at
  `mediaSequence`.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Fix both halves**

`segmentAt` treats `>= end` as the last segment, for the same reason it already
treats `< start` as the first: the viewer asked for the nearest thing that
exists. In `session.ts`, a seek whose target has no segment falls through to
`startNearEdge` rather than to `-1`.

- [ ] **Step 4: Run the suite. Commit**

---

### Task 9: Decoder errors, timers and teardown (F10, F11)

**Files:**
- Modify: `frontend/src/lib/wasmlive/libavClient.ts:266-284, 466-477, 479-507`
- Modify: `frontend/src/lib/wasmlive/session.ts:597-605`
- Test: `frontend/src/__tests__/wasmliveDecoder.test.ts`

- [ ] **Step 1: Surface a pump failure when it happens**

Today the rejection is stored and rethrown on the *next* `push`, so a pump that
dies while pacing is holding segments back appears six seconds later as
`nothing drawn for 6s` — the wrong detail on the wrong rule. Add an `onError`
option, fired from the pump's `catch`.

- [ ] **Step 2: Clear the open deadline when the open wins its race**

`openDeadline()` at `:271-284` leaves a 10s timer and an unhandled rejection
behind on every open — which means every seek. Same `try/finally` shape
`loadLibav` already uses.

- [ ] **Step 3: Free the filter graphs**

`teardown` frees the decoders and the format context but never the graphs, and
`libav.terminate?.()` is a **no-op in `noworker` mode** in this vendored build,
so nothing collects them. Call `avfilter_graph_free_js` on `vsrc/vsink` and
`asrc/asink` where they exist.

- [ ] **Step 4: Let the worker close before terminating it**

`session.destroy()` posts `close` and calls `terminate()` synchronously; the
worker is dead before it dequeues the message. Await the close with a short
timeout, then terminate.

- [ ] **Step 5: Run the suite. Commit**

---

### Task 10: Timeouts and poll overlap (S3)

`pollChain` grows without bound when a poll outlasts `POLL_INTERVAL_MS`, and
`fetchBytes` has no timeout at all — so one hung segment fetch blocks every
later poll until the watchdog fails the session. The backend's device requests
were given timeouts; these were missed.

**Files:**
- Modify: `frontend/src/lib/wasmlive/open.ts:68-77`
- Modify: `frontend/src/lib/wasmlive/session.ts:427-435, 514-524`
- Test: `frontend/src/__tests__/wasmliveSession.test.ts`

- [ ] **Step 1: Write the failing test** — a tick while a poll is in flight
  must not queue a second poll.
- [ ] **Step 2: Skip the tick rather than chaining it**, and give both fetches
  an `AbortSignal.timeout`.
- [ ] **Step 3: Run the suite. Commit**

---

### Task 11: The small ones (S4, S5, S6, F5-interim)

- [ ] **Step 1: Honour the chunk's sample rate** (S4). The sink counts at
  `context.sampleRate` and ignores `chunk.sampleRate`; the resample graph emits
  at the *input* rate. ATSC mandates 48k so this has never bitten, but the
  assumption should be asserted rather than implied — throw a decoder error on
  a mismatch, which is a diagnosable failure instead of a pitch-shifted one.
- [ ] **Step 2: Duration from the next frame, not the previous** (S5).
  `libavClient.ts:385` measures backwards where ffplay's `vp_duration` measures
  forwards; at a cadence change the second field of an interlaced frame is
  mistimed by half the difference.
- [ ] **Step 3: Stop calling every late worker exception `init failed`** (S6),
  and drop the `emit("error")` at `session.ts:510` that fires 60×/s with no
  subscriber.
- [ ] **Step 4: Make the queue comments agree with the constant** (F5 interim).
  `frameQueue.ts:43` is 200; its own comment says 120 and `session.ts:45` says
  150. One number, stated once, with the memory cost that follows from it.
- [ ] **Step 5: Run both suites. Commit**

---

## Deferred, with reasons

- **F5 proper — credit-based decoding.** We buffer decoded output where ffplay
  blocks its decoder thread on a condvar at 3 frames and jsmpeg decodes inside
  the rAF. The right shape is for the worker to hold the *compressed* segments
  and call `ff_read_frame_multi` only while the page has credit, dropping the
  field queue to ~10 frames and retiring most of `session.ts`'s pacing. That is
  a redesign of the transport, not a fix, and it should follow a soak of the
  fixes above rather than land with them.
- **S1 — media time from fetch timestamps.** `live_follower.py:201` dates each
  segment when it was fetched, so the axis drifts against pts and, once the
  window fills, evictions move it while the playhead does not. The fix is to
  derive media time from accumulated durations against a fixed origin sequence,
  or to have the backend stamp `PROGRAM-DATE-TIME` from the segment's own PCR.
  Both touch the ring's serialisation; deferred until Task 4's reaping is
  proven, since they share the file.
- **S2 — background-tab throttling.** `setInterval` drops to ~1/min after five
  minutes hidden, draining the buffer, and the session silently resumes minutes
  behind live. Same root as the PiP/rAF problem in the handoff's §5, and worth
  solving once for both rather than twice.

## Verification

Per task: the named test fails first, passes after, and the full suite stays
green. At the end of the plan, before claiming any of this works:

1. Both suites green, lint clean, `npm run build` clean.
2. A **soak against the real device** — not a good three-minute mean. The
   acceptance criterion is *no fallback over a long run*, because a build that
   looked clean for three minutes died at 84 seconds on a longer one.
3. Exercise what the 17-minute run did not: a seek to the right-hand end of the
   bar (Task 8), a pause longer than the ring window (Task 2), a backgrounded
   tab (S2, expected to still fail), and a session left open with the tab
   closed, checking `/tmp/tablo_raw` empties (Task 4).
