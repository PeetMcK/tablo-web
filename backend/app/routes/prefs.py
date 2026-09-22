"""How the viewer likes a page laid out.

Small, durable choices the UI makes on someone's behalf and should not forget:
how the Library groups its cards, what it sorts them by. Kept server-side for
the reason resume positions are — a preference tied to one browser's site data
is a preference lost on the next machine, and cleared by anything that clears
cookies.

Deliberately not everything the toolbar holds. A search box and a content
filter are momentary: they answer "show me this, now", and restoring them a day
later would open the Library on a question nobody asked. A layout is the
opposite — it is how this person reads the page, and it should be there when
they come back.

Keys are namespaced by page (`library.group`), values are short strings. This
is not a general key-value store for the client: the allow-list below is the
whole of it, so a typo is a 422 rather than a row nobody ever reads again.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import store
from ..state import _run_sync, state

router = APIRouter(prefix="/api/prefs", tags=["prefs"])


class PrefIn(BaseModel):
    key: str
    value: str


def _require_auth() -> None:
    if not state.is_authenticated:
        raise HTTPException(status_code=401, detail="Not authenticated")


@router.get("")
async def list_prefs():
    """Every stored preference, in one call.

    The client reads this once on load and holds it: a page that asked per key
    would be several round trips deep before it could draw its own toolbar.
    """
    _require_auth()
    return await _run_sync(store.all_prefs)


@router.put("")
async def put_pref(body: PrefIn):
    """Remember one choice.

    Unknown keys and values are refused rather than stored. What the UI offers
    is a closed set, and a stored value outside it would come back as a layout
    the page cannot render.
    """
    _require_auth()
    if body.key not in store.PREF_KEYS:
        raise HTTPException(status_code=422, detail=f"Unknown preference: {body.key}")
    if body.value not in store.PREF_KEYS[body.key]:
        raise HTTPException(
            status_code=422,
            detail=f"{body.key} cannot be {body.value!r}",
        )
    await _run_sync(store.save_pref, body.key, body.value)
    return {"ok": True}
