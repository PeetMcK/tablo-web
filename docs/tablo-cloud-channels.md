# What is known about a channel

Every field the Tablo cloud returns from
`GET /api/v2/account/{lighthouse_token}/guide/channels/`, every field the
device returns from `GET /guide/channels/{object_id}`, and a full dump of all
23 OTA channels from both.

Includes the fields we do not currently keep, which is most of them.

Measured 2026-09-17 against one live account: **28 channels in the cloud - 23
OTA and 5 OTT - and 23 on the device**, which knows nothing about the OTT
five. Where a claim is about this account rather than about the API, it says
so. Counts are evidence, not specification.

**Related:** `docs/tablo-api.md` covers the device API in general. This
document is only about channels, and about where the two sources disagree.

---

## The schema

Every channel carries four top-level keys, then exactly one of `ota` or `ott`.

| Field | Present | Type | Notes |
|---|---|---|---|
| `identifier` | 28/28 | string | `S{tms_station_id}_{major:03}_{minor:02}`. The join key to the device, which calls it `channel_identifier`. |
| `name` | 28/28 | string | The only human-readable station name in any source. **We discard this.** |
| `kind` | 28/28 | `"ota"` \| `"ott"` | Decides which block below is present. |
| `logos` | 28/28 | array | Three entries, or empty. See *Logos*. |
| `ota` | 23/28 | object | Broadcast channels. |
| `ott` | 5/28 | object | Streaming/FAST channels. |

### `ota` — 23 channels

| Field | Type | Example |
|---|---|---|
| `major` | int | `11` |
| `minor` | int | `2` |
| `callSign` | string | `KUFMDT2` |
| `network` | string | `HD06` — see *The `network` trap* |

Four fields, and that is all. No resolution, no scan type, no favourite flag:
the union of every key across all 28 records had nothing about any of them.
Those come from the device only, which is why `channel_details` exists.

### `ott` — 5 channels

The same four fields, plus four more:

| Field | Type | Example | Kept? |
|---|---|---|---|
| `major` | int | `501` | yes |
| `minor` | int | `6` | yes |
| `callSign` | string | `PAC12NETWORK` | yes |
| `network` | string | `PAC12NETWORK` | yes |
| `streamUrl` | string | an Amagi HLS playlist, below | **no** |
| `provider` | string | `AMAGI` (5 of 5) | **no** |
| `canRecord` | bool | `true` (5 of 5) | **no** |
| `channelPartner` | string | `pac-12-enterprises` | **no** |

`streamUrl` is a direct HLS playlist with an ad-macro query string, most of
it unfilled:

```
https://cdn-uw2-prod.tsv2.amagi.tv/linear/amg00384-pac12network-pac12-tablo/playlist.m3u8
  ?iu=/6088/tablo/pac-12/livestream&app_bundle=com.tablotv.app&app_name=tablotv
  &us_privacy=1NNN&coppa=0&width=1920&height=1080&did=REPLACE_ME&…
```

Two of the five carry `app_bundle=com.tablotv.app` and `width/height=1920/1080`;
the other three leave those as `REPLACE_ME` too. The app is expected to
substitute them.

### Logos

Three entries per channel, always the same three kinds:

| `kind` | Example URL |
|---|---|
| `darkLarge` | `…/media/PBS_black.png` |
| `lightLarge` | `…/media/PBS_white.png` |
| `originalLarge` | `…/media/PBS_modified.png` |

All on `lighthousetv-cdn.ewscloud.com`. We prefer `originalLarge`, falling
back to `lightLarge`, then anything (`state.py:508`).

**Three channels have an empty `logos` array** — 8.2, 11.5 and 23.3, which are
exactly the three whose `network` is `INDEPENDENT`. Those fall back to the
antenna mark.

---

## Which logos actually resolve

All 75 cloud logo URLs were fetched, 2026-09-17. **72 return 200; three
return 404**, and they are all one channel.

| Channel | Cloud logos | Device logos | Obtainable? |
|---|---|---|---|
| 7.4 KIDS | 3 URLs, **all 404** | the same 3 URLs | no |
| 8.2 | empty | empty | no |
| 11.5 | empty | empty | no |
| 23.3 | empty | empty | no |
| everything else | 3, all 200 | usually empty | yes |

So **4 of 23 OTA channels have no obtainable logo**, by two different
mechanisms that look identical in the UI:

- **8.2, 11.5 and 23.3** carry an empty `logos` array in both sources. These
  are exactly the three whose `network` is `INDEPENDENT`, so the placeholder
  network and the missing artwork are one gap in the upstream data, not two
  problems.
- **7.4 KIDS** advertises `KIDS_black.png`, `KIDS_white.png` and
  `KIDS_modified.png` from *both* the cloud and the device, and all three are
  404 on the CDN. A logo that is listed but absent is worse than one that is
  absent, because nothing upstream reports it as missing - it simply fails to
  load, which is why `ChannelLogo` falls back on `onError` and not only on a
  null URL.

None of this is fixable by merging sources: the artwork does not exist
upstream. The antenna mark is the correct answer for all four.

### The device's URLs are not always the cloud's

`13.5 TheNest` is the only channel where they differ:

```
cloud   …/prod/media/thenestblack.png
device  …/prod/media/uploads/channels/thenestblack.png
```

Both resolve, so it costs nothing today. It matters because it means the two
sources are not guaranteed to name the same file, and a merge cannot assume
they do.

The device carries logos for only **5 of 23** channels - 7.4, 8.1, 11.1, 13.1
and 13.5 - and none of them covers a gap. Four of those five are byte-identical
URLs to the cloud's.

---

## The `network` trap

`network` is not reliably a network name. On this account it is a real
affiliation for the majors (`CBS`, `NBC`, `ABC`, `FOX`, `PBS`) and a
placeholder elsewhere:

- `HD06` on 11.2, which is PBS Kids
- `INDEPENDENT` on 8.2, 11.5 and 23.3
- `LOCALFAST` on 7.99, which is KPAX Live News

It is often, but **not always**, the stem of the logo filename: identical on
17 of the 25 channels that have logos, and different on the other 8 — 7.99's
logo is `KPAXblack.png` against a network of `LOCALFAST`.

### `name` is not simply better

Swapping `network` for `name` trades one set of wrong answers for another.
`name` gives the **call sign** for the major affiliates:

| Channel | `network` | `name` | Which reads better |
|---|---|---|---|
| 8.1 | `CBS` | `KPAX` | network |
| 13.1 | `NBC` | `KECI` | network |
| 23.1 | `ABC` | `KTMF` | network |
| 23.2 | `FOX` | `KTMF` | network |
| 11.2 | `HD06` | `PBS Kids` | name |
| 8.2 | `INDEPENDENT` | `KPAX` | name |
| 11.5 | `INDEPENDENT` | `KUFM` | name |
| 23.3 | `INDEPENDENT` | `KTMF` | name |
| 7.99 | `LOCALFAST` | `KPAX Live News` | name |

The two agree on 16 of 28. Of the 12 that differ, `network` wins 4 and `name`
wins 8 — three of those merely cosmetic (`SCRIPPSNEWS` → `Scripps News`,
`FUBOTV` → `Fubo`, `PAC12NETWORK` → `Pac 12 Network`).

So neither field alone is right. What works on this lineup is `network`
unless it is a placeholder, then `name` — where the placeholder set is
`INDEPENDENT`, `LOCALFAST` and `HD\d+`. That list is an observation of 28
channels, not a documented rule, and needs a graceful fallback when `name` is
absent too.

---

## Where the two sources differ

The device and the cloud describe the same channel differently. 11.2:

| | Device | Cloud |
|---|---|---|
| call sign | `KUFM-K` | `KUFMDT2` |
| name | `KUFM-K` | `PBS Kids` |
| network | `HD06` | `HD06` |
| logos | `[]` | 3 URLs |
| resolution | `sd` + `interlaced` flag | absent |
| favourite | `false` | absent |

We store the cloud's call sign. Neither is wrong — they are different
registrations of the same transmitter — but a UI showing one and a log showing
the other will look like a bug.

**The device carries no logo for some channels** (`logos: []` on 11.2), which
is why the cloud is merged in as a fallback rather than used only for OTT.

---

## What we keep, and what we drop

**Two separate functions fetch this same endpoint**, and both discard most of
it.

`TabloClient.channels()` (`tablo_api/client.py:46`, a vendored dependency) is
what `state.channels()` calls, and it is where the Live card's badge
ultimately comes from. It maps each record onto a six-field `TabloChannel`:

```python
call_sign = (info and info.callSign) or ch.name or ch.identifier
network   = (info and info.network) or ""     # <- the badge
```

Note `ch.name` is already read there, as the *second* fallback for the call
sign - so the field we want is parsed and then dropped one line above where it
would be useful. `TabloChannel` carries only `identifier`, `call_sign`,
`major`, `minor`, `network`, `kind`, and is the funnel everything else passes
through. It lives in `site-packages`, so widening it is not ours to do freely.

`_fetch_cloud_channels` (`state.py:484`) fetches the same URL again and reads
**`identifier` and `logos`**, returning `(logo_map, identifiers)`.

Dropped by both, currently recoverable only by re-fetching:

- `name` - the only readable station name anywhere
- `ott.streamUrl`, `ott.provider`, `ott.canRecord`, `ott.channelPartner`
- `logos[].kind` other than the one chosen

This is why adding `name` is not simply a column: it has to come in through
`_fetch_cloud_channels`, which already holds the raw record, rather than
through the vendored model.

Note `_CLOUD_IMAGE_KINDS` and the cloud artwork path at `state.py:547` are
**dead for this account**: 800 cloud airings carried zero images.

---

## The device's channel record

For contrast, since the two are joined on `channel_identifier`.
`GET /guide/channels/{object_id}` returns fourteen fields, all present on all
23 OTA channels:

| Field | Example | Notes |
|---|---|---|
| `call_sign` | `KSPS-HD` | often differs from the cloud's |
| `name` | `KSPS-HD` | the call sign again, never a station name |
| `call_sign_src` | `KSPS-HD` | identical to `call_sign` on all 23 |
| `major` / `minor` | `7` / `1` | |
| `network` | `PBS` | same value as the cloud's on all 23 |
| `flags` | `["mpeg2","interlaced","canRecord"]` | two sets only: 18 interlaced, 5 not |
| `resolution` | `hd_1080` | `sd` (14), `hd_720` (5), `hd_1080` (4) |
| `favourite` | `false` | |
| `tms_station_id` | `79600` | the numeric core of `identifier` |
| `tms_affiliate_id` | `11039` | usually a number; the literal string `Independent` on 8.2, 11.5, 23.3; empty on 7.4 and 13.5 |
| `channel_identifier` | `S79600_007_01` | the join to the cloud |
| `source` | `ota` | `ota` on all 23 |
| `logos` | `[]` | **empty on 18 of 23** |

`resolution` and `flags` are what `_channel_extras` turns into `scan` and
`interlaced`. Neither exists in the cloud record at all.

**The device has logos for only 5 of 23 channels**, which is why the cloud's
are merged in as the primary source rather than a fallback.

---

## Every channel on this account, at a glance

| Ch | `identifier` | `name` | `kind` | `callSign` | `network` | logos |
|---|---|---|---|---|---|---|
| 7.1 | `S79600_007_01` | PBS | ota | K32EUD1 | PBS | 3 |
| 7.2 | `S84522_007_02` | WORLD | ota | K08PRD2 | WORLD | 3 |
| 7.3 | `S84523_007_03` | Create | ota | K08PRD3 | CREATE | 3 |
| 7.4 | `S999006535_007_04` | KIDS | ota | KIDS | KIDS | 3 |
| 7.99 | `S999025627_007_99` | KPAX Live News | ott | KPAXFAST | LOCALFAST | 3 |
| 8.1 | `S34654_008_01` | KPAX | ota | KPAXDT1 | CBS | 3 |
| 8.2 | `S52647_008_02` | KPAX | ota | KPAXDT2 | INDEPENDENT | 0 |
| 8.3 | `S102027_008_03` | Grit | ota | KPAXDT3 | GRIT | 3 |
| 8.4 | `S109970_008_04` | Ion | ota | KPAXDT4 | ION | 3 |
| 8.5 | `S125355_008_05` | COURT | ota | KPAXDT5 | COURT | 3 |
| 8.6 | `S125348_008_06` | BUSTED | ota | KPAXDT6 | BUSTED | 3 |
| 11.1 | `S35314_011_01` | PBS | ota | KUFMDT1 | PBS | 3 |
| 11.2 | `S61261_011_02` | PBS Kids | ota | KUFMDT2 | HD06 | 3 |
| 11.3 | `S62448_011_03` | Create | ota | KUFMDT3 | CREATE | 3 |
| 11.4 | `S64473_011_04` | WORLD | ota | KUFMDT4 | WORLD | 3 |
| 11.5 | `S66208_011_05` | KUFM | ota | KUFMDT5 | INDEPENDENT | 0 |
| 13.1 | `S35298_013_01` | KECI | ota | KECIDT1 | NBC | 3 |
| 13.2 | `S72217_013_02` | Comet | ota | KECIDT2 | COMET | 3 |
| 13.3 | `S87461_013_03` | CHARGE | ota | K14IUD3 | CHARGE | 3 |
| 13.4 | `S118560_013_04` | ROARTV | ota | KECIDT4 | ROARTV | 3 |
| 13.5 | `S999055912_013_05` | THENEST | ota | THENEST | THENEST | 3 |
| 23.1 | `S54511_023_01` | KTMF | ota | KTMFDT1 | ABC | 3 |
| 23.2 | `S64586_023_02` | KTMF | ota | KTMFDT2 | FOX | 3 |
| 23.3 | `S99504_023_03` | KTMF | ota | KTMFDT3 | INDEPENDENT | 0 |
| 500.1 | `S120010_500_01` | Scripps News | ott | SCRIPPSNEWS | SCRIPPSNEWS | 3 |
| 501.5 | `S121984_501_05` | Fubo | ott | FUBOTV | FUBOTV | 3 |
| 501.6 | `S999002483_501_06` | Pac 12 Network | ott | PAC12NETWORK | PAC12NETWORK | 3 |
| 528.1 | `S999058775_528_01` | MST3K | ott | MST3K | MST3K | 3 |

---

## Every OTA channel, in full

Both sources, joined on `channel_identifier`. All 23.

### 7.1 — PBS

```
identifier          S79600_007_01
device path         /guide/channels/5802  (object_id 5802)

CLOUD
  name              'PBS'
  kind              'ota'
  ota.callSign      'K32EUD1'
  ota.network       'PBS'
  ota.major/minor   7.1
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_modified.png

DEVICE
  call_sign         'KSPS-HD'
  name              'KSPS-HD'
  call_sign_src     'KSPS-HD'
  network           'PBS'
  resolution        'hd_1080'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '79600'
  tms_affiliate_id  '11039'
  source            'ota'
  logos             0
    (none)
```

### 7.2 — WORLD

```
identifier          S84522_007_02
device path         /guide/channels/5803  (object_id 5803)

CLOUD
  name              'WORLD'
  kind              'ota'
  ota.callSign      'K08PRD2'
  ota.network       'WORLD'
  ota.major/minor   7.2
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/WORLD_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/WORLD_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/WORLD_modified.png

DEVICE
  call_sign         'KSPSWo'
  name              'KSPSWo'
  call_sign_src     'KSPSWo'
  network           'WORLD'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '84522'
  tms_affiliate_id  '56725'
  source            'ota'
  logos             0
    (none)
```

### 7.3 — Create

```
identifier          S84523_007_03
device path         /guide/channels/5804  (object_id 5804)

CLOUD
  name              'Create'
  kind              'ota'
  ota.callSign      'K08PRD3'
  ota.network       'CREATE'
  ota.major/minor   7.3
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CREATE_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CREATE_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CREATE_modified.png

DEVICE
  call_sign         'KSPSCr'
  name              'KSPSCr'
  call_sign_src     'KSPSCr'
  network           'CREATE'
  resolution        'hd_720'
  flags             ['mpeg2', 'canRecord']
  favourite         False
  tms_station_id    '84523'
  tms_affiliate_id  '48990'
  source            'ota'
  logos             0
    (none)
```

### 7.4 — KIDS

```
identifier          S999006535_007_04
device path         /guide/channels/84235  (object_id 84235)

CLOUD
  name              'KIDS'
  kind              'ota'
  ota.callSign      'KIDS'
  ota.network       'KIDS'
  ota.major/minor   7.4
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/KIDS_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/KIDS_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/KIDS_modified.png

DEVICE
  call_sign         'KIDS'
  name              'KIDS'
  call_sign_src     'KIDS'
  network           'KIDS'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '999006535'
  tms_affiliate_id  ''
  source            'ota'
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/KIDS_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/KIDS_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/KIDS_modified.png
```

### 8.1 — KPAX

```
identifier          S34654_008_01
device path         /guide/channels/116  (object_id 116)

CLOUD
  name              'KPAX'
  kind              'ota'
  ota.callSign      'KPAXDT1'
  ota.network       'CBS'
  ota.major/minor   8.1
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CBS_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CBS_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CBS_modified.png

DEVICE
  call_sign         'KPAX'
  name              'KPAX'
  call_sign_src     'KPAX'
  network           'CBS'
  resolution        'hd_1080'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '34654'
  tms_affiliate_id  '10098'
  source            'ota'
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CBS_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CBS_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CBS_modified.png
```

### 8.2 — KPAX

```
identifier          S52647_008_02
device path         /guide/channels/117  (object_id 117)

CLOUD
  name              'KPAX'
  kind              'ota'
  ota.callSign      'KPAXDT2'
  ota.network       'INDEPENDENT'
  ota.major/minor   8.2
  logos             0
    (none)

DEVICE
  call_sign         'MTN'
  name              'MTN'
  call_sign_src     'MTN'
  network           'KPAXDT'
  resolution        'hd_720'
  flags             ['mpeg2', 'canRecord']
  favourite         False
  tms_station_id    '52647'
  tms_affiliate_id  'Independent'
  source            'ota'
  logos             0
    (none)
```

### 8.3 — Grit

```
identifier          S102027_008_03
device path         /guide/channels/118  (object_id 118)

CLOUD
  name              'Grit'
  kind              'ota'
  ota.callSign      'KPAXDT3'
  ota.network       'GRIT'
  ota.major/minor   8.3
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/GRIT_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/GRIT_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/GRIT_modified.png

DEVICE
  call_sign         'GRIT-TV'
  name              'GRIT-TV'
  call_sign_src     'GRIT-TV'
  network           'GRIT'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '102027'
  tms_affiliate_id  '89922'
  source            'ota'
  logos             0
    (none)
```

### 8.4 — Ion

```
identifier          S109970_008_04
device path         /guide/channels/119  (object_id 119)

CLOUD
  name              'Ion'
  kind              'ota'
  ota.callSign      'KPAXDT4'
  ota.network       'ION'
  ota.major/minor   8.4
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/ION_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/ION_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/ION_modified.png

DEVICE
  call_sign         'IONTV'
  name              'IONTV'
  call_sign_src     'IONTV'
  network           'ION'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '109970'
  tms_affiliate_id  '18633'
  source            'ota'
  logos             0
    (none)
```

### 8.5 — COURT

```
identifier          S125355_008_05
device path         /guide/channels/120  (object_id 120)

CLOUD
  name              'COURT'
  kind              'ota'
  ota.callSign      'KPAXDT5'
  ota.network       'COURT'
  ota.major/minor   8.5
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/COURT_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/COURT_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/COURT_modified.png

DEVICE
  call_sign         'CourtTV'
  name              'CourtTV'
  call_sign_src     'CourtTV'
  network           'COURT'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '125355'
  tms_affiliate_id  '111043'
  source            'ota'
  logos             0
    (none)
```

### 8.6 — BUSTED

```
identifier          S125348_008_06
device path         /guide/channels/121  (object_id 121)

CLOUD
  name              'BUSTED'
  kind              'ota'
  ota.callSign      'KPAXDT6'
  ota.network       'BUSTED'
  ota.major/minor   8.6
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/bustedblack.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/bustedwhite.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/bustedoriginal.png

DEVICE
  call_sign         'BUSTED'
  name              'BUSTED'
  call_sign_src     'BUSTED'
  network           'BUSTED'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '125348'
  tms_affiliate_id  '175331'
  source            'ota'
  logos             0
    (none)
```

### 11.1 — PBS

```
identifier          S35314_011_01
device path         /guide/channels/5806  (object_id 5806)

CLOUD
  name              'PBS'
  kind              'ota'
  ota.callSign      'KUFMDT1'
  ota.network       'PBS'
  ota.major/minor   11.1
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_modified.png

DEVICE
  call_sign         'PBS'
  name              'PBS'
  call_sign_src     'KUFM-HD'
  network           'PBS'
  resolution        'hd_1080'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '35314'
  tms_affiliate_id  '11039'
  source            'ota'
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/PBS_modified.png
```

### 11.2 — PBS Kids

```
identifier          S61261_011_02
device path         /guide/channels/5807  (object_id 5807)

CLOUD
  name              'PBS Kids'
  kind              'ota'
  ota.callSign      'KUFMDT2'
  ota.network       'HD06'
  ota.major/minor   11.2
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/HD06_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/HD06_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/HD06_modified.png

DEVICE
  call_sign         'KUFM-K'
  name              'KUFM-K'
  call_sign_src     'KUFM-K'
  network           'HD06'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '61261'
  tms_affiliate_id  '101364'
  source            'ota'
  logos             0
    (none)
```

### 11.3 — Create

```
identifier          S62448_011_03
device path         /guide/channels/5808  (object_id 5808)

CLOUD
  name              'Create'
  kind              'ota'
  ota.callSign      'KUFMDT3'
  ota.network       'CREATE'
  ota.major/minor   11.3
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CREATE_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CREATE_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CREATE_modified.png

DEVICE
  call_sign         'KUFM-C'
  name              'KUFM-C'
  call_sign_src     'KUFM-C'
  network           'CREATE'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '62448'
  tms_affiliate_id  '48990'
  source            'ota'
  logos             0
    (none)
```

### 11.4 — WORLD

```
identifier          S64473_011_04
device path         /guide/channels/5809  (object_id 5809)

CLOUD
  name              'WORLD'
  kind              'ota'
  ota.callSign      'KUFMDT4'
  ota.network       'WORLD'
  ota.major/minor   11.4
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/WORLD_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/WORLD_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/WORLD_modified.png

DEVICE
  call_sign         'KUFM-W'
  name              'KUFM-W'
  call_sign_src     'KUFM-W'
  network           'WORLD'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '64473'
  tms_affiliate_id  '56725'
  source            'ota'
  logos             0
    (none)
```

### 11.5 — KUFM

```
identifier          S66208_011_05
device path         /guide/channels/5810  (object_id 5810)

CLOUD
  name              'KUFM'
  kind              'ota'
  ota.callSign      'KUFMDT5'
  ota.network       'INDEPENDENT'
  ota.major/minor   11.5
  logos             0
    (none)

DEVICE
  call_sign         'KUFM-L'
  name              'KUFM-L'
  call_sign_src     'KUFM-L'
  network           'KUFMDT'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '66208'
  tms_affiliate_id  'Independent'
  source            'ota'
  logos             0
    (none)
```

### 13.1 — KECI

```
identifier          S35298_013_01
device path         /guide/channels/5811  (object_id 5811)

CLOUD
  name              'KECI'
  kind              'ota'
  ota.callSign      'KECIDT1'
  ota.network       'NBC'
  ota.major/minor   13.1
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/NBC_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/NBC_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/NBC_modified.png

DEVICE
  call_sign         'KECI'
  name              'KECI'
  call_sign_src     'KECI'
  network           'NBC'
  resolution        'hd_1080'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '35298'
  tms_affiliate_id  '10991'
  source            'ota'
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/NBC_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/NBC_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/NBC_modified.png
```

### 13.2 — Comet

```
identifier          S72217_013_02
device path         /guide/channels/5812  (object_id 5812)

CLOUD
  name              'Comet'
  kind              'ota'
  ota.callSign      'KECIDT2'
  ota.network       'COMET'
  ota.major/minor   13.2
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/COMET_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/COMET_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/COMET_modified.png

DEVICE
  call_sign         'Comet'
  name              'Comet'
  call_sign_src     'Comet'
  network           'COMET'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '72217'
  tms_affiliate_id  '97051'
  source            'ota'
  logos             0
    (none)
```

### 13.3 — CHARGE

```
identifier          S87461_013_03
device path         /guide/channels/5813  (object_id 5813)

CLOUD
  name              'CHARGE'
  kind              'ota'
  ota.callSign      'K14IUD3'
  ota.network       'CHARGE'
  ota.major/minor   13.3
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CHARGE_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CHARGE_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/CHARGE_modified.png

DEVICE
  call_sign         'Charge'
  name              'Charge'
  call_sign_src     'Charge'
  network           'CHARGE'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '87461'
  tms_affiliate_id  '102148'
  source            'ota'
  logos             0
    (none)
```

### 13.4 — ROARTV

```
identifier          S118560_013_04
device path         /guide/channels/5814  (object_id 5814)

CLOUD
  name              'ROARTV'
  kind              'ota'
  ota.callSign      'KECIDT4'
  ota.network       'ROARTV'
  ota.major/minor   13.4
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/roarblack.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/roarwhite.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/roaroriginal.png

DEVICE
  call_sign         'ROAR'
  name              'ROAR'
  call_sign_src     'ROAR'
  network           'ROARTV'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '118560'
  tms_affiliate_id  '102116'
  source            'ota'
  logos             0
    (none)
```

### 13.5 — THENEST

```
identifier          S999055912_013_05
device path         /guide/channels/5815  (object_id 5815)

CLOUD
  name              'THENEST'
  kind              'ota'
  ota.callSign      'THENEST'
  ota.network       'THENEST'
  ota.major/minor   13.5
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/thenestblack.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/thenestwhite.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/thenestoriginal.png

DEVICE
  call_sign         'TheNest'
  name              'TheNest'
  call_sign_src     'TheNest'
  network           'THENEST'
  resolution        'sd'
  flags             ['mpeg2', 'interlaced', 'canRecord']
  favourite         False
  tms_station_id    '999055912'
  tms_affiliate_id  ''
  source            'ota'
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/thenestblack.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/thenestwhite.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/uploads/channels/thenestoriginal.png
```

### 23.1 — KTMF

```
identifier          S54511_023_01
device path         /guide/channels/5816  (object_id 5816)

CLOUD
  name              'KTMF'
  kind              'ota'
  ota.callSign      'KTMFDT1'
  ota.network       'ABC'
  ota.major/minor   23.1
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/ABC_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/ABC_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/ABC_modified.png

DEVICE
  call_sign         'KTMFABC'
  name              'KTMFABC'
  call_sign_src     'KTMFABC'
  network           'ABC'
  resolution        'hd_720'
  flags             ['mpeg2', 'canRecord']
  favourite         False
  tms_station_id    '54511'
  tms_affiliate_id  '10003'
  source            'ota'
  logos             0
    (none)
```

### 23.2 — KTMF

```
identifier          S64586_023_02
device path         /guide/channels/5817  (object_id 5817)

CLOUD
  name              'KTMF'
  kind              'ota'
  ota.callSign      'KTMFDT2'
  ota.network       'FOX'
  ota.major/minor   23.2
  logos             3
    darkLarge      https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/FOX_black.png
    lightLarge     https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/FOX_white.png
    originalLarge  https://lighthousetv-cdn.ewscloud.com/lighthousetv/prod/media/FOX_modified.png

DEVICE
  call_sign         'KTMFFOX'
  name              'KTMFFOX'
  call_sign_src     'KTMFFOX'
  network           'FOX'
  resolution        'hd_720'
  flags             ['mpeg2', 'canRecord']
  favourite         False
  tms_station_id    '64586'
  tms_affiliate_id  '10212'
  source            'ota'
  logos             0
    (none)
```

### 23.3 — KTMF

```
identifier          S99504_023_03
device path         /guide/channels/5818  (object_id 5818)

CLOUD
  name              'KTMF'
  kind              'ota'
  ota.callSign      'KTMFDT3'
  ota.network       'INDEPENDENT'
  ota.major/minor   23.3
  logos             0
    (none)

DEVICE
  call_sign         'KTMFSWX'
  name              'KTMFSWX'
  call_sign_src     'KTMFSWX'
  network           'KTMFDT'
  resolution        'hd_720'
  flags             ['mpeg2', 'canRecord']
  favourite         False
  tms_station_id    '99504'
  tms_affiliate_id  'Independent'
  source            'ota'
  logos             0
    (none)
```


---

## Reproducing this

```python
host, headers = state._cloud_headers()
r = await state._http.get(
    f"{host}/api/v2/account/{state.active_device.lighthouse_token}/guide/channels/",
    headers=headers, timeout=25)
channels = r.json()
```

One request, no pagination, ~28 records. See `docs/tablo-api.md` for the
device-side equivalent and the auth both use.
