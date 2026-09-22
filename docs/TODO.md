# TODO

Work that is designed or decided but not yet built. A spec here means the
design is settled; it does not mean an implementation plan exists.

## Fill a blank channel from a listings feed

**Spec:** `docs/superpowers/specs/2026-09-21-epg-gap-fill-design.md` (approved)
**Plan:** not written
**Branch:** `worktree-epg-gap-fill`

13.5 THENEST and 7.4 KIDS carry a synthetic `S999…` identifier and zero
airings, and the device will never list them. IPTV-EPG's free US feed has The
Nest. Point a blank channel at a feed channel, confirm the match against
what's actually on screen, and fill the grid — show-only, since an imported
airing has no `airing_path` for the device to schedule against.

Next step is the implementation plan. It starts at the schema V10 migration;
the one open question the spec carried (are feed channel ids durable?) was
answered yes on 2026-09-21, so nothing blocks it.
