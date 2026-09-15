"""Encryption for the stored Tablo password.

Why the password is stored at all
---------------------------------
Tablo's cloud login returns ``access_token``, ``token_type`` and
``is_verified`` - a 40-character opaque token, with **no refresh token, no
expires_in, and no expiry claim**. The only way to obtain a fresh token is to
re-POST the email and password. So keeping the user signed in indefinitely,
without ever prompting again, requires retaining the password. It can be
protected; it cannot be eliminated.

What this does and does not protect against
-------------------------------------------
Protects against: copies of the database, backups, volume snapshots, an
accidental commit, and any future API response that leaks a row. The secret is
no longer sitting in cleartext in a world-readable file, which is what it was.

Does **not** protect against: an attacker who already has root on this host.
They can read both the database and the key. Describing this as "encrypted,
therefore safe" would be theater, so it is written down here rather than only in
the design doc.

The password is read only when a device call fails and ``discover()`` has to run
again. Normal operation uses the stored tokens and never touches it.
"""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

# Beside the database, not inside it: an encrypted column is worth nothing if
# the key travels in the same file.
KEY_PATH = Path(os.environ.get("TABLO_SECRET_KEY_PATH", "/data/.secret_key"))

# Lets the key live outside the machine entirely - a Docker secret, or a value
# supplied at start. Takes precedence over the file.
KEY_ENV = "TABLO_SECRET_KEY"


def _load_key() -> bytes:
    env = os.environ.get(KEY_ENV)
    if env:
        return env.encode()

    if KEY_PATH.exists():
        return KEY_PATH.read_bytes().strip()

    key = Fernet.generate_key()
    KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Create with 0600 rather than creating then chmod'ing: the gap between the
    # two is a window where the key is world-readable.
    fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, key)
    finally:
        os.close(fd)
    print(f"[secrets] generated encryption key at {KEY_PATH}", flush=True)
    return key


def _cipher() -> Fernet:
    return Fernet(_load_key())


def encrypt(plaintext: str) -> bytes:
    return _cipher().encrypt(plaintext.encode())


def decrypt(token: bytes | None) -> str | None:
    """Recover a stored secret, or None if it cannot be read.

    A missing or rotated key makes the stored password unrecoverable. That is
    treated as "not signed in" rather than as a fatal error, so the app still
    starts and asks for a login instead of refusing to run.
    """
    if not token:
        return None
    try:
        return _cipher().decrypt(bytes(token)).decode()
    except (InvalidToken, ValueError, TypeError):
        return None
