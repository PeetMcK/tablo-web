"""Layout preferences: how a page is read, kept between visits.

Server-side for the reason resume positions are — a preference in one
browser's site data is lost on the next machine and cleared with the cookies.
"""

import pytest
from fastapi.testclient import TestClient

from app import store
from app.main import app
from app.routes import prefs as prefs_route

client = TestClient(app)


@pytest.fixture
def signed_in(monkeypatch):
    monkeypatch.setattr(type(prefs_route.state), "is_authenticated",
                        property(lambda _s: True))


def test_prefs_require_auth():
    assert client.get("/api/prefs").status_code == 401
    assert client.put("/api/prefs",
                      json={"key": "library.group", "value": "show"}).status_code == 401


def test_a_stored_choice_comes_back(signed_in):
    client.put("/api/prefs", json={"key": "library.group", "value": "show"})
    client.put("/api/prefs", json={"key": "library.sort", "value": "title"})

    assert client.get("/api/prefs").json() == {
        "library.group": "show", "library.sort": "title",
    }


def test_choosing_again_replaces_rather_than_accumulates(signed_in):
    client.put("/api/prefs", json={"key": "library.sort", "value": "title"})
    client.put("/api/prefs", json={"key": "library.sort", "value": "oldest"})

    assert client.get("/api/prefs").json() == {"library.sort": "oldest"}


def test_every_order_the_menu_offers_is_accepted(signed_in):
    """The allow-list and the menu have to agree — a sort the page offers and
    the server refuses is a control that silently does nothing."""
    for value in ("newest", "oldest", "episode", "title", "title-desc"):
        r = client.put("/api/prefs", json={"key": "library.sort", "value": value})
        assert r.status_code == 200, value
        assert client.get("/api/prefs").json()["library.sort"] == value


def test_an_unknown_preference_is_refused(signed_in):
    """Not a general key-value store for the client. A typo that stored a row
    nobody ever reads again is a worse answer than a 422."""
    r = client.put("/api/prefs", json={"key": "library.colour", "value": "teal"})

    assert r.status_code == 422
    assert client.get("/api/prefs").json() == {}


def test_a_value_outside_the_menu_is_refused(signed_in):
    """These are written straight from a menu and read straight back into a
    layout: a value the page cannot render must never reach the table."""
    r = client.put("/api/prefs", json={"key": "library.group", "value": "genre"})

    assert r.status_code == 422
    assert client.get("/api/prefs").json() == {}


def test_a_value_that_has_since_been_retired_is_not_answered_with(signed_in):
    """Removing an option from a menu leaves rows behind. Answering with one
    would put a layout on screen that no longer exists."""
    store.save_pref("library.group", "day")
    monkey = dict(store.PREF_KEYS)
    monkey["library.group"] = ("show", "channel")
    original, store.PREF_KEYS = store.PREF_KEYS, monkey
    try:
        assert client.get("/api/prefs").json() == {}
    finally:
        store.PREF_KEYS = original


def test_nothing_chosen_yet_is_an_empty_answer(signed_in):
    """The page falls back to its own defaults rather than being handed them."""
    assert client.get("/api/prefs").json() == {}


def test_the_library_layout_is_remembered(signed_in):
    """Cards or rows is how this person reads the page, not a question they
    are asking today - so it outlives the visit, as group and sort do."""
    assert client.put("/api/prefs",
                      json={"key": "library.layout", "value": "list"}).status_code == 200

    assert client.get("/api/prefs").json()["library.layout"] == "list"


def test_a_layout_nobody_offers_is_refused(signed_in):
    r = client.put("/api/prefs", json={"key": "library.layout", "value": "mosaic"})

    assert r.status_code == 422
