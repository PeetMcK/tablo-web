# Jumping the Guide to a Day and Time

One control that moves the guide to "Thursday evening", and one that brings it
back to now.

## Problem

The guide is a horizontal timeline and the only way along it is scrolling. An
hour column is 400px (`HOUR_WIDTH`), so at a typical window width about three
hours are on screen and **a single day is roughly seven screens wide**. The
guide holds several days.

There is no control of any kind: no date, no time, no way back. Scrolling out
to Thursday and then wanting tonight's listings again means dragging back
through three days of grid, with nothing on screen telling you how far you have
come or where "now" went.

A date picker alone does not fix this. Landing on a day puts the viewer at
midnight with six of those seven screens still to cross, and midnight is the
one hour nobody is looking for. The unit people ask in is neither the date nor
the hour: it is **"Thursday evening"**.

## Approach

A **day × daypart grid**. Rows are the days the guide holds; columns are four
stretches of a day — Morning, Afternoon, Prime, Late. Every cell is one jump to
a real hour on the timeline.

Reading down the Prime column answers "what is on in the evenings this week"
without scrolling. Reading across a row does the same for one day. The trigger
button names where the viewer currently is (`Thu · Prime`), so the control also
answers "where am I" — which nothing on screen does today.

Beside it, permanently, a **NOW** pill returns the grid to the live edge. Not
inside the popover: the way back must be reachable from wherever scrolling has
gone, without first opening something. It is styled in the same red as the
now-line it scrolls to, so the two read as one idea.

### The dayparts

| Column    | Starts | Why |
|-----------|--------|-----|
| Morning   | 6am    | The first hour anyone schedules against |
| Afternoon | 12pm   | |
| Prime     | 7pm    | |
| Late      | 11pm   | Where the late-night blocks begin |

Prime starts at **7pm, not 8pm**, because of how the jump lands: the target
hour is scrolled to the left edge, so the viewer reads forward from it. Landing
on 7pm puts the 8pm hour on screen with an hour of run-up; landing on 8pm hides
everything that started before it.

### Why not the alternatives

Five were drawn and compared as mockups before this one was chosen.

**A day rail** (Today / Wed / Thu pills). Reads instantly and needs no popover,
but it only picks the day — the seven screens of scrolling stay — and it runs
out of toolbar width at about five days.

**A date button with a calendar popover.** Scales to any range and is the
familiar gesture, but a calendar cannot express "evening", so it lands on
midnight and hands the rest back to the scrollbar.

**A day stepper** (`‹ Tue 9/15 ›`). The smallest control, and a long jump is
four clicks through days nobody wanted.

**A day strip fused into the timeline header.** Costs no toolbar width and
doubles as a map of where you are, but it adds a second header row to a grid
that is already dense, and still only addresses days.

**A jump menu of shortcuts** ("Tonight 8pm", "Tomorrow", "Thursday"). The
closest to the chosen design and its direct ancestor — rejected because the day
axis and the time axis sat in separate halves of one list, so "Thursday
evening" was not a single entry. Making them the two axes of a grid is the same
idea with the halves multiplied rather than stacked.

## What a cell knows

A cell is only worth offering if there is guide there and the grid can reach it.

- **Past** — the whole daypart ends before the grid's start. The timeline
  begins at the current hour and runs forward only, so nothing earlier can be
  scrolled to. Drawn dim and inert.
- **Empty** — inside the timeline, but no airing overlaps it. Common on the
  overnight end of FAST channels. Drawn as a dash, inert: jumping into blank
  grid looks like a broken control.
- **Live** — the daypart containing the current moment. Labelled NOW and
  accented.
- **Listed** — anything else. Labelled with the hour it lands on.

Coverage is read from the listings already in memory. The grid's own
`totalHours` is derived the same way, so the two cannot disagree about how far
the guide runs.

## Where "now" lands

The NOW pill scrolls to fifteen minutes *before* the current moment, not to the
moment itself. Landing exactly on now pins the red line to the left edge and
clips the programme in progress at its start — the one thing the viewer most
likely wants to see.

## Boundaries

Out of scope: scrolling backwards into airings that have already finished (the
grid starts at the current hour, which is a property of the grid, not of this
control), deep-linking a time in the URL, any change to what the guide fetches,
and the library's own date grouping.
