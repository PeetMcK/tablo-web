# Offline Recordings — Keep a Copy the Tablo Cannot Take Back

**Date:** 2026-09-15
**Status:** Proposed (partially scaffolded)
**Depends on:** `2026-09-15-recording-playback-design.md`

---

## Problem

Two ways a recording you care about can disappear today, neither under your control:

1. **The Tablo deletes it.** Recordings vanish from `/recordings/airings` when the
   device reclaims space or the user deletes them on another client. The library
   is built by listing the device, so the entry simply stops appearing — and the
   transcoded windows already on disk become unreachable, because nothing can
   resolve `object_id → path` any more.
2. **tablo-web evicts it.** The cache is LRU under `TRANSCODE_CACHE_GB` (default
   20). A recording you transcoded in full can be reclaimed to make room for one
   you watched five minutes of.

So "I transcoded the whole game" currently means "until something else needs the
space, or the tuner tidies up".

## Goal

An explicit **Keep offline** action that:

- transcodes the entire recording, not just a lookahead window
- is exempt from LRU eviction
- keeps playing after the Tablo has deleted the source
- is removed only by a deliberate user action, never automatically

---

## Already in place

Scaffolding landed with the windowed cache and is inert without routes:

- `CacheMeta.pinned: bool` — the exemption flag
- `CacheMeta.info: dict | None` — snapshot of library fields
- `TranscodeCache.set_pinned()`, `pinned_ids()`, `thumbnail_path()`
- `make_room()` skips pinned entries
- `evict(force=False)` refuses pinned entries unless forced
- `_prefetch_loop` already branches on `pinned` to fill **all** windows and to
  ignore the idle-viewer timeout

What remains is the metadata snapshot, the routes, the library merge, and the UI.

---

## Design

### Self-sufficiency is the whole point

A pinned recording must render and play with **no device involvement**. Today the
cache stores only what it needs to transcode — `object_id`, `path`,
`source_duration`. Everything the library displays (title, subtitle, description,
air date, thumbnail) is fetched live from the Tablo per request, and the thumbnail
is proxied from `/images/{id}`.

All of that has to be captured at pin time:

```
/data/cache/recordings/{object_id}/
    meta.json        + pinned: true
                     + info: { title, subtitle, description, start,
                               duration, width, height, state }
    thumb.jpg        copied from the device at pin time
    w00000/ ...      transcoded windows (unchanged)
```

`info` is the same projection `AppState._recording_fields` already produces, so
there is one shape, not two.

### Library becomes a union

```
GET /api/recordings
    device recordings (live)          →  cache_state, pinned from the cache
  ∪ pinned cache entries not on the device  →  rendered from meta.info,
                                               flagged offline_only
```

Offline-only entries are visually distinct — the source is gone, so no
re-transcode is possible if the cache is damaged, and the user should know that.

Sorting stays by `start` across the union so an offline copy sits where it always
did rather than in a separate section.

### Playback needs no device

`watch_recording` currently calls `state.resolve_recording()`, which hits the
device. For a pinned entry with every window present, that call is unnecessary —
and would fail for an offline-only recording. The path becomes:

```
if cache.state(id) is COMPLETE and cache.read_meta(id).pinned:
    return stream_url immediately, no device call
else:
    resolve against the device as now
```

`build_playlist` already derives everything from `meta.source_duration`, so the
playlist works untouched.

### Thumbnails

`recording_thumbnail` resolves against the device on every request. It gains a
cache-first path: serve `thumb.jpg` when present, fall back to the device, and
opportunistically save what it fetches so pinning is not the only way a thumbnail
gets persisted.

### Storage accounting

Pinned bytes are excluded from the LRU budget — otherwise a few pinned games
would leave no working room and `make_room` would raise `CacheFull` on every new
playback.

That means pinned storage is unbounded by design, which is correct (it is what
the user asked for) but must be visible. `GET /api/recordings/storage` reports
pinned bytes, cache bytes, budget, and free disk. The disk guard in
`_check_disk` already refuses to start a transcode when space is short.

### Deletion

| action | effect |
|---|---|
| `DELETE /{id}/keep` | unpin — becomes ordinary cache, LRU may later reclaim it |
| `DELETE /{id}/cache` | delete the transcoded copy now (`force=True`) |

Nothing else removes a pinned entry. Not LRU, not the orphan sweep, not a
restart. `sweep_orphans` removes only unmarked (truncated) window directories and
already leaves completed windows alone.

We never delete from the Tablo. The app has no write access to the device beyond
starting watch sessions, and should not acquire any as part of this.

---

## API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/recordings/{id}/keep` | Pin, snapshot metadata + thumbnail, start full fill |
| `DELETE` | `/api/recordings/{id}/keep` | Unpin; transcoded windows stay until LRU |
| `GET` | `/api/recordings/storage` | pinned / cached / budget / free bytes |
| `GET` | `/api/recordings` | now a union, each entry carrying `pinned`, `offline_only`, `cache_progress` |

`POST /keep` returns immediately; the fill runs in the background and is observed
through the existing `/status` endpoint.

---

## Frontend

**Library card** gains a keep control with four states, driven by `pinned` and
`cache_progress`:

| state | control |
|---|---|
| not kept | outline download icon |
| keeping | ring progress + percentage |
| kept | solid icon, `offline` label |
| offline-only | `offline` label, source-gone marker |

Clicking a kept item offers removal, with confirmation — it is the only way the
copy can be lost, so it should feel deliberate.

**Storage line** at the top of the Library: `12.4 GB kept · 3.1 GB cache · 1.6 TB free`.

An in-progress keep continues if the user navigates away or closes the tab: the
pinned branch of `_prefetch_loop` deliberately ignores the watcher-idle timeout
that stops ordinary lookahead prefetch.

---

## Testing

Backend, no device required (the existing suite's approach):

- pinned entry survives `make_room` when far over budget
- `evict()` refuses a pinned entry; `evict(force=True)` removes it
- pinned prefetch fills every window and ignores the idle timeout
- ordinary (unpinned) prefetch still stops on idle — guards against the fix for
  the 780% CPU regression being undone
- `info` snapshot round-trips and renders a library entry with the device stubbed
  out entirely
- library union: device-only, pinned-and-present, pinned-and-gone
- `watch` on a complete pinned entry makes no device call

Manual, against the device: pin a recording, wait for completion, stop the
backend, remove the recording's path from the device map, restart, confirm it
still lists, still has its thumbnail, and still plays end to end.

---

## Risks

| Risk | Handling |
|---|---|
| Unbounded pinned storage fills the volume | Excluded from LRU by design; surfaced via `/storage`; `_check_disk` still blocks new transcodes |
| A full fill competes with live playback | Pinned fill uses the same `PREFETCH_CONCURRENCY` and the same SIGSTOP yield to on-demand seeks |
| Pinning something still recording | Refuse when `video_details.state == "recording"` — the source is incomplete |
| Cache corrupted and source gone | Unrecoverable by definition. Offline-only entries are marked so the user knows the safety net is gone |
| `info` schema drifts from `_recording_fields` | One projection function, used for both; a test asserts the snapshot renders |

## Out of scope

- Exporting to a file (MP4 download). Different feature: needs a concat/remux
  pass over the windows and a download endpoint.
- Syncing offline copies between devices.
- Automatic pinning by rule ("keep all Broncos games").
- Deleting recordings on the Tablo.
