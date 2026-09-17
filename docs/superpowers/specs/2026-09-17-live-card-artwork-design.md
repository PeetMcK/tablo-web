# Artwork on the Live card — design

**Date:** 2026-09-17
**Status:** agreed, not built
**Scope:** the Live tab's `ChannelCard`. Guide and Library are explicitly out —
see *Scope* below.

## The problem

The Live tab is 28 cards of text. Every one is a logo, a number, a title and
two lines of synopsis, and they are scanned by station colour because that is
the only non-text thing on them. The device has artwork for most of what is
airing and we fetch none of it.

A second problem, found while looking at the first: the card is two targets.
The tile plays, the body opens the info sheet, and the tile's logo crossfades
to a play triangle on its own hover. It is a lot of mechanism for "watch this"
and "tell me about this", and it makes the tile's contents load-bearing.

## What was decided

Four decisions, in the order they were made:

1. **The artwork is the series poster, in the tile the logo occupies now.**
   Not a banner above the card, not a background behind it.
2. **Where there is no poster, the tile shows the channel logo** — the current
   behaviour becomes the empty state rather than being replaced.
3. **Channel identity moves to the text under the tile** (`7.1 PBS`), which is
   already there.
4. **One hover over the whole card: the card dims and Play and Info appear
   side by side on top of it.** The two-target split, the logo→triangle
   crossfade and the quieted-synopsis treatment all go.

### Why the poster and not the cover

Three treatments were built and compared (artifact:
`claude.ai/code/artifact/9828f20e-8ab5-48ff-ac22-3da710eec563`).

The alternative was a 16:9 cover behind a variable "window" at the top of the
card, sized so the height the grid hands a card becomes picture instead of dead
space. It works, and it solved a real problem — Live cards are *growers*, and a
row stretches every card to its tallest member — but it costs a card-geometry
change, an aspect-ratio decision, and arithmetic that breaks at the edges of
the width range (the card grows as `width ÷ 1.5` while the picture grows as
`width × 0.5625`, so a wide column overruns the picture and shows bare plate).

The poster tile needs none of that. It is a change of `src` and
`aspect-ratio` in a slot that already exists. It is also a tenth the weight:

| variant | size | dimensions | `has_title` |
|---|---|---|---|
| `thumbnail_image` | 13–19 KB | 240×360 | true (8 of 8) |
| `cover_image` | 150–340 KB | 1920×1080 | true (8 of 8) |
| `background_image` | 150–340 KB | 1920×1080 | false (7 of 8) |

`background_image` is ruled out on composition, not size: Good Morning
America's is half empty navy with the presenters against the right edge. Its
*cover* is fine — that distinction was got wrong once during this work and is
recorded here so it is not got wrong again.

The poster is cropped to 1:1 by dropping its bottom third
(`object-position: 50% 0%`), which keeps the title and the faces.

## What the device gives us

Measured today, not assumed.

**An airing record has no artwork.** Thirty airings sampled across the full
8,354-entry list: every one carried `airing_details`, `episode`, `schedule`,
`season_path` and `series_path`, and **none carried a `series` object**.
Artwork is reached only by resolving `series_path`.

This also means `state.py:846` — `a.get("series", {}).get("description")` — is
dead code on this device. Descriptions come from `episode`. Worth deleting
while nearby; it is not what this change is for.

**There is no batch endpoint on this generation** (`docs/tablo-api.md:133`), so
resolving series paths against the device would be one signed round trip per
channel. We do not need to: the guide mirror already holds them.

**The mirror already stores what we need.** `guide_series` carries
`thumbnail_image_id`, populated by the existing guide sync, and
`store.load_series(path)` already reads it — `airing_detail` uses exactly this
route to put a cover on the info sheet.

**Coverage, measured against the live mirror:**

| | count | share |
|---|---|---|
| mirrored airings | 10,655 | |
| …with a `series_path` | 9,054 | 85% |
| …resolving to a thumbnail | 8,747 | 82% of all, 96.6% of those with a path |

So **about one card in five falls back to the channel logo**. That is not a
defect to engineer around; it is why decision 2 exists. The gap is mostly
movies and sports, which are separate record types (`/guide/movies/{id}`,
`/guide/sports/{id}`) with their own artwork — a later improvement, not part
of this.

**The image route already exists.** `GET /api/channels/image/{image_id}`
(`channels.py:158`) serves device images through the `guide_images` cache with
a week of cache-control. Nothing new is needed on the serving side.

## The design

### Backend

`get_guide_data` and `stream_guide_data` build each channel's `current_program`
from a device airing record (`state.py:844`, `state.py:958`). That record's
`series_path` is currently discarded. Keep it, resolve it against the mirror,
and put the resulting image id on the programme:

```python
"poster_image_id": <thumbnail_image_id or None>,
```

On `Program`, not on the channel: it describes what is airing, and it changes
when the programme does. A null means "no poster", which the card reads as
"show the logo".

The lookup is a mirror read, so it costs no device traffic. It must not fail
the guide: a missing series row, or a series with no thumbnail, yields `None`.

The NDJSON streaming path must carry the same field, or the Live tab will show
posters on a warm cache and logos on a cold one — the kind of difference that
gets reported as flicker and debugged as a caching bug.

### The card

The tile becomes:

```
poster_image_id ? <img src="/api/channels/image/{id}" 1:1, object-position 50% 0%>
                : <ChannelLogo …>            ← today's plate, unchanged
```

Both sit on `bg-logo-plate`, which is already dark in both themes as of
`01006b5`, so a poster and a logo occupy an identical square and a row of
mixed cards does not look ragged.

Under it, unchanged: `7.1 PBS`, then the scan badge.

### The hover

**The whole card dims, and Play and Info sit side by side on top of it**,
centred. One scrim over the entire card — poster, text, bar and all — not a
panel over part of it and not a treatment applied per element.

This is the simplification the rest of the change is for. It removes:
`group/tile` and `group/body`, the logo's opacity crossfade, the triangle that
replaced it, the synopsis's contrast drop, and the two separate press states.
Every one of those exists to make two adjacent targets legible while keeping
both readable underneath. With one scrim there is nothing to disambiguate and
nothing that needs to stay readable — the card is saying "pick one of these
two", and the content behind it is context, not something to be read at that
moment.

It also fixes something the current design fights. The old treatment had to
keep the logo identifiable while turning it into a play button, which is why
it dims rather than swaps and why there is a comment explaining that a
station's mark is mostly colour. A scrim over everything has no such
obligation: the poster carries the identity while dimmed, and it comes back
the instant the pointer leaves.

The dim must be dark in both themes for the same reason the plate is
(`01006b5`): the tile behind it is dark, and a light scrim over a dark plate
inverts the relationship between the card and its own artwork.

**Keyboard and touch are not hover.** The buttons must be real, focusable
controls that are reachable without a pointer — the overlay may be
hover-revealed visually, but the controls cannot be hover-*created*. Touch
devices get no hover at all, so the overlay needs to be visible on tap or the
controls need to be permanently present at coarse-pointer widths.

## Scope

**Live only.** The guide grid's tile is a different component with different
constraints (28 columns of 48px plates, artwork competing with the time axis
the grid exists to show), and the Library already has its own artwork. Doing
Live first also means the fallback rate gets observed on real data before the
same decision is made anywhere else.

The `bg-logo-plate` fix in `01006b5` already touched both callers, so the guide
tile is consistent with this work without being changed by it.

## What this does not do

- No movie or sport artwork, so the ~18% fallback stays at ~18% for now.
- No change to Guide or Library.
- No card geometry change: the card stays a grower, rows still stretch to
  their tallest member. The window treatment that would have fixed that is
  recorded in the artifact and deliberately not built.

## Risks

**A row of posters may be louder than a row of logos.** Six cards on a review
page flatter any treatment; 28 in a scrolling column is the real test, and it
has not been run. If it reads as noise, the fallback is to keep the poster and
drop its saturation, not to abandon the tile.

**Mixed rows.** With one card in five showing a logo, a column alternates
between photographic tiles and flat marks. The shared dark plate is what keeps
that from looking broken, and it is the thing to check first if it does.
