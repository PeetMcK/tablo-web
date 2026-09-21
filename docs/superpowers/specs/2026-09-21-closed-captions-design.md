# Closed captions on the MPEG-2 paths

Broadcast captions reach the app and are thrown away. This restores them for
the two paths that carry MPEG-2 — live, and recordings played through the WASM
decoder — by extracting the caption bytes the stream already contains,
decoding them in the browser, and drawing them over the canvas.

The H.264 transcode path is deliberately out of scope. It has a different
problem, described at the end.

## What the device actually sends

The Tablo is a passthrough. It hands over the tuner's MPEG-2 transport stream
untouched, which is why the app spends its CPU re-encoding. Captions are not
something the device adds or withholds: in ATSC they travel inside the MPEG-2
video itself, as picture user data, and they are already there in every stream
the app receives.

The committed fixture `frontend/src/lib/wasmlive/__fixtures__/1080i-1s.ts.bin`
proves it. One second of real broadcast, and it carries **31** user-data blocks
— one per picture at 29.97 fps. Decoding the first:

```
000001B2 "GA94"  user_data_type_code=0x03
  flags=0xd4  (process_cc_data_flag set)  cc_count=20  em_data=0xff
  cc[0]  valid=1  cc_type=0  4f c4     <- EIA-608 field 1
  cc[1]  valid=1  cc_type=1  80 80     <- EIA-608 field 2
  cc[2]  valid=1  cc_type=3  c2 22     <- DTVCC packet start
  cc[3]  valid=1  cc_type=2  4f 44     <- DTVCC packet data
  cc[4..19] valid=0                    <- padding to a fixed cc_count
```

Stripping the odd-parity bit off the field-1 bytes across that second gives
`O`, `D`, `S`, `G`, `.` — caption text, mid-sentence.

So both EIA-608 and CEA-708 are present on every picture. This design decodes
608 only; see "Out of scope".

The `qualifiers` field on a cloud guide airing (`docs/tablo-api.md`) is EPG
metadata — a listing footnote saying the broadcast is captioned. It is not a
control, nothing in the app reads it, and no API call turns captions on or off.

## Why the work goes in the browser

Both MPEG-2 paths already converge on one place. Live reaches
`openWasmSurface` through `chooseLivePath`; a recording reaches it through
`watchRecordingVod` at `VideoPlayer.tsx:1057`, falling back to the H.264
transcode when the WASM path is ineligible. A single integration point in that
pipeline therefore serves both, and nothing serves the fallback — which is the
behaviour we want, since the fallback has no captions to show.

The rejected alternative was extracting server-side with FFmpeg's `subcc`
pseudo-stream and serving WebVTT. It would be reusable by the H.264 path
later, but it puts FFmpeg back onto the one path whose entire purpose is
avoiding FFmpeg: the raw MPEG-2 route exists so the machine is not saturated.
It would also need a per-viewer extractor process for live, and a new mapping
from FFmpeg's timestamps onto the ring's media timeline. The H.264 path needs
its own encoder-side fix regardless, so the reuse it buys is smaller than it
looks.

## Architecture

```
decode worker                                   page
─────────────                                   ────
ff_read_frame_multi
   │  AVPackets (one per picture, with PTS)
   ▼
extractCcData(packet.data) ──► [{pts, pairs}]
   │
   ▼
CaptionTrack (vendored 608 parser)
   │  cues {startSeconds, endSeconds, text}
   ▼
DecodeOutput.captions ──► FromWorker "captions" ──► session cue queue
                                   (epoch-stamped)        │
                                                          ▼
                                                   CaptionOverlay
                                                   (rAF vs currentTime)
```

### `frontend/src/lib/captions/`

| File | Responsibility |
|---|---|
| `extract.ts` | `extractCcData(bytes) → CcPair[]` — find the ATSC user data in one MPEG-2 picture and return its valid 608 pairs |
| `cea608.ts` | The EIA-608 state machine, vendored from hls.js |
| `track.ts` | `CaptionTrack` — feed pairs in PTS order, collect cues, reset on seek |
| `index.ts` | `CaptionCue`, `CcPair`, re-exports |

Each unit is usable and testable without the others: `extract.ts` is a pure
function over bytes, `cea608.ts` is a state machine over byte pairs, and
`track.ts` is the small amount of glue that owns ordering and reset.

### Extraction

`extractCcData` scans an assembled AVPacket — one coded picture — for the
sequence `00 00 01 B2` (user_data_start_code) followed by `GA94` and
`user_data_type_code` `0x03`, then walks `cc_count` three-byte entries and
returns those with `cc_valid` set and `cc_type` of 0 or 1.

Two properties keep this cheap and safe:

- **The scan is bounded.** User data appears in the picture header region,
  before the slices. The scan stops at the first slice start code
  (`00 00 01` followed by `01`–`AF`), which caps it at a few hundred bytes per
  picture rather than the whole packet. At 1080i this is the difference
  between scanning kilobytes and megabytes per second.
- **No packet reassembly is needed.** The scan runs on the AVPacket the
  demuxer has already assembled from its PES, so a user-data block is
  contiguous by construction. Nothing straddles a boundary we can see.

### Parsing, and where it runs

Parsing happens in the worker, alongside extraction, and the page receives
finished cues. Two reasons: the main thread stays free of a per-picture state
machine, and the worker already has the mechanism a caption parser needs.

EIA-608 is a command stream, not a list of cues — the decoder carries screen
state across the whole stream, so a seek must reset it or captions resume
mid-sentence from wherever the viewer was. The worker's existing `epoch`
machinery does exactly that: the page bumps an epoch on every seek and the
worker rebuilds its decoder. Resetting the caption parser in the same place
costs one line and inherits semantics that are already tested.

Packets are sorted by PTS within each read round before being fed to the
parser. MPEG-2 PES carries a presentation timestamp per picture, so PTS order
is display order and no DTS reordering arithmetic is required.

The parser itself is vendored rather than depended upon. It is
`hls.js/src/utils/cea-608-parser.ts` — 1413 lines, BSD-licensed, ported from
dash.js, and exercised by every hls.js user. It is only reachable as
TypeScript source inside `node_modules`, which Vite does not transpile, so a
copy under `src/lib/captions/` is the honest way to use it. Its logic is
copied unmodified; only the hls.js logger import is replaced.

### Protocol

`DecodeOutput` gains `captions: CaptionCue[]`, and `FromWorker` gains:

```ts
| { type: "captions"; cues: CaptionCue[]; epoch: number }
```

epoch-filtered on arrival exactly as `video` and `audio` already are. A cue
decoded before a seek and delivered after the flush is discarded by the same
rule that discards a stale frame.

### Session and surface

`session.ts` keeps a rolling cue queue, pruned behind the playhead, and emits
a new `"captions"` `SessionEvent` when it changes.

`PlaybackSurface` gains an **optional** member:

```ts
/**
 * Captions, when the implementation has any. Optional, and absent on the
 * element-backed surface: an H.264 transcode carries none, so a surface that
 * cannot produce captions says so by not having this.
 */
captions?: CaptionSource;
```

Optionality is load-bearing rather than incidental. The player's rule for
showing its CC button is "this surface has captions and has seen one", which
resolves correctly for the transcode fallback, for uncaptioned programming,
and for a mid-session fallback, without any of the three being special-cased.

```ts
export interface CaptionSource {
  /** True once a valid 608 pair has been seen on this source. */
  readonly available: boolean;
  /** The cue covering this media time, or null. */
  at(seconds: number): CaptionCue | null;
  on(event: "change", handler: () => void): () => void;
}
```

### Rendering

`CaptionOverlay` is a DOM layer over the stage host: absolutely positioned,
`pointer-events: none`, bottom-centred, white on translucent black, sized
relative to the player's height, and `aria-live="polite"` so a screen reader
reads what a hearing viewer is shown.

It drives itself from `requestAnimationFrame` against `surface.currentTime`
rather than from the player's `timeupdate`, which fires around four times a
second — enough for a scrubber, visibly late for roll-up captions that advance
per word. The frame source is injected, following `playbackSurface.ts`'s
existing `FrameSource` pattern, so tests step the loop by hand.

A DOM overlay is not captured by `canvas.captureStream()`, so captions do not
appear in the picture-in-picture pop-out (`VideoPlayer.tsx:1948`). That is
accepted here: the alternative is rasterising glyphs into a texture and
compositing them in the WebGL pass, which costs a second renderer, loses
selectable and screen-readable text, and blurs on resize.

### Controls

A CC button sits beside picture-in-picture in the control bar, with a `C`
shortcut registered alongside the existing ones. It renders only when
`surface.captions?.available` is true — so it appears a second or so into a
captioned stream and never appears at all where there is nothing to show. On
and off persist in `localStorage` under `tablo.cc`, read defensively: a
browser blocking site data throws, and that reads as off.

## Timing

Cue times are media seconds taken from packet PTS, which is the same domain as
`currentTime` and the same clock the presenter already draws fields against.
No mapping, no offset table, no correspondence to maintain.

After a seek the parser starts from nothing, so captions take a second or two
to reappear while the next pop-on or roll-up builds. This is inherent to 608
and is what a television does on a channel change.

## Testing

| Level | What it covers |
|---|---|
| `extract.ts` | Against `1080i-1s.ts.bin`: 31 user-data blocks, 31 valid field-1 pairs, exact bytes (`4f c4`, `20 d3`, `4f 20`). Real broadcast data, no device |
| `extract.ts` | A packet with no user data returns nothing; a truncated block does not overrun |
| `track.ts` | Synthetic pop-on, roll-up, paint-on and erase command sequences produce the expected cues and timings |
| `track.ts` | `reset()` drops screen state, so a cue in progress does not leak across a seek |
| Overlay | Correct cue for a given time; clears when none covers it; steps on an injected frame source |
| Component | Button hidden until available, toggles, persists, and `C` works |

The one-second fixture is long enough to assert extraction byte-for-byte but
too short for the parser to finish a cue — pop-on captions need roughly two
seconds. Implementation therefore captures and commits a ~10 second captioned
fixture from a real recording, which is what lets a test assert real text
arriving end to end.

## Risks

| Risk | Handling |
|---|---|
| Per-picture scan cost at 1080i | Bounded by the slice start code; measured against the fixture during implementation |
| A channel carrying captions only in 708, with 608 padding | The button never appears, which is correct but silent. A `tabloDebug()` counter reports blocks seen versus pairs decoded |
| Vendored parser drifts from upstream | It is a port of a stable dash.js file and 608 is a frozen standard. Provenance recorded in the file header |
| Cue queue grows without bound on a long recording | Pruned behind the playhead whenever the session prunes frames |

## Out of scope

- **CEA-708.** It is present in the stream and offers real positioning, fonts
  and multiple services, but there is no reusable permissively-licensed JS
  decoder to vendor — it means building a DTVCC packet reassembler and a
  window/pen state machine from the spec. The module boundary above lets a 708
  decoder be swapped in behind `CaptionTrack` later without touching
  extraction, transport or rendering.
- **Caption appearance settings** — size, font, colour, opacity.
- **Captions in picture-in-picture.**
- **The H.264 transcode path.** Two separate defects live there, both to be
  addressed in their own pass. `h264_videotoolbox` is given `-a53cc 0`
  (`transcode_cache.py:122`), which is mandatory — without it VideoToolbox
  fails every frame re-injecting the SEI and encodes nothing. Separately, a
  cached `libx264` window inspected while writing this spec
  (recording 86091) contains **zero** H.264 SEI `GA94` payloads, so the
  software path may be dropping captions too. That needs its own
  investigation; do not assume `-a53cc` defaults are carrying them.
