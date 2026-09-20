# Library — In-Card Management Design

**Date:** 2026-09-20
**Status:** spec for review (Recordings deferred; build this first)

## Goal

Add **light management** to the existing Library — the watch-first, day-grouped
grid of **episode** cards — without changing its nature. A viewer can, from the
card itself: see whether a recording is **New / watched**, toggle **watched**,
toggle **protect** (device-side keep-from-deletion), and see **New**. Deleting a
recording already exists (via the ShowInfo sheet) and stays.

This implements the **episode-card thumbnail overlay convention** from the
Recordings spec (`2026-09-20-recordings-page-design.md`) on the Library card.
Library shows episodes directly; the Recordings *series* page is a separate,
deferred build.

## Non-goals

- The whole **Recordings** tab (series management, rules, keep, padding,
  upcoming, conflicts) — deferred.
- Changing Library's organization (stays grouped by air-day, watch-first) or
  adding alternate view types (later).
- Bulk / multi-select in Library (that's a Recordings-series concern).
- Auto-marking watched during playback — a player concern; see the Recordings
  spec's note (the device sets `watched` off its own player session; our manual
  toggle here is independent).

## What already exists (reuse)

The FE `Recording` type and the recordings list already carry: `watched`,
`position`, real `duration` (recorded seconds incl. padding — **not** the
scheduled slot; `slot_seconds` is the slot), `thumbnail`/`snapshot_image`,
`state`, `cache_state`, `pinned` (local offline keep), `offline_only`. Backend
already has `POST /api/recordings/{id}/watched {watched}` and single
`DELETE /api/recordings/{id}`.

**The one data gap: `protected`** (device-side) is not surfaced or writable yet.

## Card changes (the overlay convention on LibraryView)

Corners (maps to existing `LibraryView.tsx` overlay code):

- **top-left** — unchanged state badge (Recording / Incomplete / Cached / Ready /
  "% cached"), **plus** the `CloudOff` **"Only here"** badge **moved here to sit
  beside it** (currently top-right). They can co-exist (offline_only + a cache
  badge).
- **top-right** — **watched + protect cluster**, order **watched (left) → protect
  (right)**. *Affirmative persistent (rest + hover), negative only on hover:*

  | slot | state | rest | hover | click → |
  |---|---|---|---|---|
  | Watched | `watched` | `Eye` | `Eye` | unwatch |
  |         | not watched | — | `EyeOff` | watch |
  | Protect | `protected` | `Lock` | `Lock` | unprotect |
  |         | not protected | — | `LockOpen` | protect |

  Chip style matches the runtime badge (`bg-ink/80`). Card-level group-hover
  reveals the negatives (same trigger as the Resume/From-start buttons). Each
  toggle `stopPropagation`s (a tap toggles, never plays) and is optimistic with
  revert-on-error (resync from the response).
- **bottom-left** — a left→right cluster `[Undo] [NEW]`. The **NEW chip**
  (accent, shown when `position === 0 && !watched`) is the anchor and is
  **persistent** (rest + hover). The existing **"remove custom picture"** button
  (`Undo2`) is **hover-only** (`opacity-0` → `group-hover/art:opacity-100`) and
  only rendered when `rec.cover_frame !== null`; when it appears it sits **to the
  LEFT of the NEW chip** (they coexist — not a swap). Implement as one
  `absolute bottom-3 left-3 flex items-center gap-1.5` row: Undo first, NEW
  second. With no custom cover, only NEW shows; with a custom cover, Undo fades
  in to NEW's left on hover.
- **bottom-right** — runtime, from `duration` (already the real recorded length
  in our model — leave as-is).
- **bottom edge** — existing fill/progress strip (resume position).

### Season/episode on the card

The card is an **episode**, so show **`S{season} E{episode}`** on the title
line, **inline to the right of the series title** (muted/secondary weight),
e.g. `Wild Kratts  S3 E23`. The (i) info button stays at the far right of that
row. Data is already on the record (`season_number`, `episode_number`). Omit the
S/E entirely when either is null (sports, movies, live/one-off) — don't render
`S? E?`. The info sheet already shows S/E; the card should match its labelling.

Watched state is signalled by the **persistent eye** **and** a **noticeable but
not drastic dim of the thumbnail image** (e.g. ~55-70% opacity / slight
desaturation on the picture only — not the text below). The dim clears when
unwatched.

## Info sheet must use the EPISODE airing image (not the series cover)

The Library card shows the **episode's airing image** (the recording's
`snapshot_image`, resolved by `cardArt(rec)` in `lib/recording.ts` — a
user-picked `thumbnail` outranks it). But the **(i) info sheet** (`ShowInfo`)
renders `detail.image_url`, which `recording_detail` sets from
`art.get("cover_url")` — the **series cover**. So the info sheet can show a
generic series image while the card shows the actual episode still (e.g. the
Will Ferrell / Paul McCartney SNL episode).

**Fix:** the info sheet must show the **exact same image the card shows, in
every case** — same precedence as `cardArt(rec)`:

1. **Viewer-set custom cover / picked frame** (`thumbnail` — via
   `setRecordingCover`) — highest priority
2. **Episode airing image** (`snapshot_image`)
3. **Series cover** (`cover_url`) — fallback only

**Preferred implementation:** pass the card's already-resolved `cardArt(rec)`
into `ShowInfo` as the image (single source of truth), so card and sheet can
**never** diverge — a custom image the viewer chose shows in both, automatically.
(If instead `recording_detail.image_url` is fixed server-side, it must apply the
same custom→snapshot→series precedence, not just swap cover for snapshot.)

This applies to the recording/library path; a pure guide airing (no recording
yet) keeps its own image.

- **Surface `protected`** in the recordings list serialization (from the
  device record's `user_info.protected`), and in `recording_detail`.
- **New route** `PATCH /api/recordings/{object_id}/protect {protected: bool}` →
  resolves the episode path and `PATCH {episode_path} {"protected": …}` on the
  device (the write shape captured live: `PATCH
  /recordings/{series|sports}/episodes|events/{id} {"protected":true|false}` →
  200, echoes the episode). Auth-gated; device refusal via the `_device_error`
  pattern. (Episode path kind resolver: `episodes` for series/movies, `events`
  for sports.)
- No change to watched/delete — reuse existing routes.

## Frontend

- `Recording` type: add `protected: boolean`.
- `api.setProtected(objectId, protected)` → `PATCH /recordings/{id}/protect`.
  (`api.setRecordingWatched` already exists.)
- `LibraryView.tsx`: add the top-right cluster + NEW chip; move `CloudOff` to
  top-left; wire the two toggles (optimistic, `stopPropagation`). Promote the
  `Switch`-like affordance minimally — these are icon buttons, not the Settings
  toggle; reuse lucide `Eye`/`EyeOff`/`Lock`/`LockOpen` (already imports
  several lucide icons).

## Testing

- **Backend:** list + detail carry `protected`; `PATCH .../protect` forwards the
  flat `{protected}` to the correct episode path (series → `/episodes/`, sports →
  `/events/`), auth-gated, device refusal surfaced. Device stubbed as in
  `test_settings.py`/`test_schedule.py`.
- **Frontend (LibraryView tests):** watched card shows persistent `Eye`;
  unwatched shows nothing at rest and `EyeOff` on hover; clicking fires
  `setRecordingWatched(id,false/true)`. Protected shows persistent `Lock`;
  unprotected shows `LockOpen` on hover; clicking fires `setProtected`. NEW chip
  appears iff `position===0 && !watched`. `CloudOff` renders top-left with the
  cache badge. Toggles don't trigger playback (stopPropagation).

## Resolved decisions

1. **Delete in Library — leave as-is (ShowInfo delete only).** No card delete
   now. Deferred: the **delete vs delete-cached-copy** distinction needs care
   (`DELETE /recordings/{id}` removes the device recording; `DELETE
   /recordings/{id}/cache` / evict only drops the local copy) — revisit before
   putting any delete on the card.
2. **Watched visual — dim the thumbnail**, noticeable but not drastic (see the
   card section), plus the persistent eye.
3. **Lock = device `protected`** for now. The **`pinned` (local offline keep)
   vs `protected` (device retention)** distinction still needs to be worked out
   (copy/placement so they don't read as redundant) — deferred; for this build
   the lock toggles `protected` only.
