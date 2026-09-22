# The Library as a list

**Date:** 2026-09-21
**Status:** approved, ready to plan
**Mockups:** https://claude.ai/artifact/DNgMAUTjYGfHYEHmfadNa3 (variant B)

## The problem

The Library draws one 280px card per recording. A card carries artwork, a
description, a coverage strip and nine controls, which is the right shape for
deciding *what to watch* and the wrong one for finding a known recording among
38 of them. Four cards fit a screenful on a laptop; the library is ten times
that after a busy week, and scrolling is the only way through it.

## The decision

A second layout for the same page: dense rows, chosen from the toolbar and
remembered, drawn from the same filtered and grouped data the cards use. Not a
new page, not a new route, not a different set of recordings.

Variant B of the mockups: **two lines with a frame**.

```
MONDAY 9/21 ─────────────────────────────────── 38 recordings · 106.9 GB free
[▭]  Saturday Night Live · Josh Brolin; Ariana Grande      [REC]        ⋮
     S49 E14 · ROAR 13.4 · 11:00 PM · 8m of 1h 0m
[▭]  NFL Football · New York Giants at Los Angeles Rams                 ⋮
     KTMFABC 23.1 · 6:15 PM · 3h 30m
```

Three rules decide everything below:

1. **Density is the point.** A row is ~58px against a card's ~360px. If a
   detail does not earn its line, it belongs in the sheet.
2. **The row plays.** Clicking anywhere but the `⋮` resumes, which is what
   clicking a card's artwork already does.
3. **`⋮` opens the sheet we already have.** `ShowInfo` holds Play, Delete,
   Keep and Series Information. The row duplicates none of them.

## Row anatomy

| Part | Content | Notes |
|---|---|---|
| Frame | 64×36, `cardArt(rec)` | Same resolution order and same `onError` fallback to `rec.thumbnail` as the card. `object-fill`, for the card's anamorphic reason. Placeholder wordmark when there is none. |
| Title line | `title`, `· subtitle`, badges | One line, truncated. Subtitle in `text-fg-secondary`, inline after a middot — not the card's accent-coloured second line, which at row density reads as a link. |
| Meta line | `S4 E14 · ROAR 13.4 · 11:00 PM · 1h 0m` | `text-[11px] text-fg-muted`, tabular numerals. Parts omitted when absent, never rendered empty. |
| Resume rail | 2px accent bar on the bottom edge | Width is `position / duration`. Absent when position is 0. Not the `CoverageStrip` — that is an interactive scrubber and needs room a row does not have. |
| `⋮` | Opens `ShowInfo` for this recording | Always visible, not hover-revealed: touch has no hover, and the sheet is the only way to everything else. |

### What the badges say

The card's vocabulary, shrunk to the title line, at most two at a time and in
this precedence:

- **REC** — `RecordingPill`, unchanged. Beats everything.
- **Incomplete** — `!isRecording && isIncomplete(coverageOf(rec))`. Warning
  colours, same inference the card makes from how little of the slot exists.
- **Kept / NN%** — `pinned`. Success colours when `cache_state === "complete"`,
  else the percentage.
- **Ready** — `cache_state === "complete"` without `pinned`.
- **Only here** — `offline_only`, `CloudOff` icon, no text.
- **New** — `position === 0 && !watched && !isRecording`.
- **Protected** — lock glyph, `text-warning`.

Watched rows drop to `text-fg-subtle` on both lines and take no Watched badge;
at this density the dimming says it and a badge would only cost width.

### What the row does not carry

Description, scan/interlace chips, transfer rate, download/pause/delete/keep
controls, the cover-frame undo, the coverage strip, and the hover watched and
protect toggles. All of them stay on the card and in the sheet. A row that
grows controls becomes a short card, which is the thing this exists to avoid.

## The switch

An icon pair — grid and rows — as a segmented control in the toolbar's
`data-layout-menus` cluster, after Group and Sort:

```
[Filter recordings…] [All ▾]            [Group ▾] [Sort ▾] [▦ | ≡]
```

Icons rather than a third `OptionMenu`: Group and Sort answer questions with
several answers each and need words, where this is one binary the icons state
outright, and a third pill of the same width would crowd a row that already
wraps at phone width. Each half is a real toggle button with
`aria-pressed`, so it reads correctly without sight of the icons.

Stored as **`library.layout`** with values `cards` (the default) and `list`,
through the existing `usePref` hook, which means a third entry in
`store.PREF_KEYS` server-side. It follows the viewer between machines, exactly
as grouping and sort now do, and for the same reason: it is how this person
reads the page, not a question they are asking today.

## Structure

`LibraryView.tsx` is 1442 lines and holds the card inline. The list does not
go in beside it.

- **`components/RecordingRow.tsx`** (new) — one row, given a recording and two
  callbacks (`onPlay`, `onInfo`). Nothing about grouping, filtering or
  fetching reaches it.
- **`lib/recording.ts`** — `isRecording`, `isPlayable`, `resumeFor` and
  `coverageOf` move here from `LibraryView`'s private scope. Two views now
  need the same answers, and these are rules, not rendering.
- **`lib/libraryLayout.ts`** — `LibraryLayout` type and the `LIBRARY_LAYOUTS`
  option list, beside `LIBRARY_GROUPS` and `LIBRARY_SORTS`.
- **`components/LayoutToggle.tsx`** (new) — the segmented pair. Small, and its
  own file because the toolbar is already the densest part of the view.
- **`LibraryView.tsx`** — reads the pref, and renders either the existing grid
  of cards or a list of `RecordingRow`s inside the same section loop. The
  headings, the storage line, the empty states and every mutation stay exactly
  where they are and serve both layouts.

Backend: one line in `store.PREF_KEYS`. No new route, no listing change.

## Testing

- `libraryLayout.test.ts` — `LIBRARY_LAYOUTS` ids match what the server
  accepts.
- `recordingRow.test.tsx` (new) — the row names the recording and its channel;
  the whole row plays while `⋮` opens the sheet instead; a recording in
  progress shows REC and its captured length, not the promised one; a kept
  copy says so; a part-watched recording draws the rail; a watched one dims.
- `layoutToggle.test.tsx` (new) — both halves are toggle buttons, the current
  one is pressed, clicking the other reports it once.
- `test_prefs.py` — `library.layout` accepts `cards` and `list` and refuses
  anything else.

## Non-goals

- The Series panel's episode list keeps its own row design. It is already
  rows, it answers a different question (what is in this series), and folding
  it into this preference would make one setting mean two things.
- No column sorting by clicking a header. Sort is a menu, and it stays one.
- No multi-select or bulk actions in rows. `SeriesDetail` has those for
  episodes; the Library has never had them, and adding them here is a separate
  decision.
- No density sub-setting. Two layouts, not a slider.

## Open questions, decided rather than left open

- **Touch**: `⋮` is always visible, so a row needs no hover to reach anything.
- **Keyboard**: the row is a `<button>`, so it is in the tab order and takes
  Enter and Space. The `⋮` is the next stop after it.
- **Phone width**: the meta line wraps to its own second line rather than
  truncating mid-fact, and the frame stays — 64px is affordable at 400px wide.
