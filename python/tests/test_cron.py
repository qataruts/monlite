import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from monlite import create_db
from monlite.cron import create_cron, next_cron_run, parse_cron


# ── parse_cron ────────────────────────────────────────────────────────────────
def test_parse_step():
    c = parse_cron("*/5 * * * *")
    assert c.minute == {0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}
    assert c.hour == set(range(24))
    assert not c.dom_restricted and not c.dow_restricted


def test_parse_range_and_list():
    c = parse_cron("0 9-17 1,15 * 1-5")
    assert c.hour == {9, 10, 11, 12, 13, 14, 15, 16, 17}
    assert c.dom == {1, 15}
    assert c.dow == {1, 2, 3, 4, 5}
    assert c.dom_restricted and c.dow_restricted


def test_parse_bare_n_vs_step_from_n():
    # bare N -> exactly {N}
    assert parse_cron("7 * * * *").minute == {7}
    # N/step -> from N up to max, stepping
    assert parse_cron("5/15 * * * *").minute == {5, 20, 35, 50}


def test_parse_invalid():
    with pytest.raises(ValueError):
        parse_cron("0 9 * *")  # only 4 fields
    with pytest.raises(ValueError):
        parse_cron("99 * * * *")  # minute out of range
    with pytest.raises(ValueError):
        parse_cron("0 0 0 * *")  # dom below 1


# ── next_cron_run ─────────────────────────────────────────────────────────────
def test_next_basic_daily_9am():
    base = datetime(2026, 6, 29, 8, 0, tzinfo=timezone.utc)  # local-zone test below
    nxt = next_cron_run("0 9 * * *", from_dt=base)
    assert nxt.hour == 9 and nxt.minute == 0
    assert nxt > base


def test_next_strictly_after():
    base = datetime(2026, 6, 29, 9, 0, tzinfo=timezone.utc)
    # already 09:00 -> next match is tomorrow, not the same instant
    nxt = next_cron_run("0 9 * * *", from_dt=base)
    assert nxt > base
    assert nxt.hour == 9 and nxt.minute == 0


def test_next_every_5_min():
    base = datetime(2026, 6, 29, 12, 2, tzinfo=timezone.utc)
    nxt = next_cron_run("*/5 * * * *", from_dt=base)
    assert nxt.minute == 5


def test_leap_day_resolves_across_4_year_gap():
    # From mid-2026, the next Feb-29 is 2028 (2027 is not a leap year).
    base = datetime(2026, 6, 29, 0, 0, tzinfo=timezone.utc)
    nxt = next_cron_run("0 0 29 2 *", from_dt=base, tz="UTC")
    assert nxt.month == 2 and nxt.day == 29 and nxt.year == 2028
    assert nxt.hour == 0 and nxt.minute == 0


def test_tz_yields_correct_utc_instant():
    # 14:30 Asia/Tokyo (UTC+9, no DST) == 05:30 UTC the same wall day.
    base = datetime(2026, 6, 29, 0, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
    nxt = next_cron_run("30 14 * * *", from_dt=base, tz="Asia/Tokyo")
    assert nxt.hour == 14 and nxt.minute == 30  # wall-clock in Tokyo
    utc = nxt.astimezone(timezone.utc)
    assert utc.hour == 5 and utc.minute == 30
    assert nxt.year == 2026 and nxt.month == 6 and nxt.day == 29


# ── performance: prove whole-day/hour skipping (no minute scan) ────────────────
def test_perf_impossible_schedule_raises_fast():
    # Feb never has 31 days -> impossible; must raise quickly, not scan ~2.6M minutes.
    base = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    start = time.perf_counter()
    with pytest.raises(ValueError):
        next_cron_run("0 0 31 2 *", from_dt=base, tz="UTC")
    elapsed = time.perf_counter() - start
    assert elapsed < 2.0, f"impossible schedule took {elapsed:.3f}s"


def test_perf_leap_day_resolves_fast():
    base = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
    start = time.perf_counter()
    nxt = next_cron_run("0 0 29 2 *", from_dt=base, tz="UTC")
    elapsed = time.perf_counter() - start
    assert nxt.month == 2 and nxt.day == 29
    assert elapsed < 2.0, f"tz leap-day took {elapsed:.3f}s"


# ── scheduler: schedule / tick / next ─────────────────────────────────────────
def test_schedule_tick_fires_and_advances():
    db = create_db(":memory:")
    try:
        cron = create_cron(db)
        fired = []
        cron.schedule("job", "* * * * *", lambda: fired.append(1))
        # Force the schedule due now so tick() claims and fires it.
        first_next = cron.next("job")
        db.sqlite.execute(
            "UPDATE _schedules SET next_run = ? WHERE name = ?",
            (int(time.time() * 1000) - 1, "job"),
        )
        cron.tick()
        assert fired == [1]
        advanced = cron.next("job")
        assert advanced > first_next - 60_000  # next_run was moved forward
        # A second immediate tick should NOT re-fire (already advanced into future).
        cron.tick()
        assert fired == [1]
    finally:
        db.close()


def test_handler_exception_does_not_break_siblings():
    db = create_db(":memory:")
    try:
        cron = create_cron(db)
        order = []

        def boom():
            order.append("boom")
            raise RuntimeError("nope")

        cron.schedule("a", "* * * * *", boom)
        cron.schedule("b", "* * * * *", lambda: order.append("b"))
        now = int(time.time() * 1000) - 1
        db.sqlite.execute("UPDATE _schedules SET next_run = ?", (now,))
        cron.tick()  # must not raise; both handlers run
        assert "boom" in order and "b" in order
    finally:
        db.close()


def test_unchanged_expr_reschedule_keeps_next_run():
    db = create_db(":memory:")
    try:
        cron = create_cron(db)
        cron.schedule("daily", "0 9 * * *", lambda: None)
        n1 = cron.next("daily")
        # Re-schedule with the SAME expr -> stored next_run preserved.
        cron.schedule("daily", "0 9 * * *", lambda: None)
        assert cron.next("daily") == n1
        # Re-schedule with a DIFFERENT expr -> recomputed (changes).
        cron.schedule("daily", "0 10 * * *", lambda: None)
        assert cron.next("daily") != n1
    finally:
        db.close()


def test_unschedule_removes_row():
    db = create_db(":memory:")
    try:
        cron = create_cron(db)
        cron.schedule("x", "* * * * *", lambda: None)
        assert cron.next("x") is not None
        cron.unschedule("x")
        assert cron.next("x") is None
    finally:
        db.close()


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-q"]))
