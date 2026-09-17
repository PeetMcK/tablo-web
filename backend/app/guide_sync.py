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
from functools import partial

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


# ---------------------------------------------------------------------------
# Blocking DB helpers - every one of these must run off the event loop via
# asyncio.to_thread. This process also serves HLS segments; db.write() and
# db.execute() are fully synchronous and busy_timeout=5000 means any of them
# can hold the event loop for up to five seconds under lock contention, which
# stalls playback mid-stream. See db.py's own docstring: "Connections are
# thread-local because every call arrives on a thread-pool worker."
# ---------------------------------------------------------------------------

def _start_run(started: str) -> int:
    with db.write() as conn:
        cur = conn.execute(
            "INSERT INTO guide_sync(started_at) VALUES (?)", (started,)
        )
        return cur.lastrowid


def _finish_run(run_id: int, seen: int) -> None:
    db.execute(
        "UPDATE guide_sync SET finished_at = ?, airings_seen = ?, ok = 1 "
        "WHERE id = ?",
        (_now(), seen, run_id),
    )


def _fail_run(run_id: int, error: Exception) -> None:
    db.execute(
        "UPDATE guide_sync SET finished_at = ?, ok = 0, error = ? WHERE id = ?",
        (_now(), f"{type(error).__name__}: {error}", run_id),
    )


async def backfill_index() -> int:
    """Index what is already stored, so search works before the first sync.

    Migration creates empty tables; without this, search returns nothing until
    a sync finishes, which looks identical to a broken feature.

    Written with `record_sync=False`: this is a re-index of what is already on
    disk, not a fetch. Stamping it as a sync would make `coverage()` report
    whatever is stored as freshly synced from the moment the process starts,
    which is exactly the confusion the coverage line exists to remove.
    """
    rows = await asyncio.to_thread(store.load_guide)
    if rows:
        await asyncio.to_thread(partial(store.save_guide, record_sync=False), rows)
    return sum(len(ch.get("airings") or []) for ch in rows)


async def sync_once(fetch, sync_series=None, prefetch_artwork=None) -> int:
    """Run one sync. Returns airings seen; never raises.

    `fetch` is an awaitable returning grid rows, injected so this is testable
    without a device. In production `fetch` is `state.get_grid_guide`, which
    already persists the rows itself - this only prunes and records coverage,
    so the guide is not written to SQLite twice per cycle.

    `sync_series` and `prefetch_artwork` are injected the same way, and are
    optional so every existing caller and test keeps working without them.

    Every step that touches the database is guarded independently: starting
    the run, recording success, and recording failure can each fail on their
    own (disk full, lock contention), and none of those failures may escape -
    a silent, permanent death of the sync loop is worse than a lost audit row.
    """
    started = _now()
    try:
        run_id = await asyncio.to_thread(_start_run, started)
    except Exception as e:
        print(f"[guide] sync could not start: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        return 0

    try:
        rows = await fetch()
        seen = sum(len(ch.get("airings") or []) for ch in rows)
        removed = await asyncio.to_thread(store.prune_guide)

        # Series capture rides the background sync rather than the interactive
        # guide path - see docs/superpowers/specs/2026-09-16-show-info-design.md.
        # Guarded on its own: the guide is the point, and losing a sync's
        # coverage record over a missing poster would be a poor trade.
        try:
            paths = await asyncio.to_thread(store.airing_series_paths)
            fetched = await sync_series(paths) if sync_series else 0
            if fetched:
                print(f"[guide] captured {fetched} series", flush=True)
            # After the capture, so it warms images this run just learned about.
            warmed = await prefetch_artwork() if prefetch_artwork else 0
            if warmed:
                print(f"[guide] prefetched {warmed} images", flush=True)
        except Exception as e:
            print(f"[guide] series capture failed: {type(e).__name__}: {e}", flush=True)

        await asyncio.to_thread(_finish_run, run_id, seen)
        print(f"[guide] synced {seen} airings, pruned {removed}", flush=True)
        return seen
    except Exception as e:
        print(f"[guide] sync failed: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        try:
            await asyncio.to_thread(_fail_run, run_id, e)
        except Exception as inner:
            print(
                f"[guide] could not record sync failure: {type(inner).__name__}: {inner}",
                flush=True,
            )
        return 0


async def run_forever(fetch, sync_series=None, prefetch_artwork=None) -> None:
    """Index what is already stored, then sync at startup and every SYNC_HOURS."""
    try:
        indexed = await backfill_index()
        if indexed:
            print(f"[guide] backfilled {indexed} airings into the search index", flush=True)
    except Exception as e:
        print(f"[guide] backfill failed: {type(e).__name__}: {e}", flush=True)

    while True:
        # sync_once is documented to never raise, but this loop is the last
        # line of defence: a single unlucky exception must not silently kill
        # background syncing for the rest of the process's life.
        try:
            await sync_once(fetch, sync_series, prefetch_artwork)
        except Exception as e:
            print(f"[guide] sync_once raised unexpectedly: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()
        await asyncio.sleep(SYNC_HOURS * 3600)
