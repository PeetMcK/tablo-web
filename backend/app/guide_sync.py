"""Keep the guide mirror current, and record how far back it can be trusted.

The device's guide is forward-looking: once a programme airs it falls off, and
no later request recovers it. History is therefore only ever captured as it
happens, and any period this process was not running is a permanent hole. That
is why the sync runs on startup as well as on a timer - coming back after
downtime captures whatever is still inside the device's forward window, which
recovers everything if the gap was shorter than that window.
"""

import asyncio
import os
import traceback
from datetime import datetime, timezone

from . import db, store

SYNC_HOURS = float(os.environ.get("TABLO_GUIDE_SYNC_HOURS", "6"))

# A full sync is ~8455 device requests - far more than the ~1000-airing
# interactive grid load. It runs concurrently with whatever a viewer is doing
# (a seek re-fetches from the device too), and the Tablo saturates around 10x
# realtime, so it has no bandwidth to spare. A lower concurrency than the
# interactive path's default keeps the sync from starving playback; it just
# takes longer to finish, which is fine for a background job.
SYNC_CONCURRENCY = int(os.environ.get("TABLO_GUIDE_SYNC_CONCURRENCY", "8"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def backfill_index() -> int:
    """Index what is already stored, so search works before the first sync.

    Migration creates empty tables; without this, search returns nothing until
    a sync finishes, which looks identical to a broken feature.
    """
    rows = await asyncio.to_thread(store.load_guide)
    if rows:
        await asyncio.to_thread(store.save_guide, rows)
    return sum(len(ch.get("airings") or []) for ch in rows)


async def sync_once(fetch) -> int:
    """Run one sync. Returns airings seen; never raises.

    `fetch` is an awaitable returning grid rows, injected so this is testable
    without a device.
    """
    started = _now()
    with db.write() as conn:
        cur = conn.execute(
            "INSERT INTO guide_sync(started_at) VALUES (?)", (started,)
        )
        run_id = cur.lastrowid

    try:
        rows = await fetch()
        seen = sum(len(ch.get("airings") or []) for ch in rows)
        await asyncio.to_thread(store.save_guide, rows)
        removed = await asyncio.to_thread(store.prune_guide)
        db.execute(
            "UPDATE guide_sync SET finished_at = ?, airings_seen = ?, ok = 1 "
            "WHERE id = ?",
            (_now(), seen, run_id),
        )
        print(f"[guide] synced {seen} airings, pruned {removed}", flush=True)
        return seen
    except Exception as e:  # noqa: BLE001 - a failed sync must not stop the app
        db.execute(
            "UPDATE guide_sync SET finished_at = ?, ok = 0, error = ? WHERE id = ?",
            (_now(), f"{type(e).__name__}: {e}", run_id),
        )
        print(f"[guide] sync failed: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        return 0


async def run_forever(fetch) -> None:
    """Index what is already stored, then sync at startup and every SYNC_HOURS."""
    try:
        indexed = await backfill_index()
        if indexed:
            print(f"[guide] backfilled {indexed} airings into the search index", flush=True)
    except Exception as e:  # noqa: BLE001 - a failed backfill must not block sync
        print(f"[guide] backfill failed: {type(e).__name__}: {e}", flush=True)

    while True:
        await sync_once(fetch)
        await asyncio.sleep(SYNC_HOURS * 3600)
