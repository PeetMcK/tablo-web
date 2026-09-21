# Series Channel Scope — Spec + Plan

**Date:** 2026-09-21
**Goal:** Let a series' recording rule be limited to one channel, or record on all channels (the Tablo app's "record on all channels vs a specific channel"). Adds a Channel control to the Series Detail settings.

## Device model (probed 2026-09-21, verified — do not re-derive)
- The guide-series schedule carries **`channel_path`**: `"/guide/channels/{n}"` to pin the rule to one channel, or `null` for all. (Docs mention `channel_identifier`; that write **400s** on this firmware — `channel_path` is the field, verified 200 both directions.)
- Write: `PATCH {guide_series_path} {"schedule": {"channel_path": "/guide/channels/5802" | null}}` → 200.
- A channel object `GET /guide/channels/{n}` → `{path, object_id, channel:{call_sign, major, minor, network, channel_identifier, …}}`.
- The channels a series airs on come from its airings: `{guide_path}/episodes` → batch → distinct `airing_details.channel` (`{path, channel:{call_sign, major, minor}}`).

## Global Constraints
- Worktree; TDD. Backend ruff + pytest green (main venv). Frontend tsc + vitest + build; eslint no new errors.
- Batch reads chunk to ≤48 via the existing `_batch_resolve` (device caps `/batch` at 50).
- Allow-list any device path we forward (`^/guide/channels/\d+$`), like `_GUIDE_PATH`/`_REC_PATH`.
- Settings write already targets `guide_path` (the series path); this rides the same PATCH.

## Backend (`backend/app/routes/series.py`)
1. **`_CHANNEL_PATH` regex** `^/guide/channels/\d+$`.
2. **`GET /series/channels?guide_path=`** → `list[ChannelOption]`, the distinct channels the series airs on.
   - `ChannelOption = {path: str, call_sign: str|None, number: str|None}` where `number` is `"{major}.{minor}"`.
   - Fetch `{guide_path}/episodes` (guide path allow-listed), `_batch_resolve`, collect distinct `airing_details.channel.path`, read `call_sign`/`major`/`minor` from the nested `channel`. Sort by number. Tolerant → `[]` on failure.
3. **`SeriesSettingsIn.channel_path: str | None`** (optional, sentinel-aware — see below). When present, PATCH `{"schedule": {"channel_path": value}}` via `_patch_guide`. Value must be `null` or match `_CHANNEL_PATH` (else 400).
   - Because `None` is also "not provided", use a distinct absent sentinel: the field defaults to a module constant `_UNSET`; only write when it isn't `_UNSET`. (Pydantic: use `channel_path: str | None = None` plus `model_fields_set` to tell "sent null" from "omitted".)
4. **`series_detail` / `_series_detail_by_guide`** settings gain `channel_path` (from `schedule.channel_path`).

## Frontend
5. **`api/tablo.ts`**: `SeriesSettings.channel_path: string | null`; `SeriesUpdate.channel_path?: string | null`; `ChannelOption` type; `api.series.channels(guidePath)`.
6. **`SeriesDetail.tsx`**: a **Channel** row under Recording — a dropdown "All channels" + one option per candidate (`{call_sign} {number}`). Shown only when candidates load (≥1). Value = current `settings.channel_path` or `"all"`. `onChange` → `update.mutate({identifier, guide_path, channel_path})` (optimistic like rule). If the current `channel_path` isn't among candidates, add it as a fallback option labelled by its number if resolvable, else "Pinned channel". Query enabled only when the settings section is visible and `guidePath` exists.
7. Only render when `canConfigure` (has guide_path).

## Testing
- Backend: `/series/channels` returns distinct sorted channels from mixed airings; a channel-only-in-one-airing still appears; failure → `[]`. Settings write with `channel_path="/guide/channels/5"` PATCHes `{"schedule":{"channel_path":"/guide/channels/5"}}`; with `null` PATCHes null; omitted → no channel write; a non-channel path → 400.
- Frontend: `lib`/component — the Channel dropdown lists All + candidates, selecting a channel calls update with its path, "All channels" calls update with null.

## Out of scope
- Per-airing channel override; channel scope for movies/sports (schedule-less kinds — hide the control when no guide schedule).
