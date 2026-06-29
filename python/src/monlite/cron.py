"""monlite cron — a persisted cron scheduler, byte-compatible with @monlite/cron.

Backed by the shared table ``_schedules(name, cron, next_run, last_run)``, in the exact
on-disk layout the TypeScript ``createCron(db)`` uses — so a schedule written by Node is
read here and vice-versa. Firing is atomic (a conditional ``UPDATE`` on ``next_run``) so
multiple processes won't double-run an occurrence.

Cron expressions are the standard 5 fields ``min hour dom month dow``. ``next_cron_run``
evaluates them in local time by default, or in any IANA ``tz`` (DST included) via the
standard-library :mod:`zoneinfo`. It returns a timezone-aware :class:`datetime.datetime`;
the epoch milliseconds that get persisted are ``int(dt.timestamp() * 1000)``.
"""
from __future__ import annotations

import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional, Set, Union
from zoneinfo import ZoneInfo

CronHandler = Callable[[], None]


def _now_ms() -> int:
    return int(time.time() * 1000)


# ── parsing ───────────────────────────────────────────────────────────────────
def _parse_field(field: str, lo_bound: int, hi_bound: int) -> Set[int]:
    """Parse one cron field into the explicit set of values it matches.

    Supports ``*``, lists ``a,b``, ranges ``a-b``, steps ``*/n`` and ``a/n``. A bare
    ``N`` (no step) means exactly ``{N}``; ``N/step`` means "from N up to max, step by
    step" (e.g. ``5/15`` -> 5,20,35,50). Ranges are validated against ``lo_bound``/
    ``hi_bound``; an invalid field raises ``ValueError`` (matching the TS ``throw``).
    """
    out: Set[int] = set()
    for part in field.split(","):
        range_part, _, step_part = part.partition("/")
        has_step = "/" in part
        try:
            step = 1 if not has_step else int(step_part)
        except ValueError:
            raise ValueError(
                f'Invalid cron field "{field}" (expected {lo_bound}-{hi_bound})'
            )
        try:
            if range_part == "*":
                lo, hi = lo_bound, hi_bound
            elif "-" in range_part:
                a, _, b = range_part.partition("-")
                lo, hi = int(a), int(b)
            else:
                # `N/step` -> from N to max; a bare `N` -> exactly {N}.
                lo = int(range_part)
                hi = lo if not has_step else hi_bound
        except ValueError:
            raise ValueError(
                f'Invalid cron field "{field}" (expected {lo_bound}-{hi_bound})'
            )
        if step < 1 or lo < lo_bound or hi > hi_bound or lo > hi:
            raise ValueError(
                f'Invalid cron field "{field}" (expected {lo_bound}-{hi_bound})'
            )
        out.update(range(lo, hi + 1, step))
    return out


@dataclass(frozen=True)
class ParsedCron:
    """A parsed 5-field cron expression: the matching value sets per field, plus
    flags for whether day-of-month / day-of-week were restricted (i.e. not ``*``),
    which selects the POSIX OR-vs-AND day rule."""

    minute: Set[int]
    hour: Set[int]
    dom: Set[int]
    month: Set[int]
    dow: Set[int]
    dom_restricted: bool
    dow_restricted: bool


def parse_cron(expr: str) -> ParsedCron:
    """Parse a standard 5-field cron expression (``min hour dom month dow``)."""
    parts = expr.strip().split()
    if len(parts) != 5:
        raise ValueError(
            f'Cron expression must have 5 fields, got {len(parts)}: "{expr}"'
        )
    return ParsedCron(
        minute=_parse_field(parts[0], 0, 59),
        hour=_parse_field(parts[1], 0, 23),
        dom=_parse_field(parts[2], 1, 31),
        month=_parse_field(parts[3], 1, 12),
        dow=_parse_field(parts[4], 0, 6),
        dom_restricted=parts[2] != "*",
        dow_restricted=parts[4] != "*",
    )


# ── next-run computation ──────────────────────────────────────────────────────
@dataclass(frozen=True)
class _WallParts:
    minute: int
    hour: int
    day: int
    month: int
    dow: int  # POSIX: Sun=0 .. Sat=6


def _wall_parts(d: datetime) -> _WallParts:
    """The wall-clock fields of an aware datetime (already in the evaluation zone)."""
    return _WallParts(
        minute=d.minute,
        hour=d.hour,
        day=d.day,
        month=d.month,
        dow=d.isoweekday() % 7,  # isoweekday: Mon=1..Sun=7 -> cron Sun=0..Sat=6
    )


def _day_matches(c: ParsedCron, p: _WallParts) -> bool:
    """True if the date part (month + day-of-month/day-of-week) of ``p`` can match."""
    if p.month not in c.month:
        return False
    dom = p.day in c.dom
    dow = p.dow in c.dow
    # POSIX: when both day-of-month and day-of-week are restricted, either matches.
    if c.dom_restricted and c.dow_restricted:
        return dom or dow
    return dom and dow


# ~5 years of minutes' worth of skip-steps; with whole-day/hour skipping the real
# iteration count is in the thousands (see the loop), this is just a hard ceiling.
_MAX_STEPS = 5 * 366 * 25


def next_cron_run(
    expr: Union[str, ParsedCron],
    from_dt: Optional[datetime] = None,
    tz: Optional[str] = None,
) -> datetime:
    """The next time (strictly after ``from_dt``) a cron expression fires.

    ``from_dt`` is a :class:`datetime.datetime` (naive is treated as system-local),
    defaulting to now. ``tz`` is an optional IANA zone (e.g. ``"Europe/Istanbul"``)
    the expression is evaluated in, DST included; otherwise system-local time is used.

    Returns a timezone-aware ``datetime`` (in ``tz`` when given, else the system-local
    zone). The persisted epoch-ms is ``int(result.timestamp() * 1000)``.

    Whole non-matching days and hours are *skipped* rather than scanned minute by
    minute, so an impossible (``0 0 31 2 *``) or leap-day-only (``0 0 29 2 *``)
    schedule resolves in a few thousand steps instead of millions — each step re-reads
    the wall clock, which keeps the coarse jumps DST-safe and self-correcting.
    """
    c = parse_cron(expr) if isinstance(expr, str) else expr
    zone = ZoneInfo(tz) if tz else (datetime.now().astimezone().tzinfo or timezone.utc)

    # Anchor as an absolute instant; advance by adding wall-independent timedeltas and
    # re-read the wall clock in `zone` each step (mirrors the TS tz branch exactly).
    if from_dt is None:
        from_dt = datetime.now(zone)
    elif from_dt.tzinfo is None:
        from_dt = from_dt.astimezone()  # naive -> system-local instant
    d = from_dt.astimezone(zone).replace(second=0, microsecond=0) + timedelta(minutes=1)

    for _ in range(_MAX_STEPS):
        p = _wall_parts(d)
        if not _day_matches(c, p):
            # Jump to the next day's 00:00 (in absolute time). A DST transition that
            # day can land us off by <=1h; the next pass re-reads and corrects it.
            mins = (24 - p.hour) * 60 - p.minute
            d = d + timedelta(minutes=max(1, mins))
            d = d.astimezone(zone)
            continue
        if p.hour not in c.hour:
            d = (d + timedelta(minutes=60 - p.minute)).astimezone(zone)
            continue
        if p.minute in c.minute:
            return d
        d = (d + timedelta(minutes=1)).astimezone(zone)
    raise ValueError(f'Could not compute next run for cron "{expr}"')


# ── persisted scheduler ───────────────────────────────────────────────────────
@dataclass
class _Registration:
    c: ParsedCron
    fn: CronHandler
    tz: Optional[str]
    jitter: int


class Cron:
    """A persisted cron scheduler.

    Schedules survive restarts (the next-run is stored) and firing is atomic, so
    multiple processes won't double-run an occurrence. Compose with a queue for durable
    work: ``cron.schedule(n, expr, lambda: queue.add(...))``. A handler that raises is
    isolated — it neither stops the firing pass nor affects sibling schedules.

    There is no background thread: drive it by calling :meth:`tick` (e.g. on a timer).
    ``check_interval`` is accepted for parity with the TS API and recorded as
    :attr:`check_interval`, but scheduling is caller-driven here.
    """

    def __init__(self, db, check_interval: int = 1000):
        self._conn = db.sqlite
        self.check_interval = check_interval
        self._handlers: Dict[str, _Registration] = {}
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS _schedules (
              name TEXT PRIMARY KEY, cron TEXT NOT NULL,
              next_run INTEGER NOT NULL, last_run INTEGER
            )"""
        )

    def _compute_next(
        self, c: ParsedCron, from_dt: datetime, tz: Optional[str], jitter: int
    ) -> int:
        """Next firing as epoch ms, applying ``tz`` and up to ``jitter`` ms of delay."""
        base = int(next_cron_run(c, from_dt, tz).timestamp() * 1000)
        return base + random.randrange(jitter) if jitter and jitter > 0 else base

    def schedule(
        self,
        name: str,
        expr: str,
        handler: CronHandler,
        tz: Optional[str] = None,
        jitter: int = 0,
    ) -> None:
        """Register (or update) a schedule.

        If a schedule with this ``name`` already exists with the *same* expression, its
        stored ``next_run`` is kept (so a restart doesn't reset timing). If the
        expression changed (or it's new), the next run is recomputed so the new schedule
        takes effect immediately instead of waiting out the old ``next_run``.
        """
        c = parse_cron(expr)
        row = self._conn.execute(
            "SELECT next_run, cron FROM _schedules WHERE name = ?", (name,)
        ).fetchone()
        if row is not None and row[1] == expr:
            next_run = row[0]
        else:
            next_run = self._compute_next(c, datetime.now(timezone.utc), tz, jitter)
        self._conn.execute(
            "INSERT INTO _schedules (name, cron, next_run, last_run) VALUES (?, ?, ?, NULL) "
            "ON CONFLICT(name) DO UPDATE SET cron = excluded.cron, next_run = excluded.next_run",
            (name, expr, next_run),
        )
        self._handlers[name] = _Registration(c=c, fn=handler, tz=tz, jitter=jitter)

    def unschedule(self, name: str) -> None:
        """Remove a schedule."""
        self._handlers.pop(name, None)
        self._conn.execute("DELETE FROM _schedules WHERE name = ?", (name,))

    def next(self, name: str) -> Optional[int]:
        """The next scheduled run (epoch ms) for a registered schedule, or ``None``."""
        row = self._conn.execute(
            "SELECT next_run FROM _schedules WHERE name = ?", (name,)
        ).fetchone()
        return row[0] if row is not None else None

    def tick(self) -> None:
        """Run one scheduling pass: fire every due schedule, atomically.

        For each due schedule the next run is recomputed and a conditional ``UPDATE`` on
        ``next_run`` claims the occurrence; only the process whose ``UPDATE`` changed a
        row calls the handler. A handler that raises is swallowed so siblings still run.
        """
        t = _now_ms()
        for name, reg in list(self._handlers.items()):
            row = self._conn.execute(
                "SELECT next_run FROM _schedules WHERE name = ?", (name,)
            ).fetchone()
            if row is None or row[0] > t:
                continue
            next_run = self._compute_next(
                reg.c, datetime.fromtimestamp(t / 1000, timezone.utc), reg.tz, reg.jitter
            )
            # Atomic claim: only the writer that flips next_run gets to fire.
            cur = self._conn.execute(
                "UPDATE _schedules SET last_run = ?, next_run = ? WHERE name = ? AND next_run <= ?",
                (t, next_run, name, t),
            )
            if cur.rowcount > 0:
                try:
                    reg.fn()
                except Exception:
                    pass  # a failing handler must not break sibling schedules

    def stop(self) -> None:
        """Provided for parity with the TS API; scheduling here is caller-driven via
        :meth:`tick`, so there is nothing running to cancel."""
        self._handlers.clear()


def create_cron(db, check_interval: int = 1000) -> Cron:
    """Create a persisted cron scheduler over a monlite database."""
    return Cron(db, check_interval=check_interval)
