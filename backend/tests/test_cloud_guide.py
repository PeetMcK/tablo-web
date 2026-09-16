"""OTT/FAST channels come from the cloud, because the device has nothing.

The device lists 23 channels and returns zero airings for every OTT one; the
cloud lists 28 with full schedules. See docs/tablo-api.md.
"""

import asyncio

from app.state import AppState


def _device():
    return type("D", (), {
        "local_url": "http://10.0.0.5:8887",
        "account_token": "acct",
        "lighthouse_token": "ctx",
        "sid": "SID",
    })()


def _cloud_airing(ident="S120010_500_01", when="2026-09-16T15:00:00Z", title="Morning Rush"):
    return {
        "identifier": f"LH-X-{ident}-T1",
        "title": title,
        "channel": {"identifier": ident},
        "datetime": when,
        "duration": 3600,
        "description": "Live headlines.",
        "kind": "episode",
        "genres": ["News"],
        "episode": {"season": {"kind": "number", "number": 12},
                    "episodeNumber": 10, "originalAirDate": "2026-09-16",
                    "rating": "TVPG"},
        "show": {"identifier": "C1_SHOW", "title": "Scripps News"},
    }


# ---------------------------------------------------------------------------
# Mapping
# ---------------------------------------------------------------------------

def test_the_cloud_names_an_episode_the_other_way_round():
    """`title` is the episode; `show.title` is the programme.

    The device is the reverse - `airing_details.show_title` is the programme
    and `episode.title` the episode - so mapping this straight across puts the
    episode name in the grid cell and loses the series entirely.
    """
    got = AppState._cloud_airing_row(_cloud_airing(title="Oh, the Humidity!"))

    assert got["title"] == "Scripps News"
    assert got["episode_title"] == "Oh, the Humidity!"
    assert got["season_number"] == 12
    assert got["episode_number"] == 10
    assert got["orig_air_date"] == "2026-09-16"
    assert got["start"] == "2026-09-16T15:00:00Z"
    assert got["duration"] == 3600
    assert got["genres"] == ["News"]


def test_an_airing_whose_episode_is_its_programme_has_no_episode_title():
    """Movies and one-off events repeat the title in both fields.

    Storing it twice makes the sheet render the same line under itself.
    """
    a = _cloud_airing(title="Man in Red Bandana")
    a["show"]["title"] = "Man in Red Bandana"
    a["episode"] = None
    a["kind"] = "movieAiring"

    got = AppState._cloud_airing_row(a)

    assert got["title"] == "Man in Red Bandana"
    assert got["episode_title"] is None
    assert got["season_number"] is None


def test_the_cloud_carries_no_recording_handles():
    """It is a display source, not a control source - see docs/tablo-api.md.

    These stay None rather than being faked, because a non-null `airing_path`
    that is not a device path would be a PATCH target that 404s.
    """
    got = AppState._cloud_airing_row(_cloud_airing())

    assert got["airing_path"] is None
    assert got["series_path"] is None
    assert got["schedule_state"] is None


def test_season_zero_is_not_a_season():
    """Seen live on 500.1: `season: {"kind": "number", "number": 0}`.

    Taken literally that renders "S0 E5". Zero is the cloud's way of saying it
    has no season, not a season named zero.
    """
    a = _cloud_airing()
    a["episode"] = {"season": {"kind": "number", "number": 0}, "episodeNumber": 5}
    assert AppState._cloud_airing_row(a)["season_number"] is None


def test_a_season_that_is_not_numbered_is_not_a_number():
    """`kind` exists, so `number` is not always one - don't render whatever
    lands in that slot as a season index."""
    a = _cloud_airing()
    a["episode"] = {"season": {"kind": "special", "number": 2014}, "episodeNumber": 5}
    assert AppState._cloud_airing_row(a)["season_number"] is None


def test_the_cloud_carries_its_own_artwork():
    """OTT has no series record, so there is no cover_image_id to key off.

    The cloud hands back direct CDN URLs instead, on the airing itself - and
    the browser already loads channel logos from that same host, so this adds
    no third party and needs no server-side fetch.
    """
    a = _cloud_airing()
    a["images"] = [
        {"kind": "stillSmall", "url": "https://cdn/still-small.jpg"},
        {"kind": "poster", "url": "https://cdn/poster.jpg"},
        {"kind": "stillLarge", "url": "https://cdn/still-large.jpg"},
    ]
    assert AppState._cloud_airing_row(a)["image_url"] == "https://cdn/still-large.jpg"


def test_artwork_falls_back_through_the_kinds_it_has():
    """Not every airing carries every kind; a 2:3 poster in a 16:9 frame is
    the last resort rather than the first."""
    a = _cloud_airing()
    a["images"] = [{"kind": "poster", "url": "https://cdn/poster.jpg"},
                   {"kind": "coverLarge", "url": "https://cdn/cover.jpg"}]
    assert AppState._cloud_airing_row(a)["image_url"] == "https://cdn/cover.jpg"

    a["images"] = [{"kind": "poster", "url": "https://cdn/poster.jpg"}]
    assert AppState._cloud_airing_row(a)["image_url"] == "https://cdn/poster.jpg"


def test_an_airing_with_no_artwork_has_none():
    a = _cloud_airing()
    a["images"] = []
    assert AppState._cloud_airing_row(a)["image_url"] is None


def test_an_unknown_image_kind_is_not_guessed_at():
    """A kind we do not recognise may be any shape at all."""
    a = _cloud_airing()
    a["images"] = [{"kind": "bannerTiny", "url": "https://cdn/who-knows.jpg"}]
    assert AppState._cloud_airing_row(a)["image_url"] is None


def test_a_bare_cloud_record_still_maps():
    got = AppState._cloud_airing_row(
        {"channel": {"identifier": "x"}, "datetime": "2026-09-16T15:00:00Z",
         "duration": 1800}
    )
    assert got["title"] is None
    assert got["episode_title"] is None
    assert got["genres"] == []


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

def _stub_http(pages_by_day, seen=None):
    class FakeResp:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload

        def json(self):
            return self._payload

    class FakeHttp:
        async def get(self, url, headers=None, params=None, timeout=None):
            if seen is not None:
                seen.append(dict(params or {}))
            day = (params or {}).get("day")
            return FakeResp({"grid": pages_by_day.get(day, []), "next": None})

    return FakeHttp()


def test_the_schedule_walks_a_day_at_a_time_and_asks_for_the_whole_lineup():
    """`limit=50` is what collapses the grid's 4-channels-per-page pagination
    into one response; `day` is the only accepted way to move forward."""
    seen = []
    st = AppState()
    st.active_device = _device()
    st._http = _stub_http({}, seen)

    asyncio.run(st._fetch_cloud_schedule(days=3, today="2026-09-16"))

    assert [p["day"] for p in seen] == ["2026-09-16", "2026-09-17", "2026-09-18"]
    assert all(p["limit"] == 50 for p in seen)


def test_the_schedule_groups_by_channel_across_days():
    st = AppState()
    st.active_device = _device()
    st._http = _stub_http({
        "2026-09-16": [{"channel": {"identifier": "ch1"},
                        "airings": [_cloud_airing("ch1", "2026-09-16T15:00:00Z")]}],
        "2026-09-17": [{"channel": {"identifier": "ch1"},
                        "airings": [_cloud_airing("ch1", "2026-09-17T15:00:00Z")]},
                       {"channel": {"identifier": "ch2"},
                        "airings": [_cloud_airing("ch2", "2026-09-17T16:00:00Z")]}],
    })

    got = asyncio.run(st._fetch_cloud_schedule(days=2, today="2026-09-16"))

    assert [a["start"] for a in got["ch1"]] == [
        "2026-09-16T15:00:00Z", "2026-09-17T15:00:00Z"]
    assert len(got["ch2"]) == 1


def test_an_airing_seen_on_two_days_is_stored_once():
    """The grid's day boundary is local, so consecutive days overlap at the
    edges and the same airing comes back in both."""
    st = AppState()
    st.active_device = _device()
    dup = _cloud_airing("ch1", "2026-09-16T23:30:00Z")
    st._http = _stub_http({
        "2026-09-16": [{"channel": {"identifier": "ch1"}, "airings": [dup]}],
        "2026-09-17": [{"channel": {"identifier": "ch1"}, "airings": [dup]}],
    })

    got = asyncio.run(st._fetch_cloud_schedule(days=2, today="2026-09-16"))

    assert len(got["ch1"]) == 1


def test_one_bad_day_does_not_lose_the_others():
    """Fourteen requests, and a single failure must not cost the whole guide."""
    st = AppState()
    st.active_device = _device()

    class Flaky:
        async def get(self, url, headers=None, params=None, timeout=None):
            if (params or {}).get("day") == "2026-09-17":
                raise RuntimeError("cloud unreachable")

            class R:
                status_code = 200

                def json(self):
                    return {"grid": [{"channel": {"identifier": "ch1"},
                                      "airings": [_cloud_airing("ch1")]}]}
            return R()

    st._http = Flaky()

    got = asyncio.run(st._fetch_cloud_schedule(days=3, today="2026-09-16"))

    assert "ch1" in got


def test_no_device_means_no_schedule():
    st = AppState()
    st.active_device = None
    assert asyncio.run(st._fetch_cloud_schedule(days=3)) == {}


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _channel(ident="S120010_500_01"):
    return type("C", (), {
        "identifier": ident, "call_sign": "SCRIPPS", "major": 500, "minor": 1,
        "network": "SCRIPPSNEWS", "kind": "ott", "display_name": "Scripps News",
    })()


def test_an_ott_row_gets_its_whole_schedule_not_just_what_is_on_now():
    """The bug this fixes: OTT rows drew exactly one cell.

    `channels/{id}/airings/` returns one record and ignores every parameter,
    so the old path could not have produced more however it was called.
    """
    st = AppState()
    schedule = {"S120010_500_01": [
        AppState._cloud_airing_row(_cloud_airing(when="2026-09-16T15:00:00Z")),
        AppState._cloud_airing_row(_cloud_airing(when="2026-09-16T16:00:00Z")),
        AppState._cloud_airing_row(_cloud_airing(when="2026-09-16T17:00:00Z")),
    ]}

    row = st._assemble_grid_row(_channel(), {}, {}, {}, schedule)

    assert [a["start"] for a in row["airings"]] == [
        "2026-09-16T15:00:00Z", "2026-09-16T16:00:00Z", "2026-09-16T17:00:00Z"]


def test_a_device_schedule_still_wins():
    """OTA comes from the device, which carries the recording handles."""
    st = AppState()
    device_airings = [{"title": "From the device", "start": "2026-09-16T15:00:00Z",
                       "duration": 3600}]
    row = st._assemble_grid_row(
        _channel("ota1"), {}, {"/guide/channels/1": "ota1"},
        {"/guide/channels/1": device_airings},
        {"ota1": [AppState._cloud_airing_row(_cloud_airing("ota1"))]},
    )

    assert [a["title"] for a in row["airings"]] == ["From the device"]


def test_the_row_is_left_empty_when_neither_source_has_anything():
    """7.4 KIDS and 13.5 THENEST carry nothing in either place."""
    st = AppState()
    row = st._assemble_grid_row(_channel("nest"), {}, {}, {}, {})
    assert row["airings"] == []
