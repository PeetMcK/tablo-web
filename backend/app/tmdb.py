"""TMDb title lookup — is a programme title a movie?

The device leaves some airings untyped, and a FAST movie channel serves movies
with no metadata at all. TMDb can say whether a title is a movie or a TV show;
this module asks, conservatively, so a show is never mislabelled a movie.

Only the title leaves the network. The API key is read from `TMDB_API_KEY`;
without it the module is disabled and every caller no-ops.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import httpx

from . import store

logger = logging.getLogger(__name__)

_BASE = "https://api.themoviedb.org/3"
_genre_cache: dict[int, str] | None = None

# When a title matches both a movie and a show, tag the movie only if it clearly
# dominates: at least this popular, and at least this many times the show's.
_MIN_MOVIE_POP = 5.0
_DOMINANCE = 2.0

# Where the key may live, in order: the env var, an explicit file, then a
# conventional dotfile. A file keeps the secret out of the process listing and
# shell history; only its first line is read.
_KEY_FILE = os.environ.get("TMDB_API_KEY_FILE") or "~/.config/themoviedb"


def api_key() -> str | None:
    env = os.environ.get("TMDB_API_KEY")
    if env:
        return env.strip() or None
    try:
        text = Path(_KEY_FILE).expanduser().read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Accept a bare key or a `NAME=value` line (e.g. `APIKey=…`).
        value = line.split("=", 1)[1] if "=" in line else line
        return value.strip().strip('"').strip("'") or None
    return None


def enabled() -> bool:
    return bool(api_key())


def _auth(params: dict) -> tuple[dict, dict]:
    """Return (params, headers). A v4 token (a long JWT) goes in a Bearer
    header; a v3 key goes in the query string."""
    key = api_key() or ""
    if key.startswith("ey") and key.count(".") == 2:
        return params, {"Authorization": f"Bearer {key}"}
    return {**params, "api_key": key}, {}


async def _get(client: httpx.AsyncClient, path: str, params: dict) -> dict:
    p, headers = _auth(params)
    r = await client.get(f"{_BASE}{path}", params=p, headers=headers, timeout=15)
    r.raise_for_status()
    return r.json()


async def _genre_map(client: httpx.AsyncClient) -> dict[int, str]:
    global _genre_cache
    if _genre_cache is None:
        data = await _get(client, "/genre/movie/list", {"language": "en-US"})
        _genre_cache = {g["id"]: g["name"] for g in data.get("genres") or []}
    return _genre_cache


def _none() -> dict:
    return {"media_type": "none", "year": None, "genres": [], "overview": None}


async def classify_title(title: str, year: int | None = None,
                         client: httpx.AsyncClient | None = None) -> dict:
    """Classify a title. Returns a verdict dict; `media_type` is "movie" only
    when TMDb has a movie whose title matches exactly and no TV show matches the
    same title (ambiguous → left as "none"). Raises on a network/HTTP error, so
    the caller can decline to cache an unknown."""
    if not enabled():
        return _none()
    own = client is None
    client = client or httpx.AsyncClient()
    try:
        data = await _get(client, "/search/multi",
                          {"query": title, "include_adult": "false", "language": "en-US"})
        results = data.get("results") or []
        qkey = store.normalize_title(title)
        movies = [r for r in results if r.get("media_type") == "movie"
                  and store.normalize_title(r.get("title") or "") == qkey]
        tv = [r for r in results if r.get("media_type") == "tv"
              and store.normalize_title(r.get("name") or "") == qkey]
        if not movies:
            return _none()
        # A title can match both a movie and a show (e.g. "Labyrinth" — the 1986
        # film and later miniseries). The enricher only ever sees *untyped*
        # airings; a series broadcast arrives tagged with episode/series info
        # and is excluded upstream, so a clearly-dominant movie here is the film.
        # Tag it only when the movie clearly outweighs the show, else leave it.
        if tv:
            mv = max((m.get("popularity") or 0) for m in movies)
            tvp = max((t.get("popularity") or 0) for t in tv)
            if not (mv >= _MIN_MOVIE_POP and mv >= _DOMINANCE * tvp):
                return _none()
        # Prefer a year match when we have one, else the most popular movie.
        def score(m: dict) -> tuple:
            my = (m.get("release_date") or "")[:4]
            year_ok = bool(year) and my.isdigit() and abs(int(my) - year) <= 1
            return (year_ok, m.get("popularity") or 0)
        best = max(movies, key=score)
        gm = await _genre_map(client)
        my = (best.get("release_date") or "")[:4]
        return {
            "media_type": "movie",
            "year": int(my) if my.isdigit() else None,
            "genres": [gm[g] for g in (best.get("genre_ids") or []) if g in gm],
            "overview": (best.get("overview") or None),
        }
    finally:
        if own:
            await client.aclose()
