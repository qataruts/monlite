"""monlite kv — a synchronous, Redis-like cache, byte-compatible with @monlite/kv.

Backed by the shared tables `_kv(ns, k, v, expires_at)`, `_monlite_kv_pubsub` and
`_monlite_kv_zset`, so a value, message, or sorted-set written by the TypeScript `kv(db)`
is readable here and vice-versa. Atomic locks are `set_nx` (Redis `SET NX`); `with_lock`
wraps it as a context manager. Pub/sub is local-sync on `publish` plus `poll()` to drain
messages written by other processes (e.g. Node).
"""
from __future__ import annotations

import json
import secrets
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Optional


def _now() -> int:
    return int(time.time() * 1000)


def _dumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


class KV:
    def __init__(self, db, namespace: str = "default"):
        self._conn = db.sqlite
        self._ns = namespace
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS _kv (
              ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL,
              expires_at INTEGER, PRIMARY KEY (ns, k)
            );
            CREATE TABLE IF NOT EXISTS _monlite_kv_pubsub (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              ns TEXT NOT NULL, channel TEXT NOT NULL, payload TEXT, ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS _idx_kv_pubsub ON _monlite_kv_pubsub (ns, seq);
            CREATE TABLE IF NOT EXISTS _monlite_kv_zset (
              ns TEXT NOT NULL, k TEXT NOT NULL, member TEXT NOT NULL, score REAL NOT NULL,
              PRIMARY KEY (ns, k, member)
            );
            CREATE INDEX IF NOT EXISTS _idx_kv_zset ON _monlite_kv_zset (ns, k, score, member);
            """
        )
        # pub/sub: local handlers + a cursor so a poll never replays old/own messages
        self._subs: Dict[str, List[Callable[[Any], None]]] = {}
        row = self._conn.execute(
            "SELECT MAX(seq) FROM _monlite_kv_pubsub WHERE ns = ?", (self._ns,)
        ).fetchone()
        self._cursor = (row[0] or 0) if row else 0

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

    # ── locks (set_nx is the primitive; with_lock is the ergonomic wrapper) ──
    def lock(self, key: str, ttl_ms: int = 30_000) -> Optional[str]:
        """Acquire a lock; returns an opaque token, or None if already held."""
        token = secrets.token_hex(16)
        return token if self.set_nx(f"__lock__:{key}", token, ttl_ms) else None

    def unlock(self, key: str, token: str) -> bool:
        """Release a lock only if `token` still owns it (no stomping a re-acquire)."""
        if self.get(f"__lock__:{key}") == token:
            return self.delete(f"__lock__:{key}")
        return False

    @contextmanager
    def with_lock(self, key: str, ttl_ms: int = 30_000) -> Iterator[str]:
        token = self.lock(key, ttl_ms)
        if token is None:
            raise RuntimeError(f"monlite.kv: lock {key!r} is already held")
        try:
            yield token
        finally:
            self.unlock(key, token)

    # ── pub/sub (ephemeral; local-sync on publish, poll() drains other writers) ──
    def publish(self, channel: str, message: Any) -> int:
        """Publish a message; delivered to same-process subscribers now. Returns local count."""
        ts = _now()
        self._conn.execute(
            "INSERT INTO _monlite_kv_pubsub (ns, channel, payload, ts) VALUES (?, ?, ?, ?)",
            (self._ns, channel, _dumps(message), ts),
        )
        # Prune only THIS namespace's expired messages (don't drop another ns's).
        self._conn.execute(
            "DELETE FROM _monlite_kv_pubsub WHERE ns = ? AND ts < ?", (self._ns, ts - 30_000)
        )
        self.poll()  # deliver to same-process subscribers immediately
        return len(self._subs.get(channel, []))

    def subscribe(self, channel: str, handler: Callable[[Any], None]) -> Callable[[], None]:
        """Register a handler. Messages arrive on `publish` (same process) or `poll` (others)."""
        self._subs.setdefault(channel, []).append(handler)

        def unsubscribe() -> None:
            hs = self._subs.get(channel)
            if hs and handler in hs:
                hs.remove(handler)
                if not hs:
                    self._subs.pop(channel, None)

        return unsubscribe

    def poll(self) -> int:
        """Drain messages written since the last poll to subscribers; cross-process safe."""
        rows = self._conn.execute(
            "SELECT seq, channel, payload FROM _monlite_kv_pubsub WHERE ns = ? AND seq > ? ORDER BY seq ASC",
            (self._ns, self._cursor),
        ).fetchall()
        n = 0
        for seq, channel, payload in rows:
            self._cursor = seq
            handlers = self._subs.get(channel)
            if handlers:
                msg = json.loads(payload) if payload is not None else None
                for h in list(handlers):
                    h(msg)
                    n += 1
        return n

    # ── sorted sets (ZSET) ──────────────────────────────────────────────────
    @staticmethod
    def _check_score(name: str, v: Any) -> float:
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v != v:
            raise ValueError(f"monlite.kv.{name}: score must be a number, got {v!r}")
        return float(v)

    def zadd(self, key: str, score: float, member: str) -> None:
        self._check_score("zadd", score)
        self._conn.execute(
            "INSERT INTO _monlite_kv_zset (ns, k, member, score) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(ns, k, member) DO UPDATE SET score = excluded.score",
            (self._ns, key, member, score),
        )

    def zincrby(self, key: str, delta: float, member: str) -> float:
        self._check_score("zincrby", delta)
        cur = self.zscore(key, member) or 0.0
        nxt = cur + delta
        self._conn.execute(
            "INSERT INTO _monlite_kv_zset (ns, k, member, score) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(ns, k, member) DO UPDATE SET score = excluded.score",
            (self._ns, key, member, nxt),
        )
        return nxt

    def zscore(self, key: str, member: str) -> Optional[float]:
        row = self._conn.execute(
            "SELECT score FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?",
            (self._ns, key, member),
        ).fetchone()
        return row[0] if row else None

    def zrem(self, key: str, member: str) -> bool:
        cur = self._conn.execute(
            "DELETE FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND member = ?",
            (self._ns, key, member),
        )
        return cur.rowcount > 0

    def zcard(self, key: str) -> int:
        return self._conn.execute(
            "SELECT count(*) FROM _monlite_kv_zset WHERE ns = ? AND k = ?", (self._ns, key)
        ).fetchone()[0]

    def _ordered(self, key: str, rev: bool) -> List[str]:
        d = "DESC" if rev else "ASC"
        return [
            r[0]
            for r in self._conn.execute(
                f"SELECT member FROM _monlite_kv_zset WHERE ns = ? AND k = ? "
                f"ORDER BY score {d}, member {d}",
                (self._ns, key),
            ).fetchall()
        ]

    def zrank(self, key: str, member: str, rev: bool = False) -> Optional[int]:
        members = self._ordered(key, rev)
        return members.index(member) if member in members else None

    def zrange(self, key: str, start: int, stop: int, rev: bool = False) -> List[str]:
        members = self._ordered(key, rev)
        n = len(members)
        # Floor fractional indices (can't reach a SQL LIMIT/OFFSET) and resolve negatives.
        start = int(start) + n if start < 0 else int(start)
        stop = int(stop) + n if stop < 0 else int(stop)
        start = max(0, start)
        stop = min(n - 1, stop)
        if n == 0 or start > stop:
            return []
        return members[start : stop + 1]

    def zrange_by_score(self, key: str, min_score: float, max_score: float, rev: bool = False) -> List[str]:
        d = "DESC" if rev else "ASC"
        return [
            r[0]
            for r in self._conn.execute(
                f"SELECT member FROM _monlite_kv_zset WHERE ns = ? AND k = ? AND score >= ? AND score <= ? "
                f"ORDER BY score {d}, member {d}",
                (self._ns, key, min_score, max_score),
            ).fetchall()
        ]


def kv(db, namespace: str = "default") -> KV:
    """A synchronous cache/locks store over the database (Redis's local role)."""
    return KV(db, namespace)
