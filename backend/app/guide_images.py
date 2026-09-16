"""Guide artwork, cached on disk.

On disk rather than as BLOBs in SQLite: the database stays small and quick to
back up, and a lost image re-fetches where a lost row does not. Roughly 48 MB
at the ceiling (~1,100 series at 2.9 images of ~15 KB), against a transcode
cache measured in hundreds of gigabytes - which is why there is no eviction.

Nothing here raises. A missing poster is a sheet without a hero image, and the
rest of the sheet is the part worth showing.
"""

import os
from pathlib import Path

# Sits beside the transcode cache rather than inside it, so a cache wipe aimed
# at recordings does not take the artwork with it. The default mirrors
# transcode_cache.CACHE_ROOT's own default, one level up.
CACHE_DIR = Path(
    os.environ.get("TABLO_GUIDE_IMAGE_DIR")
    or Path(
        os.environ.get("TRANSCODE_CACHE_DIR", "/data/cache/recordings")
    ).parent / "guide-images"
)


def cached_path(image_id: int) -> Path:
    return CACHE_DIR / f"{int(image_id)}.jpg"


async def get(image_id: int, fetch) -> bytes | None:
    """Cached bytes, fetching once on a miss. Returns None if unavailable.

    `fetch` is injected so this is testable without a device; in production it
    is `state.fetch_device_image`.
    """
    path = cached_path(image_id)
    try:
        if path.exists():
            return path.read_bytes()
    except OSError:
        pass

    try:
        data, _ = await fetch(image_id)
    except Exception:  # noqa: BLE001 - a missing poster is not an error
        return None

    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    except OSError:
        pass       # serving it matters more than caching it
    return data
