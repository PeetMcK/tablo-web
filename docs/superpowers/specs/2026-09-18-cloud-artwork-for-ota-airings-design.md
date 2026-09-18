# Cloud artwork for OTA airings

Fill an OTA airing's empty artwork slot from the cloud row we have already
fetched for it.

A Sunday NFL game renders with the same league-wide NFL shield as every other
game, where the Tablo app shows the two teams' helmets. The artwork exists; we
throw it away once per sync.

## What each source knows

The device hangs artwork on the *sport*, not the event. `/guide/sports/events/77800`
(Vikings at Bears) carries `title`, `teams`, `venue`, `description` and
`tms_id`, and no image field at all. Its `sport_path` points at
`/guide/sports/38763` — "NFL Football" — whose three image ids are shared by
every NFL game the device knows about. Measured on Sunday 2026-09-20: all three
games returned byte-identical cover, thumbnail and background images.

The cloud carries per-event artwork. The same three games in
`/api/v2/account/{ctx}/guide/grid/?limit=50&day=2026-09-20`:

| Airing | `coverLarge` asset |
|---|---|
| Vikings at Bears | `GNLZZGG0039L2CP.jpg` |
| Jaguars at Broncos | `GNLZZGG0039L7DS.jpg` |
| Seahawks at Cardinals | `GNLZZGG0039L4VB.jpg` |

Distinct per matchup, and `coverLarge` for the Vikings game is the picture the
Tablo app renders. Only the `backdrop*` kinds are league-generic. Episodes get
the same treatment one level down: per-episode stills where the device offers
only a series cover.

## Why the mirror loses it

`_fetch_cloud_schedule` already fetches the grid for **all 28 channels**, OTA
included — it is 14 requests for the whole horizon, against 9,166 for the
device walk, so it is cheaper to take the whole grid than to filter it. Every
row goes through `_cloud_airing_row`, which resolves `images[]` into an
`image_url`.

Then `_assemble_grid_row` discards it:

```python
if not airings:                      # state.py:1570
    airings = list(cloud_schedule.get(c.identifier) or [])
```

The device wins per *channel*, whole-row. That rule is right about the fields
it was written for: device rows carry `airing_path`, `schedule_state` and
`skip_reason`, which are the recording handles the cloud has no equivalent
for, and a cloud row substituted for an OTA channel would silently break
scheduling. But artwork is not a handle. An OTA channel therefore keeps every
device field and loses the one field only the cloud has, so `guide_airing.image_url`
stays NULL for all 9,166 OTA airings.

## The change

Keep the device row. After the airings for a row are chosen, fill each airing's
**empty** `image_url` from the cloud airing on the same channel at the same
start.

Empty, not any: a device airing with artwork keeps it. This only ever turns a
NULL into a URL, so no existing sheet changes except the ones rendering
hero-less today.

### Match on epoch, not string

The two sources format the same instant differently — the device says
`2026-09-20T17:00Z`, the cloud says `2026-09-20T17:00:00Z`. A string compare
matches nothing. A helper normalises both to an integer epoch; anything it
cannot parse is skipped rather than guessed at, because a wrong match would put
one programme's picture on another's sheet.

### Nothing downstream changes

- `save_guide` already writes `image_url` (schema 4).
- `airing_detail` already prefers the airing's own artwork over the series
  cover (`store.py:842`), with a comment saying why: the airing's picture is
  about this episode.
- `ShowInfo.tsx` already renders `detail.image_url`.

So the value simply stops being NULL. No schema change, no new route, no
frontend change, and no additional request to either source.

### Kind preference is unchanged

`_CLOUD_IMAGE_KINDS` — `stillLarge`, `coverLarge`, `background`, `stillSmall`,
`coverSmall`, `poster` — already orders wide art ahead of the 2:3 poster, and
`coverLarge` is what a sportEvent carries. Unrecognised kinds stay ignored:
`backdropLarge` is league-generic, and promoting it would put the shield back
on sheets that now get helmets.

## Delivery

The CDN URL is stored as-is and the browser fetches it directly, which is what
OTT airings have always done. No proxy, no disk cache, no server-side fetch —
the browser already loads channel logos from that host.

## Testing

Unit tests over the merge helper, which is pure and needs no device:

- fills an art-less device airing from the cloud row at the same start
- never overwrites artwork a device airing already has
- matches across the two timestamp formats
- leaves the airing alone when the cloud has no row at that start, has a row
  with no artwork, or when either start is unparseable
- a channel with no device airings still falls back to the cloud row wholesale,
  as today

Then against the live device: run a sync and read `guide_airing` back for
2026-09-20, expecting three distinct CDN URLs on the three NFL games.

## Cost and risk

Zero new requests — the cloud rows are already in memory when the merge runs.
One dictionary per channel per assembly, discarded with the row.

The risk worth naming is a bad match putting the wrong picture on a sheet.
Start-epoch equality on the same channel is exact; an unparseable start on
either side skips rather than falls back to a near match.
