# Show information

Capture the programme metadata the device already holds, and show it when a
guide cell is clicked.

The Tablo app opens a sheet on any programme: poster, episode title, season and
episode number, rating, description, and actions. We have none of it. The guide
stores six fields per airing and discards the rest of a record it has already
paid to fetch.

This covers capture and display. Recording management lands on top later; the
device's write API is mapped in `docs/tablo-device-api.md` and the fields it
needs are captured here so that work needs no migration and no re-sync.

## What the device gives us

An airing (`/guide/series/episodes/{id}`) carries an `episode` object with
`title`, `number`, `season_number`, `orig_air_date`, plus a `schedule` block and
a `series_path`. `_build_grid_enrichment` already fetches these records in full
and keeps six fields.

A series (`/guide/series/{id}`) carries `series_rating`, `genres`, `cast`,
`episode_runtime`, and three image ids — `cover_image`, `thumbnail_image`,
`background_image` — fetchable through `/images/{id}`.

Measured on a real guide: 8,752 airings at ~1.1 KB each, ~1,100 distinct series
at ~1.0 KB, 2.9 images per series at ~15 KB. Metadata is ~11 MB; artwork is
~48 MB and dominates.

## Capture

### Airing fields are free

The extra airing fields cost **zero additional requests** — they are in the
response `_build_grid_enrichment` already parses. Widening that mapping and the
`guide_airing` table is the whole change.

Captured now, displayed now: `episode_title`, `season_number`,
`episode_number`, `orig_air_date`.

Captured now, unused until recording management: `airing_path`,
`schedule_state`, `schedule_qualifier`, `skip_reason`. `airing_path` is the
PATCH target, so capturing it is what lets the later work skip a migration.

### Series fetches belong to the background sync, not the interactive path

Series records are new requests. A cold interactive guide load touches ~1,000
airings spanning ~350 distinct series, and adding 350 round trips to a load a
user is waiting on is the wrong trade.

`guide_sync.run_forever` already exists for exactly this kind of work: it runs
at startup and every `TABLO_GUIDE_SYNC_HOURS` (default 6) at a deliberately low
concurrency so it does not starve playback. Series capture becomes a step there,
after the guide is saved.

Only uncached or stale series are fetched, so the first run costs ~1,100
requests and later runs cost only what is new. A series is stale after 30 days —
ratings and artwork effectively never change.

### Artwork: prefetch what is imminent, fetch the rest on demand

Eagerly fetching 3,190 images to show a handful is waste; fetching every image
on demand makes the first open of every sheet wait on the device.

- **Prefetch** after each sync: cover images for series airing in the next 12
  hours that are not already cached. That is the window a viewer actually
  browses, and it is a few dozen images.
- **On demand** otherwise: a sheet requests its image, the backend serves it
  from cache or fetches and writes through.

Images live on disk under `$TABLO_DATA_DIR/cache/guide-images/{image_id}.jpg`,
not as BLOBs. The database stays small and backups stay quick; a lost image
re-fetches, which a lost row does not.

## Schema (version 3)

`guide_airing` gains: `episode_title`, `season_number`, `episode_number`,
`orig_air_date`, `series_path`, `airing_path`, `schedule_state`,
`schedule_qualifier`, `skip_reason`.

All nullable. Existing rows keep working with nulls, and backfill happens
naturally as syncs run — no migration backfill step.

New `guide_series`:

```
path                TEXT PRIMARY KEY      -- /guide/series/6408
identifier          TEXT
title               TEXT
description         TEXT
genres              TEXT                  -- JSON array
rating              TEXT                  -- series_rating, e.g. "tvy"
orig_air_date       TEXT
episode_runtime     INTEGER
cast                TEXT                  -- JSON array
cover_image_id      INTEGER
thumbnail_image_id  INTEGER
background_image_id INTEGER
schedule_rule       TEXT                  -- captured, unexposed
keep_rule           TEXT                  -- captured, unexposed
keep_count          INTEGER               -- captured, unexposed
updated_at          TEXT NOT NULL
```

Keyed on `path` because that is what an airing carries and what the later PATCH
targets. Upserted, never deleted — same reasoning as `guide_channel`.

`guide_airing.series_path` is deliberately **not** a foreign key. Airings are
captured before their series is fetched, and a constraint would make the order
matter.

## Reading

`GET /api/channels/airing-detail?channel={identifier}&start={iso}`

Keyed on the `guide_airing` primary key, which is what the grid already holds —
no new identifier plumbed through the frontend.

Returns the airing joined to its series and channel, plus `image_url` (or null)
and `airing_now`, computed server-side from start and duration so the client is
not deciding it from a clock that may differ.

Served entirely from the mirror. The device is never touched on this path: the
sheet opens on a click and must not wait on a round trip.

`GET /api/guide/image/{image_id}` serves the cached artwork, fetching on miss.

## The sheet

A modal, opened by clicking a programme cell.

**This changes what a cell does.** Today a cell tunes. After this it opens
information, and the channel tile is the way to tune — which is why the tile
became a real button in `827d61f`, before this landed rather than alongside it.

Contents, following the Tablo app's ordering because it is familiar and it
front-loads identity:

- Hero image (cover art), hidden entirely when absent rather than showing a
  placeholder — a large empty box reads as broken
- Channel, time range, date
- Title, then episode title
- Description
- Meta row: `S{n} E{n} · network · channel · duration · rating`, each part
  omitted when null. A guide with no EPG data yields a sheet that is mostly
  title and channel, which is honest.
- **Tune to Channel**, shown only while the programme is airing

Every field can be null. The layout is built so that a sheet with nothing but a
title still looks deliberate.

Reuses `ConfirmDialog`'s modal conventions — scrim, `z-[60]`, Escape to close,
focus return — rather than inventing a second dialog idiom.

## Testing

**Capture.** The airing mapping keeps episode fields; a series round-trips
through `guide_series`; a second sync updates rather than duplicating; an airing
whose series has not been fetched yet still stores and reads.

**Sync.** Series capture fetches only uncached or stale paths. A series fetch
failing does not fail the sync — the guide is the point, artwork is not.

**Endpoint.** Returns the joined shape; unknown channel/start is a 404;
`airing_now` is true only inside the window; a series with no artwork returns
`image_url: null`.

**Images.** A cached image is served without touching the device; a miss
fetches and writes through; a device failure is a 404 rather than a 500.

**Frontend.** The sheet renders a fully-populated airing; renders a bare one
without empty rows; shows Tune only while airing; a cell click opens it; Escape
closes and returns focus.

## Deliberately excluded

**Recording actions.** The write API is mapped and the fields are captured, but
scheduling is its own design. The enumerations for `schedule.rule`, `keep.rule`
and `offsets.source` are still unconfirmed.

**Cast, awards, background and thumbnail images.** Stored where free, not
displayed. Adding them later is a template change, not a capture change.

**Search over the new fields.** `search_doc` already indexes title, subtitle and
description. Indexing episode titles is a natural follow-up and is not needed to
make the sheet work.

**Image eviction.** ~48 MB at the ceiling, against a 250 GB transcode cache.
Revisit if it ever matters.
