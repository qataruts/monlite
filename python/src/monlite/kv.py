"""monlite kv — a synchronous, Redis-like cache, byte-compatible with @monlite/kv.

Backed by the shared `_kv(ns, k, v, expires_at)` table, so a value written by the
TypeScript `kv(db)` is readable here and vice-versa.
"""
from __future__ import annotations

import json
import time
from typing import Any, List, Optional


def _now() -> int:
    return int(time.time() * 1000)


def _dumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


class KV:
    def __init__(self, db, namespace: str = "default"):
        self._conn = db.sqlite
        self._ns = namespace
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS _kv "
            "(ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (ns, k))"
        )

    def _live_row(self, key: str):
        row = self._conn.execute(
            "SELECT v, expires_at FROM _kv WHERE ns = ? AND k = ?", (self._ns, key)
        ).fetchone()
        if not row:
            return None
        v, expires_at = row
        if expires_at is not None and expires_at <= _now():
            self._conn.execute("DELETE FROM _kv WHERE ns = ? AND k = ?", (self._ns, key))
            self._conn.commit()
            return None
        return v

    def get(self, key: str) -> Any:
        v = self._live_row(key)
        return json.loads(v) if v is not None else None

    def _set_raw(self, key: str, v: str, expires_at: Optional[int]) -> None:
        self._conn.execute(
            "INSERT INTO _kv (ns, k, v, expires_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at",
            (self._ns, key, v, expires_at),
        )
        self._conn.commit()

    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        self._set_raw(key, _dumps(value), _now() + ttl if ttl else None)

    def set_nx(self, key: str, value: Any, ttl: Optional[int] = None) -> bool:
        """Atomic set-if-absent (Redis SET NX). True if acquired."""
        if self._live_row(key) is not None:
            return False
        self._set_raw(key, _dumps(value), _now() + ttl if ttl else None)
        return True

    def has(self, key: str) -> bool:
        return self._live_row(key) is not None

    def delete(self, key: str) -> bool:
        cur = self._conn.execute("DELETE FROM _kv WHERE ns = ? AND k = ?", (self._ns, key))
        self._conn.commit()
        return cur.rowcount > 0

    def incr(self, key: str, by: int = 1) -> int:
        cur = self.get(key)
        n = (cur if isinstance(cur, (int, float)) else 0) + by
        self.set(key, n)
        return n

    def decr(self, key: str, by: int = 1) -> int:
        return self.incr(key, -by)

    def mget(self, keys: List[str]) -> List[Any]:
        return [self.get(k) for k in keys]

    def ttl(self, key: str) -> int:
        row = self._conn.execute(
            "SELECT expires_at FROM _kv WHERE ns = ? AND k = ?", (self._ns, key)
        ).fetchone()
        if not row:
            return -2  # absent (Redis convention)
        if row[0] is None:
            return -1  # no expiry
        return max(0, row[0] - _now())

    def keys(self, prefix: Optional[str] = None) -> List[str]:
        now = _now()
        if prefix:
            rows = self._conn.execute(
                "SELECT k, expires_at FROM _kv WHERE ns = ? AND k LIKE ? ESCAPE '\\'",
                (self._ns, prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"),
            ).fetchall()
        else:
            rows = self._conn.execute("SELECT k, expires_at FROM _kv WHERE ns = ?", (self._ns,)).fetchall()
        return [k for (k, exp) in rows if exp is None or exp > now]

    def size(self) -> int:
        return len(self.keys())

    def flush(self) -> None:
        self._conn.execute("DELETE FROM _kv WHERE ns = ?", (self._ns,))
        self._conn.commit()


def kv(db, namespace: str = "default") -> KV:
    """A synchronous cache/locks store over the database (Redis's local role)."""
    return KV(db, namespace)
