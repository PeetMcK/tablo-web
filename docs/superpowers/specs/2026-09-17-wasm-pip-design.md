# Picture-in-picture on the WASM live path — design

**Date:** 2026-09-17
**Status:** approved, not implemented
**Touches:** `frontend/src/components/VideoPlayer.tsx`,
`frontend/src/lib/wasmlive/open.ts`

## The gap

Live TV decoded in WASM cannot be popped out. The code says so itself, at
`VideoPlayer.tsx:1429`:

> The canvas travels with it, and only into the tab's own stage: the pop-out
> is fed by a mirror of the video element's stream, which a canvas has no part
> in. Picture-in-picture on the WASM path is a known gap.

So the better-looking path is the one that loses a feature the worse-looking
one has. A viewer on a Chromium browser watching live TV gets no pop-out at
all, and nothing on screen explains why — the button is rendered from
`"documentPictureInPicture" in window`, which has nothing to do with which
decoder is running.

## What already works, and must not be disturbed

The pop-out does **not** move the playing element. `openMirror`
(`VideoPlayer.tsx:1399`) builds a second, muted `<video>` fed by
`videoRef.current.captureStream()`, and `placeVideo` puts that mirror in the
pop-out while the real element stays in the tab. Audio, controls and the
playhead never cross documents.

That indirection is the whole reason this change is small. The pop-out already
consumes *a stream of pixels from somewhere*; it does not care what produced
them.

## The design

### 1. The mirror takes its stream from whichever element is live

`HTMLCanvasElement.captureStream()` is the exact analogue of
`HTMLVideoElement.captureStream()`: same shape, same resulting MediaStream
with one video track. `openMirror` picks its source by which path is running —
`usingWasm ? canvasRef.current : videoRef.current` — and nothing downstream
changes. `placeVideo` is untouched: the canvas stays in the tab, which is
already what it does.

Browser support lines up exactly. The pop-out button only renders where
Document Picture-in-Picture exists, which is Chromium, where canvas capture is
long-settled. Safari renders no button on either path today and keeps its
native `<video>` pop-out on the transcode path, unchanged.

### 2. The presentation loop follows the visible window

This is the part that is not plumbing.

`open.ts:154` drives presentation from `requestAnimationFrame` in the main
document. A hidden document suspends rAF — measured in this codebase on
2026-09-16, where an automated tab reporting `visibilityState: "hidden"` ran
zero frames in 300ms. The two paths therefore diverge the moment the tab is
backgrounded, which is precisely what popping out is for:

| | tab hidden, pop-out visible |
|---|---|
| `<video>` | media decoding is not rAF-bound; `captureStream` keeps producing; pop-out plays |
| canvas | rAF stops; nothing repaints; `captureStream` yields a frozen frame |

So `OpenOptions` gains a frame source, and `openWasmSurface` returns a way to
change it:

```ts
/** Where animation frames come from. Defaults to the main document. */
frames?: FrameSource;            // { request, cancel }

// on the returned surface
setFrameSource(next: FrameSource): void;
```

`VideoPlayer` hands the pop-out window's `requestAnimationFrame` in when the
window opens, and the main document's back when it closes — alongside the
mirror teardown that already happens there.

A frame source is two functions, so a test can drive it by hand without a
display, which is what makes the swap testable at all.

### 3. Nothing about the decode path changes

The worker, the audio clock, the ring and the deinterlacer are untouched. The
only edit inside `wasmlive/` is where `loop` gets its frames.

## Deliberately not doing

**Painting from the worker via `OffscreenCanvas`.** It is the strongest end
state and the groundwork exists — `capability.ts` already requires
`OffscreenCanvas`, `createRenderer` already accepts one. It is also the
largest change to the part of the system that currently works well, and the
window-following loop makes it unnecessary for the case at hand. Revisit if a
throttling case appears that a visible window cannot answer.

**A worker-driven clock while hidden.** Covers more cases — including no
pop-out at all — but a timer is not the display clock, and it would leave two
timing paths to keep honest against the audio clock.

**Any change to Safari.** No Document PiP, so no button, on either path.

## How it will be known to work

Phase 0 verifies the freeze before anything is built. If a canvas keeps
painting in a hidden document, section 2 is unnecessary and the change is
section 1 alone — the plan must not assume its own premise.

Then: pop out on the WASM path and see the picture; background the tab and see
it keep moving; close the pop-out and see the tab's own stage resume. The
transcode path must behave exactly as it does today throughout.
