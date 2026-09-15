"""Per-test database isolation.

The database is module-level state addressed by a path, while cache objects are
constructed per test against their own ``tmp_path``. Without this, recording
metadata written by one test is visible to the next - which is exactly how
``pinned_count`` came back as 2 when one recording had been pinned.
"""

import pytest

from app import crypto, db


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    # Deliberately a sibling of tmp_path, not a child. Cache tests use tmp_path
    # itself as the cache root, and total_bytes() sums every file under it - so
    # a database living there would be counted as cached media and make the
    # eviction tests unsatisfiable.
    support = tmp_path.parent / f"{tmp_path.name}-support"
    support.mkdir(exist_ok=True)

    monkeypatch.setattr(crypto, "KEY_PATH", support / "secret.key")
    monkeypatch.delenv(crypto.KEY_ENV, raising=False)
    db.reset_for_tests(support / "tablo.db")
    try:
        yield
    finally:
        db.reset_for_tests()
