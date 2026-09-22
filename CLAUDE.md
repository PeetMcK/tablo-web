# tablo-web

## Where the data lives

`~/Library/Application Support/tablo-web` — config, `tablo.db`, the secret key,
and the transcode cache. `backend/run-native.sh` documents the environment
variables that move it.

**Never search the home directory for it.** A recursive glob over `~` — `~/**`,
`find ~`, or the same thing through a tool — walks every `node_modules`,
`Library` and iCloud tree on this machine and does not finish: one such search
for `tablo*.db` burned 9.7 hours of CPU at 99% before it was killed. The path
above is the answer, and it has not moved.

## Running the app

Use the `tablo-stack` skill. The stack is a **native macOS backend** on
`127.0.0.1:8000` plus a **containerized frontend** on `127.0.0.1:7070`, and a
bare `docker compose up` silently serves the app from a *different* backend
with a different database — nothing in the UI says so. The skill has the
commands, the failure mode, and `check-stack.sh`, which is what "it works"
means here.

Frontend changes are baked into the image at build time: rebuild and
`--force-recreate`, or the container keeps serving the previous build. Backend
changes need the host process restarted; it does not reload.

## Conventions worth knowing

- **Colour comes from tokens** in `frontend/src/index.css`, never a literal hex
  and never a `dark:` variant. Tokens that are translucent by nature (`fill`,
  `border`, `scrim`) must not take a Tailwind opacity modifier: `/60` does not
  scale their alpha, it **replaces** it, which is how `bg-fill/60` became a
  white slab in dark mode. Reach for the `-soft` / `-strong` sibling instead.
- **A glyph shows state, not the act.** A closed lock means protected; an open
  eye means watched. The act belongs in the accessible name and the tooltip.
- **Comments carry the why**, including the measurement that settled it. This
  codebase is written that way throughout; match it rather than stripping it.
