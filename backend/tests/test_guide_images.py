"""Artwork is cached on disk, not in SQLite: a lost image re-fetches."""

import asyncio

from app import guide_images


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
