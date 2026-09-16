"""One search endpoint behind three surfaces."""

from fastapi import APIRouter, HTTPException, Query

from .. import search as search_mod
from ..state import _run_sync, state

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
async def search(
    q: str = Query("", description="What to look for"),
    limit: int = Query(5, description="Per kind, not overall"),
    kinds: str | None = Query(None, description="CSV filter, e.g. airing,recording"),
):
    """Ranked matches grouped by kind.

    A query shorter than two characters returns empty groups rather than 400:
    every surface calls this on each keystroke, and an error for "b" would mean
    each of them needing the same special case.
    """
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")
    wanted = [k for k in (s.strip() for s in kinds.split(",")) if k] if kinds else None
    try:
        # search_mod.search is pure blocking db.query/db.query_one - a
        # limit=50 request issues ~57 synchronous statements. Running that
        # inline on the event loop would stall every HLS segment this process
        # is also serving, for up to busy_timeout (5s), on every settled
        # keystroke from all three surfaces.
        return await _run_sync(search_mod.search, q, limit, wanted)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search error: {e}")
