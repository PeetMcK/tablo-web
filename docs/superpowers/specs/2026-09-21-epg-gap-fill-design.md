# Filling a blank channel from a listings feed — design

**Date:** 2026-09-21
**Status:** approved, not implemented
**Touches:** new `backend/app/epg_feed.py`, new `backend/app/routes/epg.py`,
new `frontend/src/components/EpgFillSheet.tsx`, `backend/app/db.py`,
`backend/app/store.py`, `frontend/src/components/GuideGridView.tsx`,
`frontend/src/components/SettingsModal.tsx`, `frontend/src/components/ShowInfo.tsx`

## The symptom

Two OTA channels in the lineup have no listings at all, and never will from
the device. `docs/channel-identity-sources.md` measured it on 2026-09-17:
**7.4 KIDS** and **13.5 THENEST**, both carrying a synthetic `S999…`
identifier, both with **0 airings**, and the correlation with the synthetic
prefix is exact. They render as empty tracks in the grid.

That document also established that the blankness is a *mapping* gap in
Tablo's guide rather than absent data — 7.4 is a real Gracenote station with
48 scheduled programmes, simply not in the Missoula lineup. 13.5 was left
"Unresolved".

It is resolvable. IPTV-EPG publishes a free US feed that carries The Nest,
and the listings are correct.

## What the feed is

Measured 2026-09-21 against `https://iptv-epg.org/files/epg-us.xml.gz`:

| | |
|---|---|
| Compressed download | **55.6 MB**, 2.3s |
| Decompressed | 519 MB, streamed in 0.2s |
| Full `iterparse` sweep | **8.0s** |
| Contents | **12,995 channels**, **1,147,636 programmes**, ~6 days forward |
| Per-channel layout | programmes are **contiguous** — 0 interleaved blocks |
| Caching | 302 to a tokenised path, `cache-control: no-cache`, **no ETag, no Last-Modified** |

No conditional GET is possible, so every refresh is a full 56 MB pull. At ten
seconds and 56 MB that is cheap enough that avoiding re-downloads is not a
design concern; what to *keep* is.

The `.xml` variant is the same content at 519 MB. There is no reason to fetch
it.

## The clock defect, and why it is not what it first looked like

The Nest's listings in this feed do not line up with what is on the screen.
At 2026-09-21 18:41 MT the feed's `TheNest.us` claimed *Dog the Bounty
Hunter*; the channel was showing *Hoarders*. Reading the stamps as US Eastern
rather than the `+0000` they declare puts *Hoarders* S05E03 at 20:00–21:00 ET,
which matches.

The tempting conclusion — that the feed's declared offset is wrong
everywhere — is false, and the file disproves it. Programmes whose titles
name their own local hour are self-calibrating: `KPIX+KPYX.us` (San
Francisco) carries "CBS News Bay Area: Morning Edition 7am" stamped `14:00Z`
and "Prime Edition 8pm" stamped `03:00Z`. Both are exactly right for PDT.

Swept across the whole file, **26,542 self-calibrating titles** imply these
dominant offsets:

```
+4h  248 channels   (EDT)        +5h  168 channels   (CDT)
+7h  111 channels   (PDT)        +6h   45 channels   (MDT)
```

Those are the correct US offsets. **The feed's `+0000` is honest UTC for the
bulk of it; `TheNest.us` is an outlier.** The correction therefore belongs to
a mapping, not to the parser, and its default must be zero.

### A fixed shift would break on a dated schedule

The Nest is a diginet: one national feed on an Eastern clock, relayed
unshifted, so a programme at 20:00 ET reaches Mountain viewers at 18:00 MT.
Its stamps are Eastern *wall clock* mislabelled UTC. Today that is +4h. On
**2026-11-01**, when EDT becomes EST, it becomes +5h, and a mapping storing
"+240 minutes" slides every listing by an hour with nothing to report it.

So a mapping stores a correction in one of two modes. `fixed` shifts by a
constant, for a feed that is simply wrong by one. `tz` declares that the
stamps are wall clock in a named zone, which survives DST. For The Nest the
`tz` reading is the true one.

## Scope

Filled listings are **shown, not recorded**. A recording is scheduled against
the device's own `airing_path`, and an imported airing has none — the device
does not know the programme exists. The device does advertise a
`manual_programs_edit` capability and an empty `/guide/programs` collection
(`docs/tablo-api.md`), so time-based recording may be reachable later; it is
not part of this work.

A mapping may only be created on a channel that is **blank**: present in the
latest sync, with zero `guide_airing` rows at `end_epoch >= now`. The device
is authoritative wherever it says anything at all.

## What we keep

One pass per refresh writes three things, and the 56 MB download is deleted
afterwards.

**Every channel's identity**, 12,995 rows, for the picker.

**A bounded 36-hour sample of every channel** — roughly 290k rows, the feed
averaging 191k programmes a day. This is what makes the picker answer in SQL
instead of re-reading half a gigabyte, and it is what lets candidates be
searched **by programme title** — the only match
the identity document found reliable, since IPTV-EPG's channel *names* are
not trustworthy (`PBSKidsWestSoCal.us` carries *Midsomer Murders*).

**The full ~6-day run of mapped channels only**, roughly 200 rows each, written
as real `guide_airing` rows.

Two alternatives were rejected. Keeping the file and seeking per channel is
viable — contiguity measured at 0 breaks — but trades a SQL preview for gzip
restart-point bookkeeping to save disk we have, and gives no title search.
Mirroring all 1.15M programmes costs ~250 MB and a million-row daily rewrite
against a WAL database that is concurrently serving HLS segments, to answer
questions about two channels.

## Ingest

`backend/app/epg_feed.py`, built to the discipline `guide_sync.py` documents:
every database call through `asyncio.to_thread`, each step guarded
independently, nothing escaping to kill the loop, one audit row per run.

It follows the 302, streams `gzip` into `ET.iterparse`, and clears each
element — the document is never held. The 8s parse is CPU on the process that
also serves segments, so it runs in a thread and commits in batches rather
than one transaction.

**The first download is lazy.** No background traffic is earned until there is
something to fill: the first fetch happens when the picker is opened, and the
daily refresh (`TABLO_EPG_REFRESH_HOURS`, default 24) runs only while a
mapping exists.

## Schema, version 10

```sql
-- The feed's channel list. 12,995 rows, rebuilt each refresh.
CREATE TABLE epg_source_channel (
    feed_id       TEXT PRIMARY KEY,   -- "TheNest.us"
    display_name  TEXT,               -- "US - The Nest" — NOT a matching key
    icon_url      TEXT,
    airing_count  INTEGER NOT NULL DEFAULT 0,
    refreshed_at  TEXT NOT NULL
);

-- A bounded window of every channel, so the picker can preview a candidate
-- without re-reading 519 MB. Deliberately not the whole feed: 1.15M
-- programmes to answer questions about two channels.
CREATE TABLE epg_source_sample (
    feed_id      TEXT NOT NULL,
    start_epoch  INTEGER NOT NULL,    -- as stamped; no correction applied
    stop_epoch   INTEGER NOT NULL,
    title        TEXT,
    subtitle     TEXT,
    PRIMARY KEY (feed_id, start_epoch)
);
CREATE INDEX epg_sample_title ON epg_source_sample(title);

-- Which feed channel fills which blank channel, and how its clock is wrong.
-- Per-mapping because the defect is per-channel: measured over 26,542
-- self-calibrating titles, the feed's +0000 is honest UTC for the bulk of
-- it, while TheNest.us runs 4h fast. Default: trust the feed.
--
-- 'fixed' shifts by offset_minutes. 'tz' reads the stamps as wall clock in
-- offset_tz, which is what survives 2026-11-01 — see the clock section.
CREATE TABLE epg_mapping (
    channel_id      TEXT PRIMARY KEY REFERENCES guide_channel(identifier) ON DELETE CASCADE,
    feed_id         TEXT NOT NULL,
    offset_mode     TEXT NOT NULL DEFAULT 'fixed',
    offset_minutes  INTEGER NOT NULL DEFAULT 0,
    offset_tz       TEXT,
    created_at      TEXT NOT NULL,
    last_filled_at  TEXT,
    airings_filled  INTEGER NOT NULL DEFAULT 0,
    retired_at      TEXT,
    retired_reason  TEXT
);

-- Provenance. Null means the device said it, which is every row written
-- before this migration.
ALTER TABLE guide_airing ADD COLUMN source TEXT;

CREATE TABLE epg_refresh (            -- audit, sibling of guide_sync
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    channels    INTEGER NOT NULL DEFAULT 0,
    programmes  INTEGER NOT NULL DEFAULT 0,
    filled      INTEGER NOT NULL DEFAULT 0,
    ok          INTEGER NOT NULL DEFAULT 0,
    error       TEXT
);
```

`source` lives on `guide_airing` rather than in a parallel table because an
imported row has to land where every reader already looks — the grid, the
search index, and the info sheet all read `guide_airing`. A second table would
mean teaching each of them about two sources.

## Filling

The fill reads the mapped channel's full run from the parse, not the 36-hour
sample; the sample is for previewing.

`start` is the feed's start with the mapping's correction applied, written in
the same ISO text `store` already uses so the `(channel_id, start)` primary key
collides correctly. `duration` is `stop − start`.

This feed's `<episode-num>` is `"S05 E03"` with an **empty `system`
attribute** — not `xmltv_ns` — so it needs its own parse into
`season_number` / `episode_number`. The `<desc>` repeats the same code as a
`"S05 E03 — "` prefix, which is stripped. `<category>` becomes `genres`.

`kind` is left **null on purpose**: that makes imported rows visible to
`enrich.py`, which walks untagged titles, so TMDb movie tagging applies to
filled listings without any new code. `index_airing` is called exactly as the
device path calls it, so Everything Search finds *Hoarders* on 13.5.

### The device always wins

1. A mapping can only be created on a blank channel.
2. Any guide sync that delivers device airings for a mapped channel deletes
   that channel's imported rows and **retires** the mapping with a reason —
   retired rather than silently removed, so the disappearance is explicable.
3. A refresh re-fills only `end_epoch >= now`. Past imported rows are kept,
   matching the append-only rule `save_guide` documents.

One deliberate exception to rule 3: **changing a mapping's correction deletes
all of that channel's imported rows, past included, and refills.** Keeping
mis-timed history would preserve a record of programmes airing at times they
did not.

### What an imported airing cannot do

No `airing_path`, so no recording. No `series_path`, so no series sheet. No
`image_url`, so no artwork. `ShowInfo` carries a provenance line — *"Listing
from IPTV-EPG, not your Tablo — can't be recorded"* — and the record control
is absent rather than present-but-dead.

## The picker

Entry is from the blank row itself, where the problem is visible. The empty
track in `GuideGridView` gains one affordance — *"No listings · fill from a
listings feed"* — and about ten lines to mount `EpgFillSheet.tsx`. The sheet
is its own component; the 1144-line grid does not grow further.

The sheet, in order:

1. On first open with no feed yet, *"Fetching listings feed (56 MB)…"*, about
   ten seconds.
2. Search by channel name **and by programme title**, results labelled with
   which matched. Title search is the reliable one.
3. Candidates show name, icon, airing count, and what the sample says is on
   now.
4. Selecting one previews on-now plus the next five, under the question that
   does the real work: **"Does this match what's on 13.5 right now?"** That
   comparison is what caught the clock defect in the first place; the UI makes
   it the confirmation step rather than an afterthought.
5. A correction stepper, −12h to +12h in 30-minute steps, default 0,
   re-rendering the preview from the same sample rows — no refetch, so
   calibration is instant. When it lands on a whole-hour US offset the sheet
   offers the durable reading: *"+4h matches US Eastern — treat these times as
   Eastern wall clock so it stays right through DST?"*
6. Confirm writes the mapping and fills; the row populates behind the sheet.

An already-mapped channel opens the same sheet in a different state:
*"Filled from TheNest.us, US Eastern · recalibrate · change channel · remove"*.

Settings gets a compact read-only block: last refresh, feed channel count,
active mappings, retired ones with their reason. Management lives in the
sheet, where the evidence is.

The grid marks provenance on the row header only. A badge on every cell of a
row whose every cell shares one source is noise.

**Out of scope:** playing the channel inside the picker so the stream and the
listing can be compared side by side. Tempting, and a second feature.

## API

```
GET    /api/epg/status                    last refresh, channel count, mappings
POST   /api/epg/refresh                   force one now
GET    /api/epg/blanks                    channels with no listings
GET    /api/epg/channels?q=&by=name|title candidate feed channels
GET    /api/epg/preview/{feed_id}?...     on-now + next N, correction applied
PUT    /api/epg/mapping/{channel_id}      {feed_id, offset_*} → fills
DELETE /api/epg/mapping/{channel_id}      unmap, delete its imported airings
```

A new router rather than more of `settings.py`, which is 304 lines and is
about the device.

## Testing

Backend tests follow `test_guide_sync.py`'s injected-fetch style — no network.
The parser is tested against a small fixture cut from the real file, including
the empty-`system` `"S05 E03"`, the duplicated desc prefix, and multiple
`<category>` elements.

The regression that matters most is dated: a `tz` mapping must give +4h in
September and **+5h in December**. Pin it.

The rest: mapping a channel that has future airings is a 409; a sync
delivering device airings retires the mapping and deletes its rows, with the
reason recorded; two fills produce the same row count; recalibration deletes
past imported rows while a plain refresh does not; an imported airing is
findable in search and leaves both `search_doc` and `search_fts` on unmapping;
`prune_guide` treats imported rows identically; and an HTTP failure, a
truncated gzip, or malformed XML mid-stream each produce an `ok=0` audit row
with the previous listings intact and nothing escaping the loop.

## Failure modes

| | |
|---|---|
| Feed unreachable, or the Cloudflare path changes | Refresh fails; already-filled rows stay. Degrades to stale, never to blank. |
| A mapping's `feed_id` disappears from the feed | Mark the mapping stale, surface it in settings, keep existing rows. |
| 8s parse on the segment-serving process | Thread plus batched commits. Measured, not assumed. |
| Disk | 56 MB temp deleted after parsing; the 290k-row sample is rebuilt, not accumulated. |

## Open question, to settle first

**Are the feed's channel ids stable across days?** Everything here binds a
mapping to `TheNest.us` as a durable key, and that has been verified against
exactly one day's file. The first implementation task is to download the feed
again and diff the id set against 2026-09-21's. If ids churn, a stored
`feed_id` is the wrong key and the mapping needs a content-based re-bind —
which is a design change, not a bug fix.
