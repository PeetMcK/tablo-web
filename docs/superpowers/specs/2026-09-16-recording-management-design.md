# Recording management, v1

Make the show sheet schedule recordings: record or cancel this episode, and set
the series rule to All, New or None.

The sheet already exists and is read-only — it offers Watch Live and nothing
else. The mirror already holds every handle a write needs, captured by
`2026-09-16-show-info-design.md` precisely so this work would need no migration
and no re-sync. The device's write surface is mapped in `docs/tablo-api.md`.
What is missing is the route between them.

**This is v1 and covers the hero card only.** The Tablo app also has a Recorded
Series screen, a Series Recording Options sheet and a Manage Episodes view.
None of them are designed here — see **Later**.

## What the device accepts

`PATCH` only. `POST` and `PUT` against these paths return `404 none_found`; they
are not routed at all.

```
PATCH /guide/series/episodes/{id}    {"scheduled": true}
PATCH /guide/series/{id}             {"schedule": {"rule": "new"}}
```

Three properties make this surface safe to build against:

- **The response is the full updated record**, so a write doubles as a read. No
  follow-up GET is needed to refresh local state.
- **The validator is strict.** Unknown keys and bad values are rejected rather
  than silently applied — a wrong guess returns 400 instead of doing something
  unintended.
- **`details` echoes the offending field and its value**, so a failure can be
  shown to a person rather than reported as a generic error.

Read shape and write shape differ, and the asymmetry is easy to get backwards:
the GET exposes `schedule.state` (`"none"` / `"skipped"` / …), but the write
parameter is `scheduled`, a boolean, at the top level. `{"schedule": {"state":
…}}` is rejected. Series rules are the opposite way round — nested
`schedule.rule` is accepted and the top-level `schedule_rule` the GET returns is
not.

### The enumeration is unconfirmed, so step one is a probe

Only `"new"` is proven for `schedule.rule`. `"all"` and `"none"` are inferences
from the app's UI, not from the device.

Before any UI is wired, confirm them, using the two techniques in
`docs/tablo-api.md` §"How to extend this safely":

1. Choose a series with nothing to lose — `keep: {rule: "none", count: null}`
   and zeroed offsets — so even replace-style PATCH semantics could not destroy
   anything.
2. `PATCH {"schedule": {"rule": "ZZZ"}}`. The 400 names the parameter it wanted.
   This costs nothing: a rejected write cannot change anything.
3. For each candidate value: GET the series, PATCH the value, GET again, diff
   the whole object, restore the original. Verify by diffing before and after,
   not by reading the response — a 200 does not prove the absence of a side
   effect elsewhere.
4. Record what was confirmed in `docs/tablo-api.md`, replacing the
   corresponding §Unknowns entry.

If a value turns out not to exist, that segment is dropped from the control
rather than shipped to fail. The UI follows the probe; the probe does not
follow the UI.

## Schema: unchanged

`guide_airing` already carries `airing_path`, `series_path`, `schedule_state`,
`schedule_qualifier` and `skip_reason`. `guide_series` already carries
`schedule_rule`, `keep_rule` and `keep_count`. Both were captured and left
deliberately unexposed for this work.

Schema stays at version 4. No migration, no backfill.

## Reading: widen `airing-detail`

`GET /api/channels/airing-detail?channel={identifier}&start={iso}` gains:

```
schedulable      bool          -- airing_path is not null
scheduled        bool          -- derived; see "The sheet"
past             bool          -- the airing has finished
schedule_state   string|null   -- the device's own string, passed through
skip_reason      string|null
series           {path, schedule_rule} | null
```

`schedulable` is computed server-side rather than left to the client to infer
from a path, because the path itself never leaves the backend (see below).

`past` is not the inverse of the existing `airing_now`, and the difference is
the whole point of adding it: `airing_now` is false for everything *upcoming*
too, which is the main thing anyone records. Only `past` means recording is no
longer possible. Both are computed here for the same reason — the browser's
clock may differ from the one the guide was built against.

Still served entirely from the mirror. The sheet opens on a click and must not
wait on a device round trip — the same rule the read path already follows.

## Writing: `app/routes/schedule.py`, mounted at `/api/schedule`

```
PUT /api/schedule/airing   {channel, start, scheduled: bool}
PUT /api/schedule/series   {channel, start, rule: "all"|"new"|"none"}
```

Both are keyed on `(channel, start)` — `guide_airing`'s primary key, which is
what the sheet already holds. No new identifier is plumbed through the
frontend, and **no device path is ever sent to the browser**: the server looks
`airing_path` and `series_path` up in the mirror. A device path in client hands
is a PATCH target in client hands.

Both return the same shape `airing-detail` returns, so the sheet re-renders from
the write's own response with no second request.

### Write-through, from the response

The PATCH response is the full updated record. Map it through the existing
`state._airing_row` / `state._series_row` projections and write it to the
mirror. The row the person just changed is correct immediately, including after
a reload.

### A series rule change fans out

Setting a series rule flips `schedule.state` on every future episode of that
series, and the background sync only runs every `TABLO_GUIDE_SYNC_HOURS`
(default 6). Left alone, "Record All Episodes" would leave every sibling airing
claiming it is not scheduled for up to six hours.

So a series write queues a bounded background refetch: select that series'
future airings from the mirror, re-fetch each from the device at
`SERIES_SYNC_CONCURRENCY`, write the rows through. A fortnight of one series is
tens of records, not thousands, and it runs after the response is sent.

The refetch is guarded on its own and never fails the write. The write already
succeeded on the device; reporting it as a failure because a refresh stumbled
would be a lie about the thing that matters.

### Errors: `state.patch_device()`

`_request_device_raw` calls `raise_for_status()`, which throws the device's
error body away — and that body is the only thing that can tell someone *why* a
write was refused. A new helper returns `(status, json)` without raising, and
the route maps:

| Device | API | Body |
|---|---|---|
| 200 | 200 | the updated airing detail |
| 400 | 400 | `error.description`, plus `error.details` |
| other 4xx/5xx, timeout, connection error | 502 | a fixed message |

Two refusals happen before the device is touched:

- Unknown `(channel, start)` → **404**. Same as `airing-detail`.
- `airing_path` is null → **409**, with a message saying the channel's schedule
  comes from the cloud. This is the OTT/FAST case and it is not an error state
  to be hidden: the cloud carries no `path`, no `schedule` block and no
  `series_path`, so those airings cannot be scheduled by anything. A 409 is
  honest where a silent no-op would look like a lost click.

## The sheet

`ShowInfo.tsx` only. No new component, no new modal idiom.

Below Watch Live, following the Tablo app's ordering because it is familiar:

- **Status eyebrow**, only when scheduled: `REC · Record: This Episode Only`, or
  `REC · Record: All Episodes` when the series rule is what put it there.
- **Record Episode** ⇄ **Don't Record Episode**, toggling on `schedule_state`.
- **Edit Series Recording** — a segmented `All | New | None` with the current
  rule filled, shown only when `series.path` exists.

"Scheduled" is one predicate, defined once and server-side, so the sheet is not
guessing from a string enumeration nobody has enumerated: the widened
`airing-detail` carries `schedule_state` verbatim *and* a derived `scheduled`
boolean — true when `schedule_state` is neither null, `"none"` nor `"skipped"`.
The eyebrow reads `Record: All Episodes` when the series rule is `all` or `new`
and the episode is scheduled, and `Record: This Episode Only` otherwise.

Three states the layout must not treat as failures:

- **Not schedulable** (`schedulable: false`): no buttons, one muted line —
  "Recording isn't available on this channel". The sheet's existing rule is to
  omit rather than empty, and a disabled button with no explanation reads as
  broken.
- **Past airing** (`past: true`): no episode button; the series control stays,
  because a rule set from an old listing is about every episode still to come.
- **No series** (a one-off, a movie, an airing whose series was never fetched):
  episode button only.

Writes are optimistic: the control takes its new state immediately and is
disabled while in flight. On failure it reverts and shows the device's own
`description` inline. Optimism is right here because the common failure is a
network one, and the response carries the truth either way.

## Testing

**Probe.** Not a test — a prerequisite. Its output is a documentation change
and, if a value does not exist, one fewer segment in the control.

**Routes.** A `(channel, start)` that is not in the mirror is a 404. An airing
with a null `airing_path` is a 409 and issues no device request. A device 400
becomes a 400 carrying `description`; a timeout becomes a 502. A successful
episode write updates `guide_airing.schedule_state` from the response. A
successful series write updates `guide_series.schedule_rule`. Both return the
`airing-detail` shape.

**Fan-out.** A series write schedules a refetch of that series' future airings
and no others. A refetch that raises does not fail the write, and the write's
own row stays updated.

**Reading.** `airing-detail` reports `schedulable: false` for a cloud-only
airing and `true` for a device one; `series` is null when `series_path` is.

**Frontend.** A scheduled airing renders Don't Record and the REC eyebrow; an
unscheduled one renders Record Episode. A rule change sends the rule and paints
the new segment. A rejected write reverts the control and shows the message. A
non-schedulable airing renders neither control. Escape-to-close and focus
return are unaffected.

All device interaction is injected, as the existing tests do — none of this
needs hardware except the probe.

## Later

Named so they are not lost, and deliberately not designed here:

- **REC badges in the guide grid.** The mirror holds `schedule_state` for every
  airing already, so this is a template change rather than a capture one.
- **The Recorded Series screen** — Recordings / Scheduled / Upcoming Airings.
- **Series Recording Options** — start/stop padding (`schedule.offsets`, which
  requires all three of `start`, `end` and `source`), `keep`, channel.
- **Manage Episodes** — bulk delete.
- **Conflicts and Failures.** The device advertises a `conflicts` capability
  but no endpoint for it has been found; `/guide/conflicts` and
  `/recordings/conflicts` both 404. This needs discovery before it needs a
  design.
