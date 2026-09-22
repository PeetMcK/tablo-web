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
    # Fetch a wide set of untagged titles, then drop the ones already looked up
    # (fresh in the cache) so the run advances to titles we have not seen — a
    # cached non-movie stays untagged, and without this it would be re-selected
    # every run and block the window. `limit` caps the *network* lookups.
    all_titles = await asyncio.to_thread(store.untagged_titles, 2000)
    fresh = await asyncio.to_thread(store.fresh_title_keys)
    seen: set[str] = set()
    todo: list[str] = []
    for t in all_titles:
        key = store.normalize_title(t)
        if key in fresh or key in seen:
            continue
        seen.add(key)
        todo.append(t)
        if len(todo) >= limit:
            break
    if not todo:
        return {"checked": 0, "tagged": 0, "remaining": 0}

    sem = asyncio.Semaphore(4)
    stats = {"checked": 0, "tagged": 0}
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
    # How many untagged titles remain uncached after this run (roughly), so a
    # caller/loop knows whether to run again.
    remaining = max(0, len([t for t in all_titles
                            if store.normalize_title(t) not in fresh]) - len(todo))
    stats["remaining"] = remaining
    logger.info("enrich: %s", stats)
    return stats
