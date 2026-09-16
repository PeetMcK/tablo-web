# Prototypes

Working prototypes kept because the argument they settled is worth being able
to re-run, not just read. Each is a single self-contained HTML file: open it
in a browser, no server and no build.

They are snapshots. They embed real data captured when they were written and
they do not track the app — when the shipped behaviour and a prototype
disagree, the app is right and the prototype is a record of how it got there.

| File | Question it settled | Outcome |
|---|---|---|
| [`2026-09-16-guide-scroll-bench.html`](2026-09-16-guide-scroll-bench.html) | How does the guide move sideways for someone whose mouse has no horizontal wheel? | Drag the header, geared by the row you grab; listings drag one-to-one and lock to an axis. Chevron rails and wheel-over-clock were built, tried and rejected; the time scrollbar shipped first and was then withdrawn in favour of dragging. |

**Guide scroll bench** holds seven live grids on ten real channels and 327
real airings, including the options that lost — the losing ones are the point,
since the shipped gesture only makes sense against what it beat. The gesture
rules it produced live in `frontend/src/lib/drag.ts`, where the constants
carry their reasoning.
