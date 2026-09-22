# CEA-708 captions, with 608 as the floor

The MPEG-2 paths already show captions, decoded from EIA-608. The same
pictures also carry CEA-708, which says *where* a caption belongs and how it
should look — and that is the part 608 cannot express. This adds a 708 decoder
alongside the 608 one, a window model in the renderer, and a rule for choosing
between them that can never leave a viewer worse off than today.

Extends `2026-09-21-closed-captions-design.md`. Extraction, transport, timing,
the CC button and the surface contract are unchanged.

## What is actually in these streams

Measured, not assumed. Three seconds of ABC 720p — the committed fixture
`720p-captions-3s.ts.bin` — reassembled into DTVCC packets:

```
DTVCC packets reassembled: 57
service 1: 201 bytes

     91  G0 text                     6  SPA SetPenAttributes
      7  SPL SetPenLocation          4  SPC SetPenColor
      3  HDW HideWindows             3  CLW ClearWindows
      2  DF0/DF1 DefineWindow        2  SWA SetWindowAttributes
```

Decoding the arguments of the two that decide the look:

| Command | Value in this capture |
|---|---|
| `DefineWindow` | anchor `bottom-left`, relative, **`h=0` and `h=50`**, 4 rows x 32 cols |
| `SetPenColor` | `fg=white/solid bg=black/solid` — the default |
| `SetPenAttributes` | standard size, font 0, **italic=0, underline=0** |
| `SetWindowAttributes` | justify left, left-to-right, no word wrap |

Two conclusions, and they point in different directions:

- **Positioning is genuinely used.** Two windows at different horizontal
  anchors, which is information 608 has no way to carry. This is the payoff.
- **Styling is entirely default here.** Every pen and window attribute is at
  its default value, so a styling layer renders identically to what the
  overlay already draws — for this broadcaster, in these three seconds.

Styling is still implemented, because the decoder produces it whether or not
we read it and the mapping is small, and because other broadcasters do use
colour for speaker identification. It is simply not expected to be visible on
ABC.

One service only. No second language, no alternate track.

The same 201 bytes also decode to the same sentence the 608 path produces —
"Elliot had shown them how to find light in the darkness." 708 is not carrying
different words here. It is carrying the same words with placement attached.

## Choosing a decoder

Three candidates were examined rather than assumed.

| Library | Licence | 708 | Verdict |
|---|---|---|---|
| `hls.js` | Apache-2.0 | none | Already vendored for 608; has no 708 at all |
| `mux.js` 6.3.0 | Apache-2.0 | parses fully | **Discards position at emission** |
| `shaka-player` 5.2.11 | Apache-2.0 | parses fully | **Keeps position** |

`mux.js` is the more convenient shape — plain ES modules — and was the wrong
choice for exactly one reason, which is worth recording because it is the kind
of thing a convenience ranking hides. Its `Cea708Stream.flushDisplayed` reads:

```js
// TODO: Positioning not supported, displaying multiple windows will not
// necessarily display text in the correct order...
for (var winId = 0; winId < 8; winId++) { ... displayedText.push(...) }
service.text = displayedText.join('\n\n');
```

It parses `anchorPoint`, `anchorVertical` and `anchorHorizontal` into its
window objects and then throws them away, emitting a flat string. For a
feature whose entire value is placement, that is the one thing it cannot do.

Shaka's `cea708_window.js` maps the same fields onto a `CueRegion` —
`adjustRegion_`, citing the W3C 608-to-VTT positioning note — and tracks
italics, underline and colour per pen position. So Shaka it is, at the cost of
a Closure-to-ESM conversion.

### What gets vendored

| File | Lines | Why |
|---|---|---|
| `cea708_service.js` | 730 | The service state machine — commands, windows |
| `cea708_window.js` | 516 | Window and pen model, and the region mapping |
| `dtvcc_packet_builder.js` | 191 | DTVCC packet reassembly |
| `cea_utils.js` | 380 | Styled characters, shared helpers |

Not vendored: `mp4_cea_parser`, `ts_cea_parser`, `sei_processor` — extraction
is already solved here and those exist to do it from containers we do not use.
Not vendored either: Shaka's `cea608_*`, because the hls.js 608 decoder is
working, tested, and the floor this design rests on.

**`shaka.text.Cue` is shimmed, not vendored.** It is 955 lines and pulls in
`ArrayUtils`, `StringUtils`, `TextParser` and `TXml`; `cea708_window.js` uses
a handful of its fields. A local `Cue`/`CueRegion` with just those fields is
roughly a hundred lines and keeps the dependency tail out of the bundle.
`goog.asserts`, `shaka.log` and `shaka.util.Error` become no-op or trivial
local declarations, exactly as the hls.js logger did in `cea608.ts`.

## Architecture

```
extract.ts ──┬─ cc_type 0/1 ──► CaptionTrack (608)  ──┐
             │                                        ├─► CaptionSource
             └─ cc_type 2/3 ──► Cea708Track          ─┘      │
                                (DTVCC → service →           │
                                 windows → PositionedCue)    ▼
                                                      CaptionOverlay
                                                      (window model)
```

### Extraction

`extract.ts` currently drops DTVCC at `if (type > 1) continue`. That becomes a
second output rather than a discard: `CcPair.field` gains `2 | 3`, or — better
for the consumers, since 608 and 708 never share a decoder — `extractCcData`
returns `{ cea608: CcPair[]; dtvcc: CcPair[] }`.

Both streams go through the **same PTS reorder buffer** the 608 path already
has. This is not optional: the throwaway probe written for this spec read the
elementary stream in decode order and produced
"Elotli h sadhownhe tm how to fd inlit ghin t dheareskns." DTVCC is a packet
protocol with sequence numbers, so out-of-order delivery corrupts packet
reassembly rather than merely transposing letters.

### `Cea708Track`

Mirrors `CaptionTrack`'s interface so the two are interchangeable:

```ts
export interface Cea708Track {
  add(seconds: number, pairs: readonly CcPair[]): void;
  drain(): PositionedCue[];
  flush(): PositionedCue[];
  /** True once service 1 has produced a cue — what selection turns on. */
  readonly seen: boolean;
  reset(): void;
}
```

### The cue, with position

```ts
export interface PositionedCue extends CaptionCue {
  /**
   * Where the broadcaster put this window, as percentages of the safe area.
   *
   * 708 anchors a window by one of nine points; the decoder resolves that to
   * a position and the renderer places it. Absent for a 608 cue, which has
   * only the bottom rows to work with.
   */
  region?: {
    anchor: CaptionAnchor;      // "bottom-left" ... "top-right"
    xPercent: number;
    yPercent: number;
    rows: number;
    columns: number;
  };
  /** Per-run styling, where the broadcaster set any. */
  style?: {
    foreground?: string;
    background?: string;
    italic?: boolean;
    underline?: boolean;
  };
}
```

`CaptionCue` stays as it is, so nothing on the 608 path changes and
`CaptionSource.at()` keeps its signature.

### Choosing between 608 and 708

Per stream, latching once and never oscillating:

- Both decoders run from the first picture. They cost a byte scan each.
- While `cea708.seen` is false, the overlay draws 608. This is the state every
  stream starts in and the state an uncaptioned-in-708 broadcast stays in.
- The first time service 1 produces a cue, 708 becomes the source and stays
  the source for that session.
- A seek resets both, as it does today; the latch survives, because a channel
  does not stop carrying 708 because the viewer skipped back.

Never the reverse. If 708 falls silent mid-programme the last 708 cue simply
expires and nothing is drawn, which is what a gap in captions looks like
anyway — switching back mid-sentence would interleave two decoders' idea of
the screen and produce text belonging to neither.

The CC button's rule is unchanged: it appears when *either* decoder has been
seen, so a 708-only broadcast still gets a button.

### Rendering

`CaptionOverlay` grows a window model. A cue with no `region` renders exactly
as today — bottom-centred, raised clear of the transport — which is both the
608 path and the fallback.

A cue with a `region` is placed against the **title-safe area**, not the
viewport: broadcast positions assume the 80% safe area a television shows, and
anchoring to the raw edges puts captions off-screen on an overscanned source.

Styling is applied from `style` where present, under a **readability floor**:

- A window fill the broadcaster marks transparent is drawn with the overlay's
  own solid background instead. Captions tuned for a living-room television
  are routinely unreadable over a bright browser page, and an unreadable
  caption is worse than a plainly-styled one.
- Foreground and background are used as sent otherwise. 708's palette is 64
  colours of 2 bits per channel, which maps directly to CSS.

The raised-for-the-transport behaviour applies to positioned cues too: a
window anchored near the bottom is lifted by the same rule, so captions never
land on the scrubber regardless of where the broadcaster put them.

## Testing

| Level | What it covers |
|---|---|
| `extract.ts` | DTVCC pairs are returned rather than dropped; 608 output is unchanged, asserted against the same fixture bytes as before |
| `dtvcc` | Packet reassembly across `cc_type` 3 then 2; a packet whose sequence jumps is discarded rather than mis-assembled |
| `Cea708Track` | Against the committed fixture: service 1 produces the known sentence, with a region whose horizontal anchors are 0 and 50 |
| Selection | 608 until 708 is seen; 708 thereafter; a silent 708 never switches back; the latch survives a seek |
| Overlay | A cue with a region is placed from it; one without renders bottom-centred; a transparent fill still draws a solid background |
| End to end | The existing real-bytes test gains a 708 assertion — same sentence, now with placement |

The 3-second fixture already contains everything these need: 57 DTVCC packets,
two `DefineWindow` calls with differing anchors, and a known sentence.

## Risks

| Risk | Handling |
|---|---|
| Closure-to-ESM conversion introduces a subtle behaviour change | Convert mechanically — module boundaries and annotations only, no logic edits — and pin the vendored version in the file header, as `cea608.ts` does |
| The `Cue` shim omits a field `cea708_window.js` sets | The compiler catches it: the shim is typed, and Shaka's window code assigns through it |
| A broadcaster positions a window off the safe area | Positions are clamped to the safe area before use |
| Two decoders double the per-picture scan cost | The scan is 0.32us per picture today; DTVCC adds a second pass over the same bytes already in cache |
| 708 turns out to carry nothing on some channel | That is the fallback's whole purpose, and it is the default state |

## Out of scope

- **Multiple simultaneous services.** Service 1 only, which is the only one
  these streams carry. The service number is already a parameter.
- **Caption appearance preferences** — a viewer override of broadcaster
  styling. Worth having once broadcaster styling is visible at all.
- **Captions in picture-in-picture**, unchanged from the 608 design.
- **The H.264 transcode path**, unchanged and still carrying the two defects
  recorded in the 608 design.
