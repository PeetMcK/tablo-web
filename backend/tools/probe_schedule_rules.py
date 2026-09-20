#!/usr/bin/env python3
"""Confirm which `schedule.rule` values the device accepts.

Two techniques from docs/tablo-api.md's "How to extend this safely":

  * Send a deliberately invalid value. A rejected write cannot change anything,
    and the 400 names the field it objected to.
  * Write a value, diff the whole object, then restore the original. A 200 does
    not prove the absence of a side effect elsewhere, so verify by diffing
    rather than by reading the response.

The target is chosen with nothing to lose: no keep count and no keep rule, so
even replace-style PATCH semantics could not destroy anything.

Run against a live device, with the same data directory the app uses:

    cd backend
    TABLO_DB_PATH="$HOME/Library/Application Support/tablo-web/tablo.db" \\
        .venv/bin/python tools/probe_schedule_rules.py
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.state import state

CANDIDATES = ["all", "new", "none"]


def _rule(series: dict) -> str | None:
    """The rule as either shape reports it - nested, or top level."""
    return (series.get("schedule") or {}).get("rule") or series.get("schedule_rule")


async def main() -> int:
    state.load_config()
    if state.active_device is None:
        print("no active device - log in through the app first")
        return 1

    paths = await state.request_device("GET", "/guide/series")
    print(f"{len(paths)} series on the device")

    target = None
    for path in paths:
        data = await state.request_device("GET", path)
        keep = data.get("keep") or {}
        if keep.get("rule") in (None, "none") and not keep.get("count"):
            target = (path, data)
            break

    if target is None:
        print("no series safe to probe")
        return 1

    path, before = target
    original = _rule(before)
    print(f"probing {path}, current rule {original!r}")

    status, data = await state.patch_device(path, {"schedule": {"rule": "ZZZ"}})
    print(f"invalid value -> {status} {json.dumps(data)}")

    accepted = []
    for rule in CANDIDATES:
        status, data = await state.patch_device(path, {"schedule": {"rule": rule}})
        after = await state.request_device("GET", path)
        print(f"{rule!r} -> {status}, series now reports {_rule(after)!r}")
        if status == 200:
            accepted.append(rule)

    if original:
        await state.patch_device(path, {"schedule": {"rule": original}})
        restored = await state.request_device("GET", path)
        print(f"restored to {_rule(restored)!r}")
    else:
        print("no original rule to restore")

    print("accepted:", accepted)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
