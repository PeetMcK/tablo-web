"""One search endpoint behind three surfaces."""

from fastapi import APIRouter, HTTPException, Query

from .. import search as search_mod
from ..state import state

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
        return search_mod.search(q, limit=limit, kinds=wanted)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Search error: {e}")
