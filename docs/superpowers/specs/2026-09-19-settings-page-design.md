# Settings Page — Design

**Date:** 2026-09-19
**Status:** approved (build autonomously; revise after)

## Goal

A Settings modal reached from a gear icon in the app's top-bar tablo-web icon
menu. One modal, sectioned, that reads and writes the device's own settings via
the endpoints mapped in `docs/tablo-api.md`. Where the device exposes no write
verb, the control is present but **no-op** (visible, disabled-or-inert, labelled
so a later revision can wire it).

## Non-goals

- No cloud/Lighthouse account settings (subscription, account holder). Device
  only.
- No per-stream / playback settings (those live in the player).
- Not a redesign of the top bar — only add a gear entry to the existing menu.

## Entry point

Gear icon in the existing tablo-web icon menu (top bar). Click → opens the
Settings modal over the app. Standard modal dismissal (backdrop click, Esc,
close button). Only mounts/fetches when opened.

## Backend — one new router `/api/settings`

All device calls go through `state.request_device(method, path, body="")` (GET/
POST) and `state.patch_device(path, payload) -> (status, body)` (PATCH). Every
route requires `state.is_authenticated` (401 otherwise), mirroring
`channels.py`. Reads pass the device object through; writes return the device's
updated object (device echoes the full object on PATCH — a write doubles as a
read).

### Reads

| Route | Device call | Notes |
|---|---|---|
| `GET /api/settings/overview` | fan-out: `server/info`, `server/network`, `server/harddrives`, `server/guide/status`, `server/location`, `settings/info?allowAudioTranscode=true`, `server/update/info` | one composed payload for the whole modal; each sub-fetch tolerant (a failing sub-call returns `null` for its slice, not a 500) |
| `GET /api/settings/info` | `GET /settings/info?allowAudioTranscode=true` | the mutable toggles incl. `audio` |
| `GET /api/settings/harddrives` | `GET /server/harddrives` | storage |
| `GET /api/settings/location` | `GET /server/location` | postal/state/timezone |
| `GET /api/settings/guide-status` | `GET /server/guide/status` | last_update, limit, download_progress |

### Writes (real — device has the verb)

| Route | Device call | Body |
|---|---|---|
| `PATCH /api/settings/info` | `PATCH /settings/info` | one flat key per call; allow-list: `led`(on\|dim\|off), `enable_amplifier`(bool), `exclude_duplicates`(bool), `extend_live_recordings`(bool), `auto_delete_recordings`(bool), `audio`(ac3\|aac) |
| `PATCH /api/settings/name` | `PATCH /server/info` | `{"name": str}` device rename |

`PATCH /api/settings/info` validates the key against the allow-list (400 on an
unknown key or bad value) and forwards exactly one key. On device error it
returns the device's `{"error": {...}}` body with the device's status.

### Channels (real — scan lifecycle + commit)

| Route | Device call | Notes |
|---|---|---|
| `GET /api/settings/channels` | `GET /channels/info` → committed scan id → `GET /channels/scans/{id}/discovered` → each `GET /channels/scans/discovered/{cid}` | returns the lineup: each channel `{path, channel_identifier, call_sign, resolution, selected, signal_state}` |
| `POST /api/settings/channels/scan` | `POST /channels/scans` | starts a scan; returns `{scan_id, progress, completed}` |
| `GET /api/settings/channels/scan/{id}` | `GET /channels/scans/{id}` | poll: `{progress, completed}` |
| `GET /api/settings/channels/scan/{id}/discovered` | `GET /channels/scans/{id}/discovered` (+ per-channel) | discovered channels as they fill |
| `POST /api/settings/channels/commit` | `POST /channels/scans/{id}/commit` | body: JSON array of `/channels/scans/discovered/{id}` paths = the kept lineup. Hiding a channel = omit its path. 204 on success |

Scan can wedge the device under load (`docs/tablo-api.md`): the poll route is
called on a human-driven interval (~2s) from the FE, not a tight backend loop.

### No-op writes (device verb not captured)

| Route | Behaviour |
|---|---|
| `POST /api/settings/guide/update` | returns `{"ok": false, "noop": true, "reason": "no guide-refresh verb captured"}` (200). Wire when captured. |
| `PATCH /api/settings/location` | returns `{"ok": false, "noop": true, "reason": "no location-set verb captured"}` (200). Accepts `{postal_code}` in body for forward-compat; does not send to device. |

## Frontend — Settings modal

One modal component, sections in order:

1. **Storage** — from `harddrives`: drive kind, total size, format/busy state,
   connected. A capacity bar (graph): show total; if the payload carries a free/
   used field render used-vs-free, else render capacity only with a note. One
   bar per connected drive.
2. **Device (LED / amplifier)** — LED as a 3-way (On / Dim / Off); Amplifier as
   a switch. Each writes immediately via `PATCH /api/settings/info`.
3. **Recording** — Exclude duplicates (switch), Extend live recordings (switch),
   Auto-delete recordings (switch). Immediate PATCH each.
4. **Audio** — Audio transcoding: AC-3 (passthrough) / AAC toggle →
   `PATCH /api/settings/info {audio}`.
5. **Guide** — last updated (`last_update`), horizon (`limit`),
   `download_progress` if mid-update; **Update** button → calls the no-op route,
   shows a "not yet available" toast. Button present, not hidden.
6. **Location** — current state + postal/city; an input for US ZIP / CA postal
   with a Save that calls the no-op route (shows "not yet available"). Validates
   format client-side (5-digit ZIP or `A1A 1A1`).
7. **Channels** — lineup list with a checkbox per channel (checked = kept/
   visible, unchecked = hidden); a **Rescan** button that starts a scan, shows
   progress, lists discovered channels, and a **Save** that commits the checked
   set. Committing is the same array for both hide/show and post-scan keep.
8. **About Tablo** — Name (with inline rename → `PATCH /api/settings/name`),
   IP (`server/network.ip` / `local_address`), Serial (`server_id`), Firmware
   (`version` + `build_number`). Display + rename only.

### Behaviour

- Modal fetches `GET /api/settings/overview` on open; each section renders from
  its slice, tolerant of a `null` slice (show "unavailable").
- Toggle writes are optimistic with revert on error; the device echoes the full
  object so state resyncs from the response.
- No-op controls show a small "coming soon"/"not yet available" affordance so
  their inertness is intentional, not a bug.

## Testing

- Backend: pytest per route — allow-list validation (400 on bad key/value),
  overview tolerance (a failing sub-call → null slice, still 200), no-op routes
  return the noop shape, PATCH forwards exactly one key, commit forwards the
  array. Device stubbed via the existing test fixture.
- Frontend: the modal renders each section from a mocked overview; a toggle
  fires the right PATCH; LED 3-way sends the right value; rename posts the name;
  no-op buttons show the toast and send no device write; channel commit posts
  the checked array.

## Open items (revise later)

- Storage graph fidelity depends on whether `harddrives` carries free/used;
  spec renders capacity-only if not.
- Location-set and guide-refresh verbs: no-op until captured.
- `preferred_audio_track` write shape unmapped — not exposed in this page.
- Serial: `server_id` used as the serial (no distinct serial field observed).
