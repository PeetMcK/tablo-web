# Where channel identity and artwork can come from

Measured 2026-09-17 against one live account in the Missoula MT market: 28
channels, 23 OTA and 5 OTT. Counts are evidence from one lineup, not
specification.

**Companion:** `docs/tablo-cloud-channels.md` is the field-by-field reference
for what the cloud and the device each return. This document is about
*external* sources — what they can fill in, and what nothing can.

---

## Why this was investigated

The Live card's badge showed `HD06` for channel 11.2. That is the cloud's
`network` field, which is a real affiliation for the major stations (`CBS`,
`NBC`, `ABC`) and a placeholder for everything else. 11.2 is PBS Kids.

Four channels also had no logo at all: **7.4, 8.2, 11.5, 23.3**.

---

## The finding that matters

**Schedules Direct's `stationID` is the same namespace as the device's
`tms_station_id`.** Verified: **21 of 21** channels that carry a real
Gracenote id matched exactly, including the translator call signs
(`K32EU-D`, `K08PR-D2`, `K14IU-D3`) that defeat every name-based source.

The device already stores the key — `identifier` is
`S{tms_station_id}_{major}_{minor}`. So identity needs no matching table, no
call-sign rules, and no hyphen normalisation.

### `S999…` means "Tablo did not map it", not "the data does not exist"

Five channels carry a synthetic `S999…` identifier. Two are OTA:

| | | |
|---|---|---|
| 7.4 | KIDS | 0 airings |
| 13.5 | THENEST | 0 airings |

Those are the *only* two OTA channels with no listings, and the correlation is
exact. It is tempting to read the prefix as "no upstream data". It is not:

**7.4 is a real Gracenote station.** `KSPS-DT4`, stationID **105612**,
affiliate *PBS Kids HD*, four logo variants, **48 scheduled programmes**. It
simply is not in the Missoula lineup, because `USA-OTA-59801` describes the
7.x block through the translators that relay KSPS into town, and those stop at
`-D3`. Spokane's own lineup (`USA-OTA-99201`) carries it.

So the blank channel is a **mapping gap in Tablo's guide**, not missing data.
KSPS publishes the same schedule publicly at ksps.org, labelled "7.4 Kids
24/7".

**13.5 (The Nest)** was not in the Missoula or Spokane lineups. Unresolved.

---

## Gracenote's affiliate logos are public and derivable

This is the most useful free result.

```
https://schedulesdirect-api20141201-logos.s3.dualstack.us-east-1.amazonaws.com
    /stationLogos/s{tms_affiliate_id}_{variant}_360w_270h.png
```

`variant` ∈ `dark`, `light`, `white`, `gray`. All four return 200 with no
auth. Verified across nine affiliate ids from this lineup:

```
s101364 PBS Kids   s11039 PBS     s48990 Create   s56725 World
s89922  Grit       s18633 ION     s10098 CBS
s10991  NBC        s10003 ABC     s10212 FOX
```

**`tms_affiliate_id` is already in the device's channel record.** So most of
the lineup's artwork is constructible from data we hold, with no subscription,
and the `white` variant is cut for exactly the dark plate the Live card uses
(see `01006b5`).

Two limits:

- Three channels have the literal string `Independent` as their affiliate id —
  8.2, 11.5, 23.3 — so there is no affiliate logo to build.
- 7.4's affiliate id is empty on the device, though it is PBS Kids and can
  borrow 11.2's `101364`.

Station-specific logos use a different, opaque pattern
(`GNLZZGG00253HKS.png_white_360w_270h.png`) and are not derivable — those need
the API.

---

## What each source is good for

| Source | Cost | Join key | Verdict |
|---|---|---|---|
| **Schedules Direct** | $35/yr | `stationID` = `tms_station_id` | Exact. Names, affiliates, 4-variant logos, schedules. |
| **Gracenote logo CDN** | free | `tms_affiliate_id` | Derivable URLs, no auth. Affiliate-level only. |
| **RabbitEars** | free | call sign | FCC-derived, authoritative affiliations. Webpage, not an API. **Channel numbers are RF-derived and do not match the Tablo.** |
| **Channel Master** | free | call sign + hyphen | Numbering matches the Tablo exactly. JS-rendered, so not fetchable. |
| **iptv-org** | free | name | Public domain, rich logos (44 PBS Kids variants). Name matching is unreliable. |
| **IPTV-EPG** | free | name | 60 MB gz / 530 MB XML, refreshed daily. **Channel names are not trustworthy.** |

### IPTV-EPG needs content matching, not name matching

`PBSKidsWestSoCal.us` carries *Midsomer Murders* and *PBS News Hour* — a
general PBS schedule under a PBS Kids id.

Searching by **programme title** instead found `PBSKidsKVIEDT4.us`, the
Pacific-timezone PBS Kids 24/7 feed, which matches KSPS 7.4 exactly:

```
PT      KVIE feed           KSPS 7.4 published
15:30   Alma's Way      =   Alma's Way
16:00   Lyla in the Loop =  Lyla in the Loop
16:30   Weather Hunters =   Weather Hunters
17:00   Odd Squad       =   Odd Squad
```

PBS Kids 24/7 is a national feed with East and West clocks; the other seven
feeds in the file are Eastern and run an hour ahead. So **7.4's schedule is
obtainable free**, via a sibling feed in the right timezone.

Its logos are opaque tokens (`/images/v2jkpDNpak…`, 512×512 PNG), only
discoverable by parsing the XML.

---

## The three `INDEPENDENT` channels, decoded

`INDEPENDENT` is not "unknown" — it means "not one of the majors". Each is
identifiable from its own listings or call sign:

| | Device call sign | Actually | Evidence |
|---|---|---|---|
| 8.2 | `MTN` | Montana Television Network's secondary | Gracenote affiliate `Independent`; RabbitEars brands it *The Spot*; iptv-org and IPTV-EPG both say *The CW*. **Sources disagree.** |
| 11.5 | `KUFM-L` | **MPAN** — Montana Public Affairs Network | Airs *Best of Mpan 2023*, *Montana's Capitol Coverage*. RabbitEars: "Montana Legislature". MontanaPBS `.5` slot. |
| 23.3 | `KTMFSWX` | **SWX Right Now** (regional sports) | Airs *SWX Right Now*, *Nuanez Now*, *Pac-12 Classics*. Call sign says it outright. |

On 8.2, Gracenote — the licensed source, and the one Tablo itself uses —
agrees with the cloud's `INDEPENDENT`. The aggregators saying CW are
unverified.

---

## What nothing can fix

**11.5 (MPAN) and 23.3 (SWX) have no logo in any source checked.** Empty in
the cloud, empty on the device, zero in Gracenote despite matching exactly,
absent from iptv-org and IPTV-EPG. Affiliate id is the string `Independent`,
so there is no affiliate logo either. MontanaPBS and SWX publish marks on
their own sites; that is a manual grab for two channels, once.

**7.4 KIDS advertises three logo URLs that 404** — `KIDS_black.png`,
`KIDS_white.png`, `KIDS_modified.png` — from *both* the cloud and the device.
A listed-but-absent logo is worse than an absent one, because nothing reports
it. This is why `ChannelLogo` falls back on `onError` and not only on a null
URL.

---

## Also found

**A receivable channel is missing from the lineup.** Channel Master, RabbitEars
and Schedules Direct all list **8.7 KPAX-DT7, MovieSphere Gold**, at strong
signal. The Tablo does not have it. Worth a channel rescan on the device.

The other four stations SD carries that the Tablo does not (`K08PR-D`,
`K14IU-D`, `K14IU-D2`, `KECI-DT3`) are alternate transmitters for networks
already received — the Missoula translator mesh, which is also why the call
signs are a mix of `KECI-DT2` and `K14IU-D3`.

**`tms_station_id` is proprietary, not a public registry.** It is Gracenote's
(formerly Tribune Media Services) commercial identifier, licensed rather than
published. The public, government-assigned equivalent is the **FCC Facility
ID**, and there is no official crosswalk: one FCC facility maps to many
Gracenote stations, one per subchannel — visible here, where KPAX's six
subchannels carry six distinct ids.

---

## Traps, for whoever repeats this

- **Never match on channel number.** RabbitEars' numbering is RF-derived and
  offset from the Tablo's (KUFM-C is 11.5 there, 11.3 here). KSPS is 8.x there,
  7.x here. Call signs are stable; numbers are not.
- **Never trust IPTV-EPG's channel names.** Match on programme titles.
- **Schedules are returned in UTC.** A day's schedule starting `00:00Z` is the
  previous afternoon in Pacific. Convert before concluding anything about
  "what is on now".
- **`/lineups/preview/{id}` reads a lineup without adding it** — no lineup slot
  and none of the six daily changes. Use it to check whether a station exists
  before spending a slot.

---

## Reproducing

Probe scripts were written to the session scratchpad, not committed — they
take a password on the command line and are one-offs:
`sd_probe.py` (does the join hold), `sd_report.py` (names, logos, extras),
`sd_ksps.py` (preview a neighbouring market), `sd_spokane.py` (add a lineup
and pull a station), `sd_now.py` (what is on now), `sd_hunt.py` (sweep markets
by preview).

Schedules Direct: `https://json.schedulesdirect.org/20141201/`, token auth,
password SHA1'd as their wire format. 4 lineups and 6 lineup changes per 24h.
