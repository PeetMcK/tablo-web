# The cloud's channel record

Everything `GET /api/v2/account/{lighthouse_token}/guide/channels/` returns,
including the fields we do not currently keep.

Measured 2026-09-17 against one live account: **28 channels, 23 OTA and 5 OTT.**
Where a claim here is about this account rather than about the API, it says so.
Counts are evidence, not specification.

**Related:** `docs/tablo-api.md` covers the device API, which is a different
service on a different host with a different channel record. The two disagree
on some fields - see *Where the two sources differ*.

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

`_fetch_cloud_channels` (`state.py:484`) reads **`identifier` and `logos`**
and returns `(logo_map, identifiers)`. Everything else on the record is parsed
and discarded.

Dropped entirely, currently recoverable only by re-fetching:

- `name` — the only readable station name anywhere
- `ott.streamUrl`, `ott.provider`, `ott.canRecord`, `ott.channelPartner`
- `logos[].kind` other than the one chosen

Note `_CLOUD_IMAGE_KINDS` and the cloud artwork path at `state.py:547` are
**dead for this account**: 800 cloud airings carried zero images.

---

## Every channel on this account

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
