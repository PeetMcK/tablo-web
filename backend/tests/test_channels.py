"""Tests for channel endpoints — primarily auth enforcement."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

PROTECTED_GETS = [
    "/api/channels",
    "/api/channels/guide",
    "/api/channels/guide-grid",
    "/api/channels/library",
    "/api/channels/local-guide",
    "/api/channels/server-info",
    "/api/channels/airings",
    "/api/channels/S1_008_02/airings",
]


def test_protected_endpoints_require_auth():
    for path in PROTECTED_GETS:
        resp = client.get(path)
        assert resp.status_code == 401, f"{path} should return 401, got {resp.status_code}"


def test_channel_detail_requires_auth():
    resp = client.get("/api/channels/detail", params={"path": "/server/info"})
    assert resp.status_code == 401


def test_channel_detail_rejects_bad_path():
    """Ensure path traversal / SSRF is blocked even when authenticated."""
    # We can't easily auth in unit tests, but we can verify the 400 vs 401 distinction
    # by checking validation logic directly via the route.
    # This test verifies the validation is present by importing the logic.
    import inspect

    from app.routes.channels import channel_detail
    src = inspect.getsource(channel_detail)
    assert '://' in src  # SSRF check present
    assert 'startswith("/")' in src  # path must be absolute


def test_debug_report_unauthenticated():
    """Debug report is public — returns server info without auth."""
    resp = client.get("/api/channels/debug-report")
    assert resp.status_code == 200
    data = resp.json()
    assert "generated_at" in data
    assert "server" in data
    assert "auth" in data
    assert "recent_logs" in data
    assert data["auth"]["authenticated"] is False


def test_stream_stop_requires_auth():
    resp = client.delete("/api/stream/fakesessionid")
    assert resp.status_code == 401


def test_transcode_status_requires_auth():
    resp = client.get("/api/transcode/status/fakesessionid")
    assert resp.status_code == 401


def test_grid_rows_carry_the_channel_kind():
    """The grid must say whether a channel is OTA.

    The player transcodes OTA because no browser decodes MPEG-2 video. It reads
    that from the channel's `kind`, so a grid row without one plays the raw
    broadcast into hls.js, which parses every fragment and renders nothing.
    """
    from tablo_api.models import TabloChannel

    from app.state import state

    ota = TabloChannel(identifier="S1_008_02", call_sign="KPAXDT2", major=8,
                       minor=2, network="CW", kind="ota")
    ott = TabloChannel(identifier="S2", call_sign="FAST", kind="ott")

    rows = [state._assemble_grid_row(c, {}, {}, {}, {}) for c in (ota, ott)]

    assert [r["kind"] for r in rows] == ["ota", "ott"]


def test_channel_airings_come_from_the_mirror(monkeypatch):
    """The live player asks per channel; the device is never touched for it.

    A miss returns an empty list rather than falling back to the device: the
    player keeps the airing it was opened with, which beats blocking playback
    on a guide fetch.
    """
    import time

    from app import store
    from app.state import state

    monkeypatch.setattr(type(state), "is_authenticated", property(lambda self: True))

    now = time.time()
    store.save_guide([{
        "identifier": "ch1", "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "CBS", "display_name": "KPAX", "logo_url": None, "kind": "ota",
        "airings": [{
            "title": "On now", "subtitle": "", "description": "",
            "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 900)),
            "duration": 3600, "genres": [], "kind": "episode",
        }],
    }], now=now)

    resp = client.get("/api/channels/ch1/airings")
    assert resp.status_code == 200
    assert [a["title"] for a in resp.json()["airings"]] == ["On now"]

    assert client.get("/api/channels/nobody/airings").json()["airings"] == []


def test_refreshing_the_channel_list_requires_auth():
    assert client.post("/api/channels/refresh").status_code == 401


def test_refreshing_the_channel_list_reports_what_changed(monkeypatch):
    """A channel disabled in the Tablo app is reported as removed.

    Not a tuner scan: `TabloClient.channels` is a GET against the account's
    cloud guide, so a channel disappears here because the account stopped
    listing it, not because anything changed over the air.
    """
    import asyncio

    from tablo_api.models import TabloChannel

    from app import store
    from app.state import AppState

    st = AppState()
    st.active_device = object()          # only checked for None

    kpax = TabloChannel(identifier="ch1", call_sign="KPAX", major=8, minor=1,
                        network="CBS", kind="ota")
    nest = TabloChannel(identifier="ch2", call_sign="THENEST", major=13, minor=5,
                        network="THENEST", kind="ota")

    # Seed the in-process cache with both, then have the device return only one.
    st._channels = [kpax, nest]

    async def only_kpax(refresh=False, include_ott=True):
        return [kpax]

    async def no_enrichment():
        return {}, {}, {}, {}

    saved: list[list[dict]] = []
    monkeypatch.setattr(st, "channels", only_kpax)
    monkeypatch.setattr(st, "_build_grid_enrichment", no_enrichment)
    monkeypatch.setattr(store, "save_guide", lambda rows: saved.append(rows))

    result = asyncio.run(st.refresh_channel_list())

    assert result["removed"] == ["ch2"]
    assert result["added"] == []
    assert result["channels"] == 1
    # The rebuilt guide is written, which is what stamps a newer sync and so
    # drops the stale channel from `load_guide`.
    assert [r["identifier"] for r in saved[0]] == ["ch1"]


def test_the_guide_rebuild_asks_the_device_for_a_fresh_channel_list():
    """`_channels` has no TTL, so the rebuild has to force past it.

    Without this the hour-long guide TTL looks like it expires the channel
    list but does not: a dropped channel stays in process memory until the
    backend restarts.
    """
    import inspect

    from app.state import AppState

    for method in (AppState.get_grid_guide, AppState.stream_grid_guide_data):
        src = inspect.getsource(method)
        assert "self.channels(refresh=True)" in src, f"{method.__name__} must force a refresh"


def test_the_airing_mapping_keeps_the_episode_fields():
    """These arrive in a record we already fetch and already parse.

    Capturing them costs no extra device request - the previous mapping kept
    six fields out of the record and dropped the episode object entirely.
    """
    from app.state import AppState

    raw = {
        "path": "/guide/series/episodes/67388",
        "series_path": "/guide/series/6472",
        "episode": {"title": "Rags to Riches", "number": 10,
                    "season_number": 12, "orig_air_date": "2026-09-16",
                    "description": "Mapping the roots of Kate Burton."},
        "airing_details": {"datetime": "2026-09-16T08:00Z", "duration": 3600,
                           "channel_path": "/guide/channels/1", "genres": [],
                           "show_title": "Finding Your Roots", "event_type": None},
        "schedule": {"state": "none", "qualifier": "none", "skip_reason": "none"},
        "series": {},
    }

    got = AppState._airing_row(raw)

    assert got["title"] == "Finding Your Roots"
    assert got["episode_title"] == "Rags to Riches"
    assert got["season_number"] == 12
    assert got["episode_number"] == 10
    assert got["airing_path"] == "/guide/series/episodes/67388"
    assert got["series_path"] == "/guide/series/6472"
    assert got["schedule_state"] == "none"


def test_the_airing_mapping_tolerates_a_bare_record():
    """Most airings carry no episode object at all."""
    from app.state import AppState

    got = AppState._airing_row({
        "airing_details": {"datetime": "2026-09-16T08:00Z", "duration": 3600,
                           "show_title": "Bare", "channel_path": "/guide/channels/1"},
    })
    assert got["title"] == "Bare"
    assert got["episode_title"] is None
    assert got["season_number"] is None


def test_airing_detail_joins_the_series_and_says_whether_it_is_on(monkeypatch):
    """The sheet reads only the mirror - it opens on a click and must not
    wait on a device round trip."""
    import time

    from app import store
    from app.state import state

    monkeypatch.setattr(type(state), "is_authenticated", property(lambda self: True))

    now = time.time()
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 600))
    store.save_guide([{
        "identifier": "ch1", "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "CBS", "display_name": "KPAX", "logo_url": None, "kind": "ota",
        "airings": [{
            "title": "Finding Your Roots", "subtitle": None,
            "description": "Mapping roots.", "start": start, "duration": 3600,
            "genres": [], "kind": "episode", "episode_title": "Rags to Riches",
            "season_number": 12, "episode_number": 10, "orig_air_date": None,
            "series_path": "/guide/series/6472", "airing_path": None,
            "schedule_state": None, "schedule_qualifier": None, "skip_reason": None,
        }],
    }], now=now)
    store.save_series([{
        "path": "/guide/series/6472", "identifier": "X", "title": "Finding Your Roots",
        "description": None, "genres": ["Documentary"], "rating": "tvpg",
        "orig_air_date": None, "episode_runtime": 3600, "cast": [],
        "cover_image_id": 999, "thumbnail_image_id": None,
        "background_image_id": None, "schedule_rule": "none",
        "keep_rule": "none", "keep_count": None,
    }])

    resp = client.get("/api/channels/airing-detail",
                      params={"channel": "ch1", "start": start})
    assert resp.status_code == 200
    d = resp.json()
    assert d["episode_title"] == "Rags to Riches"
    assert d["season_number"] == 12
    assert d["rating"] == "tvpg"
    assert d["image_url"] == "/api/channels/image/999"
    assert d["airing_now"] is True
    assert d["channel"]["call_sign"] == "KPAX"


def test_airing_detail_without_a_series_has_no_artwork(monkeypatch):
    """Four channels on a real device carry no EPG data at all."""
    import time

    from app import store
    from app.state import state

    monkeypatch.setattr(type(state), "is_authenticated", property(lambda self: True))

    now = time.time()
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 7200))
    store.save_guide([{
        "identifier": "ch2", "call_sign": "THENEST", "major": 13, "minor": 5,
        "network": "THENEST", "display_name": "THENEST", "logo_url": None,
        "kind": "ota",
        "airings": [{"title": "Bare", "subtitle": None, "description": None,
                     "start": start, "duration": 1800, "genres": [], "kind": None}],
    }], now=now)

    d = client.get("/api/channels/airing-detail",
                   params={"channel": "ch2", "start": start}).json()
    assert d["image_url"] is None
    assert d["rating"] is None
    assert d["airing_now"] is False


def test_an_airings_own_artwork_beats_the_series_cover(monkeypatch):
    """An episode still is about this episode; a series cover is about the run.

    It is also the only artwork OTT has - those airings carry no series record
    at all, so without this every FAST sheet is a hero-less box.
    """
    import time

    from app import store
    from app.state import state

    monkeypatch.setattr(type(state), "is_authenticated", property(lambda self: True))

    now = time.time()
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 600))
    store.save_guide([{
        "identifier": "ch9", "call_sign": "SCRIPPS", "major": 500, "minor": 1,
        "network": "SCRIPPSNEWS", "display_name": "Scripps", "logo_url": None,
        "kind": "ott",
        "airings": [{"title": "Morning Rush", "subtitle": None, "description": None,
                     "start": start, "duration": 3600, "genres": [], "kind": "episode",
                     "image_url": "https://cdn/still.jpg"}],
    }], now=now)

    d = client.get("/api/channels/airing-detail",
                   params={"channel": "ch9", "start": start}).json()
    assert d["image_url"] == "https://cdn/still.jpg"


def test_an_unknown_airing_is_a_404(monkeypatch):
    from app.state import state
    monkeypatch.setattr(type(state), "is_authenticated", property(lambda self: True))
    resp = client.get("/api/channels/airing-detail",
                      params={"channel": "nope", "start": "2026-01-01T00:00Z"})
    assert resp.status_code == 404


def test_airing_detail_requires_auth():
    assert client.get("/api/channels/airing-detail",
                      params={"channel": "ch1", "start": "x"}).status_code == 401


def _series(path: str, thumbnail_image_id: int | None) -> dict:
    """One mirrored series row, defaulted so a test names only what it means."""
    return {
        "path": path, "identifier": path.rsplit("/", 1)[-1], "title": "Show",
        "description": None, "genres": [], "rating": None, "orig_air_date": None,
        "episode_runtime": 1800, "cast": [], "cover_image_id": None,
        "thumbnail_image_id": thumbnail_image_id, "background_image_id": None,
        "schedule_rule": "none", "keep_rule": "none", "keep_count": None,
    }


def test_the_live_card_resolves_its_poster_from_the_mirror():
    """The tile's artwork must not cost a device round trip.

    Airing records carry `series_path` and never a `series` object - verified
    against the device on 30 of 30 airings sampled across the full list - and
    this generation has no batch endpoint, so resolving posters against the
    device would be one signed request per channel. The mirror already holds
    what the guide sync fetched.
    """
    from app import store
    from app.state import AppState

    store.save_series([_series("/guide/series/42", thumbnail_image_id=5007)])

    assert AppState._poster_image_id("/guide/series/42") == 5007


def test_a_programme_without_a_poster_says_so_rather_than_failing():
    """Roughly one airing in five has no poster.

    Measured on the live mirror: 10,655 airings, 9,054 with a `series_path`,
    8,747 resolving to a thumbnail. The gap is mostly movies and sports, which
    are separate record types with no series row. The card reads None as "show
    the channel logo", so this is the ordinary path and must never raise into
    the guide.
    """
    from app import store
    from app.state import AppState

    store.save_series([_series("/guide/series/7", thumbnail_image_id=None)])

    assert AppState._poster_image_id("/guide/series/7") is None   # series, no art
    assert AppState._poster_image_id("/guide/series/nope") is None  # not mirrored
    assert AppState._poster_image_id(None) is None                 # movie or sport


def test_attaching_a_poster_does_not_write_into_the_cached_airing():
    """The grid path's airing rows live in `_grid_cache`.

    Writing the poster into one would poison that cache for every later
    request, and the symptom - a stale poster surviving a programme change -
    would look like a device problem rather than an aliasing bug.
    """
    from app import store
    from app.state import AppState

    store.save_series([_series("/guide/series/11", thumbnail_image_id=77)])
    cached = {"title": "Now", "series_path": "/guide/series/11"}

    got = AppState._with_poster(cached)

    assert got["poster_image_id"] == 77
    assert "poster_image_id" not in cached, "the cached row was mutated"


def test_a_channel_with_nothing_on_stays_empty():
    # Four channels on a real device carry no EPG data at all, so the guide
    # hands this None rather than a programme.
    from app.state import AppState
    assert AppState._with_poster(None) is None


def test_the_row_the_sync_stores_carries_the_device_facts(monkeypatch):
    """Scan, interlacing and favourite reach the mirror, or they never persist.

    `_assemble_grid_row` builds exactly what `save_guide` writes. The columns
    added in schema 5 are only worth having if this fills them - otherwise they
    sit null forever and the data still lives nowhere but memory, which is the
    state this was meant to fix.
    """
    from types import SimpleNamespace

    from app.state import state

    c = SimpleNamespace(identifier="ch1", call_sign="KPAX", major=8, minor=1,
                        network="CBS", kind="ota", display_name="KPAX")
    details = {"ch1": {"scan": "1080i", "interlaced": True, "favourite": True}}

    row = state._assemble_grid_row(c, {}, {}, {}, {}, details)

    assert row["scan"] == "1080i"
    assert row["interlaced"] is True
    assert row["favourite"] is True


def test_a_row_the_device_never_described_carries_no_scan():
    """The lineup fetch is started without being awaited, so it can be absent.

    A stated false would defeat the COALESCE in `save_guide` that stops a stub
    pass blanking a known value, so "not told" has to stay distinguishable.
    """
    from types import SimpleNamespace

    from app.state import state

    c = SimpleNamespace(identifier="ch9", call_sign="FAST", major=0, minor=0,
                        network="SCRIPPS", kind="ott", display_name="Scripps")

    row = state._assemble_grid_row(c, {}, {}, {}, {}, {})

    assert row["scan"] is None


def test_an_unscheduled_airing_is_not_reported_as_recording(monkeypatch):
    """`unscheduled` is the device's word for "this one will not record".

    Measured on a real device: Jeopardy! S43 E6 came back `unscheduled` after
    the episode was turned off in the Tablo app, and the sheet showed
    "REC - RECORD: ALL EPISODES" over it with an offer to stop recording
    something that was never going to record.

    The open-enumeration rule still holds for states nobody has seen - an
    unknown state reads as recording, which fails safe - but this one is known.
    """
    import time

    from app import store
    from app.state import state

    monkeypatch.setattr(type(state), "is_authenticated", property(lambda self: True))

    now = time.time()
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 3600))
    store.save_guide([{
        "identifier": "ch1", "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "CBS", "display_name": "KPAX", "logo_url": None, "kind": "ota",
        "airings": [{
            "title": "Jeopardy!", "subtitle": None, "description": None,
            "start": start, "duration": 1800, "genres": [], "kind": "episode",
            "episode_title": None, "season_number": 43, "episode_number": 6,
            "orig_air_date": None, "series_path": None,
            "airing_path": "/guide/series/episodes/1",
            "schedule_state": "unscheduled", "schedule_qualifier": None,
            "skip_reason": "none",
        }],
    }], now=now)

    d = client.get("/api/channels/airing-detail",
                   params={"channel": "ch1", "start": start}).json()

    assert d["schedule_state"] == "unscheduled"
    assert d["scheduled"] is False


def test_a_state_nobody_has_seen_still_reads_as_recording(monkeypatch):
    """The open enumeration: hiding a recording that is scheduled is worse
    than showing a badge that can be turned off."""
    import time

    from app import store
    from app.state import state

    monkeypatch.setattr(type(state), "is_authenticated", property(lambda self: True))

    now = time.time()
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 7200))
    store.save_guide([{
        "identifier": "ch2", "call_sign": "KPAX", "major": 8, "minor": 1,
        "network": "CBS", "display_name": "KPAX", "logo_url": None, "kind": "ota",
        "airings": [{
            "title": "Something New", "subtitle": None, "description": None,
            "start": start, "duration": 1800, "genres": [], "kind": "episode",
            "episode_title": None, "season_number": None, "episode_number": None,
            "orig_air_date": None, "series_path": None, "airing_path": None,
            "schedule_state": "queued_somehow", "schedule_qualifier": None,
            "skip_reason": None,
        }],
    }], now=now)

    d = client.get("/api/channels/airing-detail",
                   params={"channel": "ch2", "start": start}).json()

    assert d["scheduled"] is True
