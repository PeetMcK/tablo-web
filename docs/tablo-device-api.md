# The Tablo 4th-gen device API

What the local device accepts, as far as we have established it. Written down
because it is not documented anywhere public, and because the write surface in
particular was derived by probing real hardware rather than read from a spec.

Applies to the 4th-generation devices — this one was mapped against a `t4g4`
("Tablo 4G QUAD 128GB", firmware 2.2.58) on the LAN at port 8887. The older
Tablo API is a different protocol: unauthenticated HTTP on port 8885, a `/batch`
endpoint, different paths. Projects written against that generation
(`jessedp/tablo-api-js` and its descendants) do not transfer.

## Why none of the reference projects answer this

Three exist, and all three stop short of writes:

| Project | Covers |
|---|---|
| `trevor-viljoen/tablo-api` (vendored here) | `channels`, `watch`, `ping`, `server_info` — reads only |
| `hearhellacopters/tablo2plex` | one POST, `/guide/channels/{id}/watch`; its "schedule" files are local JSON for the Plex EPG |
| `jessedp/tablo-api-js` | previous device generation |

So scheduling had no published contract. Everything in **Writes** below came
from probing.

## Authentication

Every local request is signed. `TabloAuth.make_device_auth(method, path, body)`:

```
msg_hash = md5(body) if body else ""
payload  = f"{method}\n{path}\n{msg_hash}\n{date}"
sig      = hmac_md5(HASH_KEY, payload)
Authorization: tablo:{DEVICE_KEY}:{sig}
Date: {date}
```

The signature covers the body, so writes need no separate mechanism — the body
hash slot exists precisely because the scheme was designed for requests that
carry one. `_request_device_raw(method, path, body)` in `app/state.py` is the
primitive; it threads `body` into the signer and returns the raw response.

## Reads

| Path | Returns |
|---|---|
| `/guide/channels` | list of channel paths |
| `/guide/airings` | list of airing paths — 8,752 on a typical guide |
| `/guide/series/episodes/{id}` | one airing: `episode`, `airing_details`, `schedule`, `series_path` |
| `/guide/series/{id}` | one series: `series`, `schedule`, `schedule_rule`, `keep`, `show_counts` |
| `/images/{image_id}` | JPEG, ~15 KB |
| `/server/info` | model, tuner count, firmware |

There is no batch endpoint in use — one request per airing, and the interactive
guide load caps at 1,000 (`_build_grid_enrichment`). A full walk is ~8,750
signed round trips; measured ~130/s through our own proxy.

### Fields worth knowing about

An airing carries more than the grid currently keeps. `episode.title`,
`episode.season_number` and `episode.number` are already in the response we
parse and discard — capturing them costs no extra requests.

A series carries `series_rating` (e.g. `"tvy"`), `genres`, `cast`, and three
image ids (`cover_image`, `thumbnail_image`, `background_image`).

## Writes

**`PATCH` only.** `POST` and `PUT` against these paths return
`404 none_found` — they are not routed at all.

### Record a single episode

```
PATCH /guide/series/episodes/{id}
{"scheduled": true}
```

Boolean. A string gives `400 Invalid parameter value`.

Note the asymmetry: the GET response exposes `schedule.state`
(`"none"` / `"skipped"` / …), but the write parameter is `scheduled`, a
boolean, at the top level. Read shape and write shape are not the same, and
`{"schedule": {"state": ...}}` is rejected.

The response is the full updated airing, so a write doubles as a read — no
follow-up GET is needed to refresh local state.

### Series rules

```
PATCH /guide/series/{id}
{"schedule": {"rule": "new"}}
{"keep":     {"rule": "none", "count": 5}}
{"schedule": {"offsets": {"start": 0, "end": 0, "source": "none"}}}
```

Nested, not flat. The GET response also exposes a top-level `schedule_rule`,
but writing that key fails with `Must specify at least one valid parameter` —
only the nested `schedule.rule` form is accepted.

`offsets` (recording padding) requires all three fields. Sending `start` and
`end` without `source` fails with `Missing value for 'source' string
parameter`, even when both values are valid.

### Error contract

```json
{"error": {"code": "invalid_patch_document",
           "description": "Invalid value for 'rule' parameter",
           "details": {"rule": "ZZZ"}}}
```

`details` echoes the offending field and its value, so failures can be
surfaced to a user rather than reported as a generic error.

The validator is strict: unknown keys and bad values are rejected rather than
silently ignored. That is the property that makes this surface safe to build
against — a wrong guess returns 400 instead of doing something unintended.

## Still unknown

The **enumerations**. The validator rejects bad values but does not list good
ones, so these need a deliberate write to confirm:

- `schedule.rule` beyond `"new"` — presumably `"none"` and `"all"`
- `keep.rule` beyond `"none"`
- `offsets.source` beyond `"none"`

Low risk to discover in place: a wrong value is refused cleanly.

## How to extend this safely

The mapping above was done without changing a single setting, using two
techniques. Both are worth reusing.

**Write the value that is already there.** Reading an object first, then
PATCHing a field to its current value, exercises the full path — auth, verb,
body signing, validation — while being a no-op. This is how `PATCH` was
confirmed as the verb.

**Send a deliberately invalid value.** A rejected write cannot change
anything, and the 400 names the field it objected to. This is how the
`scheduled` parameter was found: patching `{"schedule": {"state": "ZZZ"}}`
came back with `details={'scheduled': None}`, naming the parameter the device
actually wanted.

Choose a target with nothing to lose. The series used here already had
`keep: {rule: "none", count: null}` and zeroed offsets, so even replace-style
PATCH semantics could not have destroyed anything.

Verify by diffing the whole object before and after the run, not by reading
the response — a 200 does not prove the absence of a side effect elsewhere.
