# TMDb Movie Enricher — Spec + Plan

**Date:** 2026-09-21
**Goal:** Untagged guide airings (empty `kind`, no episode info — the ones the guide shows as "Live TV Event") are looked up by title against TMDb; when a title resolves to a **movie**, the airing is tagged `movieAiring` with real genres/overview, so the guide labels it correctly. Systemic (fixes the data), not a per-view label patch.

## Why
The device/cloud leaves some airings untyped (a FAST movie channel like MOVIES! GOLD 8.7 delivers movies with empty `kind` and no description). The grid then falls back to "Live TV Event". No local signal distinguishes these movies from genuine live events; an external title lookup does.

## Source: TMDb
- REST, free API key. `GET https://api.themoviedb.org/3/search/multi?query=<title>&include_adult=false` returns results each with `media_type` (`movie`|`tv`|`person`), `title`/`name`, `release_date`/`first_air_date`, `genre_ids`, `popularity`, `overview`.
- Genre id→name: `GET /genre/movie/list` once (cache in memory); or a static map. Use the endpoint, cached per process.
- **Key**: `TMDB_API_KEY` from env. Absent → enricher is a no-op (feature off, nothing else changes).

## Global Constraints
- Worktree; TDD. Backend ruff + pytest green (mock httpx — **no live network in tests**). Frontend tsc + vitest + build.
- **Privacy**: only program *titles* leave the network. Never send device/server id, location, or account data. Log titles only, never the key.
- Conservative matching — a TV show must never be tagged a movie. Better to leave "Live TV Event" than to mislabel.
- Gentle on TMDb: bounded concurrency, cached so each distinct title is queried once.

## Backend

### 1. `app/tmdb.py` — the lookup
- `TMDB_API_KEY = os.environ.get("TMDB_API_KEY")`; `enabled() -> bool`.
- `async def classify_title(title: str, year: int | None = None) -> Verdict` where
  `Verdict = {"media_type": "movie"|"none", "year": int|None, "genres": list[str], "overview": str|None}`.
  - Query `search/multi`. Normalize titles for comparison: lowercase, strip punctuation, drop a trailing `(YYYY)`.
  - **Rule (conservative):** find results whose normalized title/name equals the query. If among those there is a `movie` and **no** `tv` exact match → movie (take the most popular movie). If both a movie and a tv exact match exist → `none` (ambiguous, leave alone). If only tv → `none`. If no exact match → `none`.
  - If `year` given and a movie candidate's release year is known, prefer the year match; a mismatch by >1 doesn't disqualify but de-prioritises.
  - Map `genre_ids` → names via the cached movie-genre map.
  - Network/HTTP error → raise; caller treats as "unknown, don't cache".

### 2. `store` cache — `title_lookup`
- Migration: `CREATE TABLE IF NOT EXISTS title_lookup(title_key TEXT PRIMARY KEY, media_type TEXT, year INTEGER, genres TEXT, overview TEXT, checked_at REAL)`.
- `title_key` = normalized title. `media_type` is `"movie"` or `"none"` (negative cached too).
- `get_title_verdict(title_key) -> row|None`; `save_title_verdict(title_key, verdict)`.
- TTL applied by the caller: positive verdicts good for 30d, negatives 7d (a show could get a movie remake, and a title unmatched today may match after a TMDb add).
- `untagged_titles(limit) -> list[str]`: distinct `guide_airing.title` where `kind` IS '' or NULL AND `episode_title` IS NULL AND `series_path` IS NULL AND `title` IS NOT NULL. (These are the "could be a movie" rows.)
- `apply_movie_verdict(title, genres, overview) -> int`: `UPDATE guide_airing SET kind='movieAiring', genres=?, description=COALESCE(NULLIF(description,''), ?) WHERE title=? AND (kind='' OR kind IS NULL)`. Returns rows updated.

### 3. `app/enrich.py` — the runner
- `async def enrich_untagged(limit: int = 100) -> dict`:
  - If not `tmdb.enabled()`: return `{"skipped": "no api key"}`.
  - `titles = store.untagged_titles(limit)`.
  - For each title: check cache (respect TTL). On miss, `tmdb.classify_title`; save verdict (positive or negative). On a movie verdict, `store.apply_movie_verdict`.
  - Bounded `asyncio.Semaphore(4)`. A per-title error is swallowed (logged, not cached) so one bad title doesn't stop the run.
  - Returns counts `{checked, tagged, cached_hits}`.
- Hook: after each `store.save_guide` in `state.get_grid_guide` / `stream_grid_guide_data`, schedule `enrich_untagged()` **fire-and-forget** (`asyncio.create_task`, guarded by `enabled()`), so it never delays the guide. Also expose `POST /api/guide/enrich` (auth) to run it on demand for testing.

## Frontend
- `GuideGridView` subtitle: `air.description || (kind==="movieAiring" ? "Movie" : kind==="sportEvent" ? "Live TV Event" : genres.join(" · ") || "")`; render nothing when empty. (Same shape as the reverted patch, but now the data behind `movieAiring` is real.)
- Movies filter already keys on `kind==="movieAiring"`, so enriched movies now appear under the Movies filter too — no change needed.

## Testing
- `tmdb.classify_title` (mock httpx): exact movie match → movie + genres; movie+tv both exact → none; tv only → none; no match → none; genre mapping.
- `store`: title_lookup round-trip incl. negative; `untagged_titles` filters correctly; `apply_movie_verdict` updates only untagged rows and preserves an existing description.
- `enrich_untagged` (mock tmdb + in-memory store): tags a movie title, caches a negative, skips when key absent.
- Frontend: movieAiring → "Movie", sportEvent → "Live TV Event", untagged empty → no subtitle.

## Out of scope
- Poster/artwork from TMDb (device art stays). Person/actor lookups. Re-tagging already-typed rows. Fuzzy matching beyond exact normalized title (kept strict to avoid false movies).

## Ops
- Document `TMDB_API_KEY` in `backend/run-native.sh`. Feature is entirely off without it.
