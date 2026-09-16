"""Ranked search across channels, guide airings and recordings.

One index, one query, one ranking. `kind` is what lets a new source join
without touching this module's callers - the API shape and every surface are
already written in terms of groups of kinds.
"""

import json
import re
import time

from . import db

MIN_QUERY = 2

# Groups in the order a person wants them: what you already have, then what is
# coming, then where to watch it.
KIND_ORDER = ("recording", "airing", "channel")

# How far a recording's start may drift from the airing's and still be the same
# showing. Recordings carry padding, so they rarely start on the minute. Wider
# than this starts matching a different repeat of the same programme, which is
# a worse answer than admitting we do not know.
MATCH_WINDOW = 300

# bm25 returns negative numbers and more negative is a better match, so results
# order ascending. Weights are title, subtitle, body, channel - a title hit
# should beat the same word buried in a description, which is most of what
# makes a five-item dropdown useful.
_RANK = "bm25(search_fts, 10.0, 5.0, 1.0, 2.0)"

_WORD = re.compile(r"[^\w]+", re.UNICODE)


def fts_query(raw: str) -> str:
    """Turn typed text into a safe FTS5 MATCH expression.

    FTS5 MATCH is a query language, not a string: quotes, hyphens and NEAR are
    all operators, so passing user text through unescaped is both a syntax
    error waiting to happen and a way to run queries nobody asked for. Every
    word is quoted, and the last gets a prefix star so results narrow as you
    type rather than appearing only on the final keystroke.
    """
    words = [w for w in _WORD.split(raw) if w]
    if not words:
        return ""
    quoted = [f'"{w}"' for w in words[:-1]]
    quoted.append(f'"{words[-1]}"*')
    return " ".join(quoted)


def coverage() -> dict:
    """How far back the guide history can be trusted.

    Without this an empty result cannot be told apart from a period the sync
    never saw - which is the exact confusion this feature exists to remove.
    """
    row = db.query_one(
        "SELECT MIN(started_at) AS since, MAX(finished_at) AS last "
        "FROM guide_sync WHERE ok = 1"
    )
    return {
        "since": row["since"] if row else None,
        "last_sync": row["last"] if row else None,
    }


def search(q: str, limit: int = 5, kinds: list[str] | None = None) -> dict:
    """Ranked matches grouped by kind.

    `limit` is per group, so one endpoint serves a three-row dropdown and a
    fifty-row results page.
    """
    q = (q or "").strip()
    limit = max(1, min(int(limit), 50))
    out = {"query": q, "coverage": coverage(), "groups": []}
    if len(q) < MIN_QUERY:
        return out

    match = fts_query(q)
    if not match:
        return out

    wanted = [k for k in KIND_ORDER if not kinds or k in kinds]
    for kind in wanted:
        total = db.query_one(
            "SELECT COUNT(*) AS n FROM search_fts "
            "JOIN search_doc d ON d.rowid = search_fts.rowid "
            "WHERE search_fts MATCH ? AND d.kind = ?",
            (match, kind),
        )["n"]
        if not total:
            continue
        rows = db.query(
            "SELECT d.kind, d.ref, d.title, d.subtitle, d.channel, "
            "       d.start_epoch, d.duration, d.target "
            "FROM search_fts JOIN search_doc d ON d.rowid = search_fts.rowid "
            f"WHERE search_fts MATCH ? AND d.kind = ? ORDER BY {_RANK}, "
            "       d.start_epoch IS NULL DESC, d.start_epoch "
            "LIMIT ?",
            (match, kind, limit),
        )
        out["groups"].append({
            "kind": kind,
            "total": total,
            "items": [_item(r) for r in rows],
        })
    return out


def _recorded_for(title: str | None, start_epoch: int | None) -> dict | None:
    """The recording of this showing, if there is one."""
    if not title or not start_epoch or start_epoch > time.time():
        return None
    row = db.query_one(
        "SELECT ref FROM search_doc WHERE kind = 'recording' "
        "  AND lower(trim(title)) = lower(trim(?)) "
        "  AND abs(start_epoch - ?) <= ? "
        "ORDER BY abs(start_epoch - ?) LIMIT 1",
        (title, start_epoch, MATCH_WINDOW, start_epoch),
    )
    return {"object_id": int(row["ref"])} if row else None


def _item(row) -> dict:
    return {
        "kind": row["kind"],
        "ref": row["ref"],
        "title": row["title"],
        "subtitle": row["subtitle"] or None,
        "channel": row["channel"] or None,
        "start_epoch": row["start_epoch"] or None,
        "duration": row["duration"],
        "target": json.loads(row["target"]),
        "recorded": (
            _recorded_for(row["title"], row["start_epoch"])
            if row["kind"] == "airing" else None
        ),
    }
