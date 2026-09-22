"""Background movie enrichment.

Walks the guide's untagged airings, asks TMDb whether each title is a movie,
caches the verdict, and tags the matching rows so the grid stops calling a
movie a "Live TV Event". A no-op without `TMDB_API_KEY`.
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from . import store, tmdb

logger = logging.getLogger(__name__)

_running = False             # coalesce overlapping runs (guide refreshes often)


async def enrich_untagged(limit: int = 100) -> dict:
    """Look up untagged titles and tag the movies. Returns run counts."""
    global _running
    if not tmdb.enabled():
        return {"skipped": "no api key"}
    if _running:
        return {"skipped": "already running"}
    _running = True
    try:
        return await _run(limit)
    finally:
        _running = False


def schedule(limit: int = 100) -> None:
    """Fire-and-forget a run from within an async context (e.g. after a guide
    save). No-op without a key or when a run is already in flight."""
    if not tmdb.enabled() or _running:
        return
    try:
        asyncio.get_running_loop().create_task(enrich_untagged(limit))
    except RuntimeError:
        pass  # no running loop; nothing to schedule onto


async def _run(limit: int) -> dict:
    # A guide refresh (INSERT OR REPLACE from the device) wipes the enriched
    # `kind`, so every run must first RE-APPLY cached movie verdicts — no
    # network — to re-tag what a refresh un-tagged. Only titles with no fresh
    # verdict at all are looked up (capped by `limit`); cached non-movies are
    # skipped so the network window advances to genuinely new titles.
    all_titles = await asyncio.to_thread(store.untagged_titles, 2000)
    movies = await asyncio.to_thread(store.cached_movie_verdicts)
    fresh = await asyncio.to_thread(store.fresh_title_keys)

    retagged = 0
    seen: set[str] = set()
    todo: list[str] = []
    for t in all_titles:
        key = store.normalize_title(t)
        if key in seen:
            continue
        seen.add(key)
        if key in movies:                       # cached movie -> re-tag now
            n = await asyncio.to_thread(
                store.apply_movie_verdict, t,
                movies[key]["genres"], movies[key]["overview"])
            if n:
                retagged += 1
        elif key not in fresh and len(todo) < limit:
            todo.append(t)                       # unknown -> look up (capped)

    sem = asyncio.Semaphore(4)
    stats = {"checked": 0, "tagged": 0, "retagged": retagged}
    client = httpx.AsyncClient()

    async def one(title: str) -> None:
        key = store.normalize_title(title)
        async with sem:
            try:
                verdict = await tmdb.classify_title(title, client=client)
            except Exception as e:  # unknown — don't cache, try again next run
                logger.warning("tmdb lookup failed for %r: %s", title, e)
                return
        await asyncio.to_thread(store.save_title_verdict, key, verdict)
        stats["checked"] += 1
        if verdict.get("media_type") == "movie":
            n = await asyncio.to_thread(
                store.apply_movie_verdict, title,
                verdict.get("genres") or [], verdict.get("overview"))
            if n:
                stats["tagged"] += 1

    try:
        await asyncio.gather(*[one(t) for t in todo])
    finally:
        await client.aclose()
    remaining = max(0, len([t for t in all_titles
                            if store.normalize_title(t) not in fresh]) - len(todo))
    stats["remaining"] = remaining
    logger.info("enrich: %s", stats)
    return stats
