"""Background movie enrichment.

Walks the guide's untagged airings, asks TMDb whether each title is a movie,
caches the verdict, and tags the matching rows so the grid stops calling a
movie a "Live TV Event". A no-op without `TMDB_API_KEY`.
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

from . import store, tmdb

logger = logging.getLogger(__name__)

_POSITIVE_TTL = 30 * 86400   # a movie stays a movie
_NEGATIVE_TTL = 7 * 86400    # an unmatched title may match after a TMDb add
_running = False             # coalesce overlapping runs (guide refreshes often)


def _fresh(verdict: dict) -> bool:
    ttl = _POSITIVE_TTL if verdict.get("media_type") == "movie" else _NEGATIVE_TTL
    return (time.time() - (verdict.get("checked_at") or 0)) < ttl


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
    titles = await asyncio.to_thread(store.untagged_titles, limit)
    if not titles:
        return {"checked": 0, "tagged": 0, "cached": 0}

    sem = asyncio.Semaphore(4)
    stats = {"checked": 0, "tagged": 0, "cached": 0}
    client = httpx.AsyncClient()

    async def one(title: str) -> None:
        key = store.normalize_title(title)
        cached = await asyncio.to_thread(store.get_title_verdict, key)
        if cached and _fresh(cached):
            verdict = cached
            stats["cached"] += 1
        else:
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
        await asyncio.gather(*[one(t) for t in titles])
    finally:
        await client.aclose()
    logger.info("enrich: %s", stats)
    return stats
