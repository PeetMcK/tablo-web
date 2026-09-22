"""TMDb classification, the title-lookup cache, and the enrichment runner."""
import pytest

from app import db, enrich, store, tmdb


# --- fake TMDb client ------------------------------------------------------

class _Resp:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


class _Client:
    """Routes by path substring; records nothing else."""
    def __init__(self, multi_results):
        self._multi = multi_results

    async def get(self, url, params=None, headers=None, timeout=None):
        if "/genre/movie/list" in url:
            return _Resp({"genres": [{"id": 53, "name": "Thriller"},
                                     {"id": 80, "name": "Crime"}]})
        if "/search/multi" in url:
            return _Resp({"results": self._multi})
        return _Resp({"results": []})

    async def aclose(self):
        pass


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setenv("TMDB_API_KEY", "test-key")
    monkeypatch.setattr(tmdb, "_genre_cache", None)
    monkeypatch.setattr(enrich, "_running", False)
    yield


MOVIE = {"media_type": "movie", "title": "The Next Three Days",
         "release_date": "2010-11-19", "genre_ids": [53, 80], "popularity": 20,
         "overview": "A man plans to break his wife out of prison."}
# A show of the same name that is *competitive* in popularity — the movie does
# not clearly dominate, so the pair stays ambiguous.
TV = {"media_type": "tv", "name": "The Next Three Days",
      "first_air_date": "2019-01-01", "genre_ids": [], "popularity": 15}
# A show the dominant movie clearly outweighs (Labyrinth-like: 20 vs 5).
TV_MINOR = {"media_type": "tv", "name": "The Next Three Days",
            "first_air_date": "2015-01-01", "genre_ids": [], "popularity": 5}


# --- classify_title --------------------------------------------------------

@pytest.mark.asyncio
async def test_classify_movie_match():
    v = await tmdb.classify_title("The Next Three Days", client=_Client([MOVIE]))
    assert v["media_type"] == "movie"
    assert v["year"] == 2010
    assert v["genres"] == ["Thriller", "Crime"]
    assert "prison" in v["overview"]


@pytest.mark.asyncio
async def test_classify_ambiguous_when_show_is_competitive():
    v = await tmdb.classify_title("The Next Three Days", client=_Client([MOVIE, TV]))
    assert v["media_type"] == "none"   # movie 20 < 2 * show 15


@pytest.mark.asyncio
async def test_classify_dominant_movie_beats_minor_show():
    v = await tmdb.classify_title("The Next Three Days",
                                  client=_Client([MOVIE, TV_MINOR]))
    assert v["media_type"] == "movie"  # 20 >= 5 and 20 >= 2 * 5


@pytest.mark.asyncio
async def test_classify_tv_only_is_none():
    v = await tmdb.classify_title("The Next Three Days", client=_Client([TV]))
    assert v["media_type"] == "none"


@pytest.mark.asyncio
async def test_classify_no_match_is_none():
    v = await tmdb.classify_title("Totally Unknown Thing", client=_Client([MOVIE]))
    assert v["media_type"] == "none"   # title doesn't match the result


@pytest.mark.asyncio
async def test_classify_disabled_without_key(monkeypatch):
    monkeypatch.delenv("TMDB_API_KEY", raising=False)
    monkeypatch.setattr(tmdb, "_KEY_FILE", "/nonexistent/themoviedb")
    v = await tmdb.classify_title("Anything", client=_Client([MOVIE]))
    assert v["media_type"] == "none"


# --- store cache + tagging -------------------------------------------------

_seed_n = 0


def _seed_airing(title, kind="", episode_title=None, series_path=None, desc=None):
    global _seed_n
    _seed_n += 1
    db.execute("INSERT OR IGNORE INTO guide_channel(identifier, updated_at) "
               "VALUES ('ch1', '2026-01-01')")
    db.execute(
        "INSERT OR REPLACE INTO guide_airing(channel_id, start, duration, "
        "end_epoch, title, description, genres, kind, episode_title, series_path) "
        "VALUES ('ch1', ?, 3600, 0, ?, ?, '[]', ?, ?, ?)",
        (f"2026-09-21T00:{_seed_n:02d}Z", title, desc, kind, episode_title, series_path),
    )


def test_title_verdict_round_trip():
    store.save_title_verdict("the film", {"media_type": "movie", "year": 2010,
                                          "genres": ["Crime"], "overview": "x"})
    v = store.get_title_verdict("the film")
    assert v["media_type"] == "movie" and v["genres"] == ["Crime"]
    store.save_title_verdict("nope", {"media_type": "none"})
    assert store.get_title_verdict("nope")["media_type"] == "none"


def test_untagged_titles_filters():
    _seed_airing("Movie One")                         # untagged -> candidate
    _seed_airing("An Episode", episode_title="Pilot")  # has episode -> excluded
    _seed_airing("Tagged", kind="sportEvent")          # typed -> excluded
    titles = store.untagged_titles()
    assert "Movie One" in titles
    assert "An Episode" not in titles and "Tagged" not in titles


def test_apply_movie_verdict_tags_only_untagged():
    _seed_airing("Movie One")
    _seed_airing("Movie One", desc="")  # a second untagged airing of same title
    n = store.apply_movie_verdict("Movie One", ["Crime"], "A heist.")
    assert n == 2
    row = db.query_one("SELECT kind, genres, description FROM guide_airing "
                       "WHERE title='Movie One' LIMIT 1")
    assert row["kind"] == "movieAiring"
    assert "Crime" in row["genres"] and row["description"] == "A heist."


# --- enrich runner ---------------------------------------------------------

@pytest.mark.asyncio
async def test_enrich_tags_movies(monkeypatch):
    _seed_airing("The Next Three Days")

    async def fake_classify(title, year=None, client=None):
        return {"media_type": "movie", "year": 2010,
                "genres": ["Thriller"], "overview": "Prison break."}
    monkeypatch.setattr(tmdb, "classify_title", fake_classify)

    stats = await enrich.enrich_untagged()
    assert stats["tagged"] == 1
    row = db.query_one("SELECT kind FROM guide_airing WHERE title=?",
                       ("The Next Three Days",))
    assert row["kind"] == "movieAiring"
    # Verdict cached — a second run hits the cache, not the network.
    stats2 = await enrich.enrich_untagged()
    assert stats2["tagged"] == 0   # nothing untagged remains


@pytest.mark.asyncio
async def test_enrich_skips_cached_and_advances(monkeypatch):
    # A cached non-movie must not be re-looked-up; the run advances to the
    # untagged title it has not seen.
    _seed_airing("Cached None")
    _seed_airing("A Movie")
    store.save_title_verdict(store.normalize_title("Cached None"), {"media_type": "none"})
    calls = []

    async def fake_classify(title, year=None, client=None):
        calls.append(title)
        return ({"media_type": "movie", "genres": ["Crime"], "overview": "x"}
                if title == "A Movie" else {"media_type": "none"})
    monkeypatch.setattr(tmdb, "classify_title", fake_classify)

    stats = await enrich.enrich_untagged()
    assert calls == ["A Movie"]      # Cached None skipped entirely
    assert stats["tagged"] == 1


@pytest.mark.asyncio
async def test_enrich_reapplies_cached_movie_without_network(monkeypatch):
    # A guide refresh wipes the enriched kind; the next run must re-tag the
    # movie from cache with no TMDb call.
    _seed_airing("Cached Movie")   # untagged (as if just refreshed)
    store.save_title_verdict(store.normalize_title("Cached Movie"),
                             {"media_type": "movie", "genres": ["Crime"],
                              "overview": "A heist."})
    calls = []

    async def fake_classify(title, year=None, client=None):
        calls.append(title)
        return {"media_type": "none"}
    monkeypatch.setattr(tmdb, "classify_title", fake_classify)

    stats = await enrich.enrich_untagged()
    assert calls == []                 # no network for a cached title
    assert stats["retagged"] == 1
    row = db.query_one("SELECT kind FROM guide_airing WHERE title='Cached Movie'")
    assert row["kind"] == "movieAiring"


@pytest.mark.asyncio
async def test_enrich_skips_without_key(monkeypatch):
    monkeypatch.delenv("TMDB_API_KEY", raising=False)
    monkeypatch.setattr(tmdb, "_KEY_FILE", "/nonexistent/themoviedb")
    assert await enrich.enrich_untagged() == {"skipped": "no api key"}
