"""Artwork is cached on disk, not in SQLite: a lost image re-fetches."""

import asyncio
import time

from app import guide_images, store


def test_a_cached_image_is_served_without_touching_the_device(tmp_path, monkeypatch):
    monkeypatch.setattr(guide_images, "CACHE_DIR", tmp_path)
    (tmp_path / "42.jpg").write_bytes(b"cached-bytes")

    calls = []

    async def fetch(image_id):
        calls.append(image_id)
        return b"from-device", "image/jpeg"

    got = asyncio.run(guide_images.get(42, fetch))

    assert got == b"cached-bytes"
    assert calls == []


def test_a_miss_fetches_and_writes_through(tmp_path, monkeypatch):
    monkeypatch.setattr(guide_images, "CACHE_DIR", tmp_path)

    async def fetch(image_id):
        return b"from-device", "image/jpeg"

    got = asyncio.run(guide_images.get(7, fetch))

    assert got == b"from-device"
    assert (tmp_path / "7.jpg").read_bytes() == b"from-device"


def test_a_device_failure_is_a_miss_rather_than_an_error(tmp_path, monkeypatch):
    """A missing poster must not turn into a 500 on the sheet."""
    monkeypatch.setattr(guide_images, "CACHE_DIR", tmp_path)

    async def fetch(image_id):
        raise RuntimeError("device unreachable")

    assert asyncio.run(guide_images.get(9, fetch)) is None


def test_only_artwork_for_the_next_half_day_is_prefetched():
    """Eagerly fetching ~3,190 images to show a handful is waste; the window a
    viewer actually browses is the next few hours."""
    now = time.time()

    def airing(start_offset):
        return {"title": "X", "subtitle": None, "description": None,
                "start": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                       time.gmtime(now + start_offset)),
                "duration": 3600, "genres": [], "kind": None,
                "series_path": "/guide/series/soon" if start_offset < 40000 else "/guide/series/later"}

    store.save_guide([{
        "identifier": "ch1", "call_sign": "K", "major": 1, "minor": 1,
        "network": "N", "display_name": "K", "logo_url": None, "kind": "ota",
        "airings": [airing(3600), airing(60 * 3600)],
    }], now=now)
    store.save_series([
        {"path": "/guide/series/soon", "cover_image_id": 11, "identifier": None,
         "title": "Soon", "description": None, "genres": [], "rating": None,
         "orig_air_date": None, "episode_runtime": None, "cast": [],
         "thumbnail_image_id": None, "background_image_id": None,
         "schedule_rule": None, "keep_rule": None, "keep_count": None},
        {"path": "/guide/series/later", "cover_image_id": 22, "identifier": None,
         "title": "Later", "description": None, "genres": [], "rating": None,
         "orig_air_date": None, "episode_runtime": None, "cast": [],
         "thumbnail_image_id": None, "background_image_id": None,
         "schedule_rule": None, "keep_rule": None, "keep_count": None},
    ])

    assert store.imminent_cover_ids(hours=12, now=now) == [11]
