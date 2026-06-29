"""monlite queue — a durable, multi-process-safe job queue over SQLite,
byte-compatible with ``@monlite/queue``.

Jobs live in the shared table ``_jobs`` in the *exact* on-disk layout the
TypeScript ``createQueue(db)`` uses, so a ``.db`` written by a Node worker and a
Python worker can be shared: the same rows, status values, atomic-claim SQL,
retry/backoff, delay, priority ordering, and ``job_id`` dedupe.

    from monlite import create_db
    from monlite.queue import create_queue

    db = create_db("app.db")
    q = create_queue(db, max_attempts=3)
    q.add("email", {"to": "a@b.c"})
    q.process("email", lambda payload: send(payload))   # drains all due jobs

This is the **synchronous** surface of the queue (claim / complete / fail /
process-drain). The status lifecycle is ``pending`` -> ``active`` -> ``done`` |
``failed``; a job is claimed atomically (so two workers never double-claim) and
its attempt is counted at claim time, which also fences a later complete/fail
against a job another worker has since reclaimed.
"""
from __future__ import annotations

import json
import os
import random
import time
from typing import Any, Callable, Dict, Optional, Union

# A claimed job is passed around as a parsed dict; helpers accept either that
# dict (preferred — it carries the claim-time ``attempts`` used for fencing) or
# a bare row id.
Job = Dict[str, Any]
JobRef = Union[int, Job]
Handler = Callable[[Any], Any]
Backoff = Callable[[int], int]


def _now() -> int:
    return int(time.time() * 1000)


def _dumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def _safe_dumps(v: Any) -> str:
    """Serialize a job result, tolerating non-JSON values — a quirky handler
    result must not throw and leave the job stuck ``active`` with no fail/retry.
    Mirrors the TS ``safeStringify`` (``v ?? null``)."""
    try:
        return _dumps(v if v is not None else None)
    except (TypeError, ValueError):
        return _dumps("[unserializable result]")


def _default_backoff(attempt: int) -> int:
    """Exponential backoff before retry N, capped at 30s — matches the TS default
    ``Math.min(30_000, 1000 * 2 ** (attempt - 1))``."""
    return min(30_000, 1000 * 2 ** (attempt - 1))


# Column order returned by ``SELECT *`` / ``RETURNING *`` on ``_jobs`` (table
# definition order). Used to turn a raw row tuple into a deserialized job dict.
_COLS = (
    "id", "queue", "status", "priority", "run_at", "attempts", "max_attempts",
    "payload", "result", "error", "locked_by", "job_id", "created_at", "updated_at",
)


def _deserialize(row) -> Job:
    """Turn a raw ``_jobs`` row into a job dict with parsed JSON, mirroring the
    TS ``deserialize`` (payload parsed; result parsed when present)."""
    r = dict(zip(_COLS, row))
    return {
        "id": r["id"],
        "queue": r["queue"],
        "job_id": r["job_id"],
        "status": r["status"],
        "priority": r["priority"],
        "payload": json.loads(r["payload"]),
        "attempts": r["attempts"],
        "max_attempts": r["max_attempts"],
        "run_at": r["run_at"],
        "result": json.loads(r["result"]) if r["result"] is not None else None,
        "error": r["error"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


class Queue:
    """A durable job queue backed by SQLite. Producers :meth:`add` jobs; workers
    :meth:`claim`/:meth:`process` them with retries, backoff, delays, priority,
    and ``job_id`` dedupe."""

    def __init__(
        self,
        db,
        max_attempts: int = 1,
        backoff: Optional[Backoff] = None,
        remove_on_complete: bool = False,
        worker_id: Optional[str] = None,
    ):
        self._conn = db.sqlite
        self._max_attempts = max_attempts
        self._backoff = backoff if backoff is not None else _default_backoff
        self._remove_on_complete = remove_on_complete
        # Identifies this worker in the ``locked_by`` column. Same shape as TS:
        # ``w-<pid>`` (random fallback if no pid).
        self.worker_id = worker_id or f"w-{os.getpid() or random.randint(0, 999_999)}"

        # Same DDL the TS emits (autocommit, so each statement commits). The
        # ALTER is the idempotent job_id back-fill for pre-existing tables.
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS _jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              queue TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL,
              run_at INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
              payload TEXT NOT NULL, result TEXT, error TEXT, locked_by TEXT, job_id TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            )"""
        )
        try:
            self._conn.execute("ALTER TABLE _jobs ADD COLUMN job_id TEXT")
        except Exception:
            pass  # column already exists
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS _jobs_claim ON _jobs (queue, status, priority, run_at)"
        )
        self._conn.execute("CREATE INDEX IF NOT EXISTS _jobs_jobid ON _jobs (job_id)")

    # ── producing ────────────────────────────────────────────────────────────
    def add(
        self,
        name: str,
        payload: Any,
        delay: int = 0,
        priority: int = 0,
        max_attempts: Optional[int] = None,
        job_id: Optional[str] = None,
        run_at: Optional[int] = None,
    ) -> Job:
        """Enqueue a job (synchronous). Returns the job row as a dict.

        Pass ``job_id`` to **dedupe**: if a job with that id is already pending or
        active *on this queue*, the existing job is returned instead of inserting
        a duplicate (idempotent enqueue). ``run_at`` (epoch-ms) overrides
        ``delay`` (ms) for when the job becomes runnable.
        """
        t = _now()
        if job_id:
            # Scope dedupe to THIS queue — a job_id is unique per queue, not
            # globally (matches the TS ``AND queue = ?``).
            row = self._conn.execute(
                "SELECT * FROM _jobs WHERE job_id = ? AND queue = ? "
                "AND status IN ('pending','active') LIMIT 1",
                (job_id, name),
            ).fetchone()
            if row:
                return _deserialize(row)

        run_at_val = run_at if run_at is not None else (t + delay if delay else t)
        cur = self._conn.execute(
            "INSERT INTO _jobs (queue, status, priority, run_at, attempts, max_attempts, "
            "payload, job_id, created_at, updated_at) "
            "VALUES (?, 'pending', ?, ?, 0, ?, ?, ?, ?, ?)",
            (
                name,
                priority,
                run_at_val,
                max_attempts if max_attempts is not None else self._max_attempts,
                _dumps(payload if payload is not None else None),
                job_id,
                t,
                t,
            ),
        )
        job = self.get(int(cur.lastrowid))
        assert job is not None
        return job

    # ── claiming ─────────────────────────────────────────────────────────────
    def claim(self, name: Optional[str] = None) -> Optional[Job]:
        """Atomically claim the next due pending job (highest priority, then
        oldest), mark it ``active`` + count the attempt + stamp ``locked_by``, and
        return it — or ``None`` if nothing is due. Two concurrent claims never
        return the same job (the single ``UPDATE ... WHERE id = (SELECT ... LIMIT
        1)`` lets exactly one writer win the row).

        ``name`` scopes to one queue; ``None`` claims across all queues.
        """
        t = _now()
        # An IMMEDIATE transaction so the select-then-update is a single atomic
        # write under our autocommit connection (the TS does this in one
        # ``UPDATE ... RETURNING`` statement; same row-level effect).
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            if name is not None:
                row = self._conn.execute(
                    "UPDATE _jobs SET status='active', attempts=attempts+1, locked_by=?, updated_at=? "
                    "WHERE id = ("
                    "  SELECT id FROM _jobs"
                    "  WHERE queue=? AND status='pending' AND run_at<=?"
                    "  ORDER BY priority DESC, id ASC LIMIT 1"
                    ") RETURNING *",
                    (self.worker_id, t, name, t),
                ).fetchone()
            else:
                row = self._conn.execute(
                    "UPDATE _jobs SET status='active', attempts=attempts+1, locked_by=?, updated_at=? "
                    "WHERE id = ("
                    "  SELECT id FROM _jobs"
                    "  WHERE status='pending' AND run_at<=?"
                    "  ORDER BY priority DESC, id ASC LIMIT 1"
                    ") RETURNING *",
                    (self.worker_id, t, t),
                ).fetchone()
            self._conn.execute("COMMIT")
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise
        return _deserialize(row) if row else None

    # ── completing / failing ─────────────────────────────────────────────────
    def _resolve(self, ref: JobRef) -> Job:
        if isinstance(ref, dict):
            return ref
        job = self.get(int(ref))
        if job is None:
            raise ValueError(f"monlite.queue: no job with id {ref}")
        return job

    def complete(self, job_id_or_row: JobRef, result: Any = None) -> None:
        """Mark a job ``done`` (or delete it when ``remove_on_complete``). Fenced
        on the claim-time ``attempts`` so a stale worker can't clobber a job that
        was reclaimed and re-run by someone else."""
        job = self._resolve(job_id_or_row)
        if self._remove_on_complete:
            self._conn.execute(
                "DELETE FROM _jobs WHERE id=? AND attempts=?", (job["id"], job["attempts"])
            )
            return
        self._conn.execute(
            "UPDATE _jobs SET status='done', result=?, error=NULL, updated_at=? "
            "WHERE id=? AND attempts=?",
            (_safe_dumps(result), _now(), job["id"], job["attempts"]),
        )

    def fail(self, job_id_or_row: JobRef, error: Any) -> None:
        """Record a failure: retry (back to ``pending`` with a backoff delay) while
        attempts remain, else dead-letter as ``failed``. ``attempts`` was bumped at
        claim time, so it both decides retry-vs-dead-letter and fences this write."""
        job = self._resolve(job_id_or_row)
        # Match the TS ``err instanceof Error ? err.message : String(err)``.
        message = str(error)
        if job["attempts"] < job["max_attempts"]:
            self._conn.execute(
                "UPDATE _jobs SET status='pending', run_at=?, error=?, locked_by=NULL, updated_at=? "
                "WHERE id=? AND attempts=?",
                (
                    _now() + self._backoff(job["attempts"]),
                    message,
                    _now(),
                    job["id"],
                    job["attempts"],
                ),
            )
            return
        self._conn.execute(
            "UPDATE _jobs SET status='failed', error=?, updated_at=? WHERE id=? AND attempts=?",
            (message, _now(), job["id"], job["attempts"]),
        )

    # ── processing ───────────────────────────────────────────────────────────
    def process(self, name: str, handler: Handler, max: Optional[int] = None) -> int:
        """Claim and run ``handler(payload)`` in a loop until no due job remains
        (or ``max`` jobs have been processed). A returned value completes the job;
        a raised exception fails it (retry/backoff or dead-letter). Returns the
        number of jobs processed."""
        processed = 0
        while max is None or processed < max:
            job = self.claim(name)
            if job is None:
                break
            try:
                result = handler(job["payload"])
            except BaseException as exc:  # noqa: BLE001 — any handler error fails the job
                self.fail(job, exc)
            else:
                self.complete(job, result)
            processed += 1
        return processed

    # ── inspecting ───────────────────────────────────────────────────────────
    def size(self, status: str = "pending", name: Optional[str] = None) -> int:
        """Count jobs in ``status`` (optionally for one queue)."""
        if name is not None:
            return self._conn.execute(
                "SELECT count(*) FROM _jobs WHERE status=? AND queue=?", (status, name)
            ).fetchone()[0]
        return self._conn.execute(
            "SELECT count(*) FROM _jobs WHERE status=?", (status,)
        ).fetchone()[0]

    def get(self, id: int) -> Optional[Job]:
        """Fetch a job by its row id, or ``None``."""
        row = self._conn.execute("SELECT * FROM _jobs WHERE id = ?", (id,)).fetchone()
        return _deserialize(row) if row else None

    def counts(self, name: Optional[str] = None) -> Dict[str, int]:
        """Count jobs by status (optionally for one queue), like the TS ``counts``."""
        if name is not None:
            rows = self._conn.execute(
                "SELECT status, COUNT(*) FROM _jobs WHERE queue=? GROUP BY status", (name,)
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT status, COUNT(*) FROM _jobs GROUP BY status"
            ).fetchall()
        out: Dict[str, int] = {"pending": 0, "active": 0, "done": 0, "failed": 0}
        for status, n in rows:
            out[status] = n
        return out

    def recover(self, older_than_ms: int = 60_000, name: Optional[str] = None) -> int:
        """Reset jobs stuck ``active`` (e.g. a crashed worker) back to ``pending``
        when untouched for ``older_than_ms``. Returns the count recovered. Matches
        the TS ``recover``."""
        t = _now()
        if name is not None:
            cur = self._conn.execute(
                "UPDATE _jobs SET status='pending', locked_by=NULL, updated_at=? "
                "WHERE status='active' AND updated_at < ? AND queue = ?",
                (t, t - older_than_ms, name),
            )
        else:
            cur = self._conn.execute(
                "UPDATE _jobs SET status='pending', locked_by=NULL, updated_at=? "
                "WHERE status='active' AND updated_at < ?",
                (t, t - older_than_ms),
            )
        return cur.rowcount


def create_queue(
    db,
    max_attempts: int = 1,
    backoff: Optional[Backoff] = None,
    remove_on_complete: bool = False,
    worker_id: Optional[str] = None,
) -> Queue:
    """Create a job queue over a monlite database (mirror of TS ``createQueue``)."""
    return Queue(
        db,
        max_attempts=max_attempts,
        backoff=backoff,
        remove_on_complete=remove_on_complete,
        worker_id=worker_id,
    )


__all__ = ["Queue", "create_queue", "Job", "Handler"]
