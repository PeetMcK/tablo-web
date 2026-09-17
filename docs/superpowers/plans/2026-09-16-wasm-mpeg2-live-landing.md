# Landing the WASM live path on main

**Goal:** get 27 commits of work onto `main` without holding a branch open
against the busiest file in the repository, and without a viewer noticing.

**Spec:** `docs/superpowers/specs/2026-09-16-wasm-mpeg2-live-design.md`
**What was built and why:** `docs/superpowers/plans/2026-09-16-wasm-mpeg2-live-phase0.md`

---

## Where this actually stands

| | |
|---|---|
| Branch ahead of main | 27 commits |
| Branch behind main | ~150 commits |
| Merge base | `7e312cf` |
| Files that conflict | **2** |
| Everything else | auto-merges |

The two are `backend/app/routes/stream.py` (main added ~200 lines: ffmpeg off
the event loop, reaping idle transcodes, not outliving the backend) and
`frontend/src/components/VideoPlayer.tsx` (main added ~859 lines: picture-in-
picture, fullscreen, skip and go-live, stall grace, buffered-truth, back-closes-
player).

**The mechanical merge is small. The semantic cost is one thing:** this branch
refactored the player to run through a `PlaybackSurface`, and main then grew
859 lines of new player written against the `<video>` element directly. Merging
means deciding, feature by feature, which of those need to work on a canvas.

## The strategy: land it behind the off-flag, early

`tablo.wasmlive` is default-off, and with it off the player takes exactly the
path it takes on main today. That makes the merge a near-no-op for every
viewer, and it is the single most valuable property this work has.

So: **merge on that property, now, rather than fixing the WASM path first.**
The branch is already 150 commits behind on the repository's hottest file.
Every day it stays open, the merge gets worse and the divergence hides real
conflicts. Landing it turns a growing integration risk into a list of ordinary
bugs behind a flag.

The alternative — perfect the WASM path on the branch, then merge — front-loads
the least certain work and back-loads the risk that is actually growing. Do not
do that.

---

## Task 1: the merge itself

**Files:** `backend/app/routes/stream.py`, `frontend/src/components/VideoPlayer.tsx`

- [ ] Merge `main` into the branch (not the other way; keep the branch's history
      reviewable). Resolve the two conflicts.
- [ ] `stream.py`: take main's transcode lifecycle work wholesale — reaping,
      event-loop offload, shutdown. It does not touch the ring. Keep the
      branch's ring routes, priming, and `sweep_stale_raw_dirs` alongside it.
      Watch for two startup-cleanup paths fighting.
- [ ] `VideoPlayer.tsx`: keep main's player as the shape, and re-apply the
      branch's three changes onto it — surface creation with `attachTransport`
      wired at creation time, the canvas mounted beside the video with `hidden`
      toggling, and `fallBack` releasing the ring session it abandons.
- [ ] `npx vitest run`, `npx eslint src`, `npm run build`, and the backend suite.
- [ ] **Verify the off-flag property on the device**: with `tablo.wasmlive`
      unset, open a channel and confirm it is byte-for-byte the main
      experience — transcode path, PiP, fullscreen, skip, go-live. This is the
      gate for merging; nothing about the WASM path is.
- [ ] Merge to `main`.

## Task 2: stop the slow death (do this first of the WASM fixes)

The current top bug, measured tonight: a soak ran 84 seconds and then fell back
with "repeated starvation". `minBuf` sat at exactly 0.5 — `MIN_BUFFER_SECONDS`,
which is the starvation threshold itself — and the live offset drifted from
10.4s to 19.6s as playback fell behind.

Cause is the queue high-water gate added late in the session: it stops feeding
whenever the field queue is full, which pins the audio buffer on the starvation
floor, which fires a starvation event on a timer until the fallback's
two-in-thirty-seconds rule trips.

- [ ] Gate on the queue **only when audio is comfortably buffered**, not merely
      above the floor — `bufferedSeconds > COMFORTABLE` rather than
      `!starving`. The floor is a fallback trigger and must not be a set point.
- [ ] Give the cap headroom above high-water-plus-one-burst so the looser gate
      cannot reintroduce refusals, or reduce what one feed delivers.
- [ ] Re-soak for 30 minutes. The acceptance criterion is *no fallback*, not a
      good mean: a clean three-minute window is what made this look finished.

## Task 3: seeking

Reported broken, and the cause is identified. `audioSink.flush()` resets
`framesSent` and the interpolation anchor but not `firstPtsSeconds` or
`samplesPlayed`, so after a seek the clock keeps counting from the *original*
origin while the decoder emits the new position's timestamps.

- [ ] Reset the clock anchor on flush, and let the next chunk re-anchor it.
- [ ] Test: seek, then assert the clock reports the new position rather than
      continuing from the old one.
- [ ] Then exercise it on the device: rewind into the DVR window, return to
      live, and seek within the primed region.

## Task 4: decide what picture-in-picture means on a canvas

Main mirrors the picture with `video.captureStream()` into a Document PiP
window. On the WASM path `videoRef` is a hidden element with no source, so PiP
would open an empty window — a visible break, not a graceful degradation.

`canvas.captureStream()` exists, so the mirror can work; it needs a
`captureStream()` on `PlaybackSurface` with both implementations behind it.

- [ ] Add it to the surface, or explicitly disable the PiP control when the
      active surface cannot mirror. Either is defensible; silently opening an
      empty window is not.

## Task 5: audit the rest of main's player against the surface

Each of these was written against the element after the surface refactor. For
each: does it work on the WASM surface, and if not, does it degrade or break?

- [ ] fullscreen (`webkitEnterFullscreen` is element-only)
- [ ] skip / go-live, and the live-edge margin main added
- [ ] stall grace — the overlay's "earn it" rule reads element state
- [ ] buffered-truth: "let the buffer, not the cache report, say what plays now"
      reads `video.buffered`, which a canvas has no equivalent of
- [ ] the cached band and its drawing
- [ ] back-closes-player, keyboard, and the pop-out's second React root

## Task 6: the window end, and the timestamps under it

`seekable`'s end derives from segment fetch timestamps rather than media time.
Joining at the live edge hid this, but it is the same class of bug that had
playback starting 25s inside the DVR: the ring dates a segment when it was
fetched, not when it was broadcast.

- [ ] Date ring segments by accumulated duration from the ring's origin.
- [ ] Check the scrub bar, the live-edge margin, and rewind against it.

## Task 7: the flag

- [ ] The rest of the soak checklist: tab switch and background, channel
      change, a CPU measurement against the transcode path for comparison, and
      a forced-fallback test.
- [ ] Default `tablo.wasmlive` on, with the kill switch documented.
- [ ] Only then consider removing the transcode path for OTA, which is where
      the CPU saving actually lands.

---

## Order, and why

1, then 2, then 3 — merge first for the reason above; then the bug that makes
the path unusable for more than a minute; then the one the user can see.

4 and 5 are the real integration debt and can be done incrementally on main,
each behind the same off-flag. 6 and 7 are last: 6 is cosmetic until the flag
flips, and 7 is the flip itself.

## What not to re-derive

The measurements in the phase-0 document, particularly: decode runs at ~1000
frames a second in the browser worker and has never been the bottleneck; the
libav runtime must be loaded as an asset and not bundled into the worker chunk;
the device's playlist is an hour of recording rather than a live window; and
Chrome decodes no AC-3 at all. Each of those cost hours.
