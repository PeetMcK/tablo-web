# One box, two jobs: filter and search

**Date:** 2026-09-22
**Status:** approved, ready to plan

## The problem

The Library draws two text boxes, one above the other, forty pixels apart.
The topbar's says "Search programs, channels…" behind a spyglass. The
Library's own says "Filter recordings…" behind a funnel. They look alike,
they sit together, and the only thing telling them apart is a glyph most
people will not read as a distinction.

The glyphs are right — a funnel narrows what is here, a spyglass goes and
finds what is not — but being right in the abstract does not help anyone
standing in front of two boxes wondering which one they want. Typing in the
wrong one is silent: the Library filter hides recordings, the topbar search
opens a dropdown over them, and neither says "you wanted the other one."

## The decision

One box, in the topbar, with a two-way switch in its left cap. Spyglass on
the left, funnel on the right, the selection remembered and starting on the
funnel. Filter narrows the page you are on. Search does what it does today.
The Library's own filter box is deleted.

The spyglass leads because it is the half that was already there: the box
has worn a spyglass in that exact spot since it was only a search, and a
switch that moved the familiar glyph to make room for the new one would
charge everyone a relearn for a feature half of them did not ask for. The
funnel is the default *selection* even so — narrowing the page is the more
common errand — so the pair opens with its right half lit.

The switch is **strict**: the mode decides the behaviour, and nothing leaks
across.

| | Filter | Search |
|---|---|---|
| Dropdown | never | ≥2 chars, off the search tab |
| Enter | inert | opens the results tab |
| The list below | narrows | untouched |

Strict costs something real. Today the topbar's text filters the Live list
locally *and* opens the dropdown, and Search mode gives that up. It is worth
it: a control whose two positions both do some filtering is a control whose
positions do not mean anything.

## What "filter" means on each tab

| Tab | Filter narrows | Notes |
|---|---|---|
| Live | channels | call sign, network, display name, current program — the predicate `ChannelGrid` already has |
| Library | recordings | the predicate `LibraryView` already has |
| Series | series cards | new: title match |
| Guide | — | funnel greyed; see below |
| Search | — | funnel greyed; the page below *is* the search |

On Guide and Search the funnel half is disabled and the control reads as
Search while you are there. The stored mode is not touched, so leaving the
tab puts Filter back. A disabled half rather than a hidden one: the control
should be the same shape on every tab, or its position in the row moves as
you navigate.

Guide gets a filter later, and a better one than "channels whose *current*
program matches" — that is a coincidence of what happens to be on at this
minute. The useful version narrows the grid to channels with a match
*anywhere in the visible window*, which needs the airings the grid already
fetches rather than the `current_program` field Live uses. Out of scope here.

## State

One text value, one mode, both in `localStorage`, both global.

| Key | Value |
|---|---|
| `tablo:topbar.query` | the text, shared by both modes |
| `tablo:topbar.mode` | `filter` \| `search`, default `filter` |

One value, not two, so flipping the switch reinterprets what is already
typed rather than swapping in something you typed a while ago and forgot.
Reinterpreting is the point of the switch.

Global rather than per tab, because the text is what the viewer is looking
for right now and that does not change when they check whether it is in the
Library instead of Live.

`tablo:library.filter` — today's Library key — is read once as a seed and
deleted, the same one-shot migration `lib/resume.ts` already does for its
legacy key. Someone mid-session keeps their filter; nobody is left with a
dead key holding a value nothing reads.

A `#/search?q=…` deep link still wins over the stored text. The link is a
statement about what this page should show; the stored value is a guess
about what the viewer was last doing.

### The stale-filter hazard, acknowledged

Filter is sticky, the text is sticky, the box is now one row further from
the list it narrows. So: open the app, land on Library, find recordings
missing, and the only thing saying why is a small funnel in the topbar.

`LibraryView` already carries a comment about exactly this ("a filter left
behind an icon is a library missing recordings for no reason anyone can
see"), and moving the box up-bar makes the tell weaker rather than stronger.
Accepted deliberately: the cure — clearing the text on load, or on tab
change — throws away the thing the viewer asked us to remember. The clear
button stays, and the field keeps its text visible at every width above a
phone.

## The control

The field's left cap stops being one decorative `<Search>` and becomes two
buttons in a `role="radiogroup"`, spyglass then funnel — the spyglass stays
where the single icon always was, and the funnel joins it. Selected takes the
accent token; the other stays `text-fg-muted`. A glyph shows state, not the
act — so the accessible names are the modes ("Filter this page", "Search
everything"), and the tooltip carries the act.

Placeholder and `aria-label` follow mode *and* tab, because "Filter
recordings…" on the Live tab would be a lie:

- Filter → `Filter channels…` / `Filter recordings…` / `Filter series…`
- Search → `Search programs, channels…`

Collapsed to an icon on a phone, the button wears the **selected mode's**
glyph and names that mode. The icon is the state; tapping it still expands
the field rather than toggling the mode, which is what it does today.

## Plumbing

`ChannelGrid` already owns `filter` and hands it to `SearchResultsView`. It
gains `mode`, and hands `query` down to two components that take no props
today:

- `LibraryView` — gains `query`, loses its box, its `filterExpanded` phone
  collapse, its `filterInputRef` and its `useStoredText` call. The toolbar
  keeps the content filter, Group, Sort and the layout toggle.
- `RecordingsView` — gains `query`, filters series cards by title.

Both take `query` as the already-resolved string: `ChannelGrid` passes the
text in Filter mode and `""` in Search mode, so neither component has to
know the mode exists.

## Testing

New `__tests__/topbarMode.test.tsx`:

- mode and text both survive a remount
- Filter mode: no dropdown at any length, list narrows
- Search mode: dropdown at ≥2 chars, Live list *not* narrowed
- flipping the switch reinterprets the text in place
- Guide and Search disable the funnel, and leaving restores Filter
- the placeholder tracks mode and tab

`libraryFilterMemory.test.tsx` repoints at the topbar box and gains a case
for the `tablo:library.filter` migration.

`pageChrome.test.tsx` updates its `Search programs, channels` label queries,
which now only hold in Search mode.

## Not in this change

- Guide's schedule-text channel filter (above)
- Any change to what search returns, or to the results page
- Per-tab filter text
