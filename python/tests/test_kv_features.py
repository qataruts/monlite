"""kv parity: locks (set_nx + with_lock), pub/sub, sorted sets (ZSET)."""
import pytest

from monlite import create_db, kv


def test_locks():
    c = kv(create_db(":memory:"))
    token = c.lock("job")
    assert isinstance(token, str)
    assert c.lock("job") is None  # exclusive
    assert c.unlock("job", "wrong") is False
    assert c.unlock("job", token) is True
    assert c.lock("job") is not None  # released → re-acquirable


def test_with_lock_releases():
    c = kv(create_db(":memory:"))
    with c.with_lock("res") as tok:
        assert isinstance(tok, str)
        with pytest.raises(RuntimeError):  # already held → raises
            with c.with_lock("res"):
                pass
    assert c.lock("res") is not None  # released on exit


def test_pubsub_local_and_poll():
    db = create_db(":memory:")
    a = kv(db)
    seen = []
    unsub = a.subscribe("news", lambda m: seen.append(m))
    assert a.publish("news", {"hi": 1}) == 1
    a.publish("other", {"x": 1})
    assert seen == [{"hi": 1}]
    unsub()
    a.publish("news", {"after": "unsub"})
    assert seen == [{"hi": 1}]
    # a second subscriber (own cursor) drains via poll()
    b = kv(db)
    got = []
    b.subscribe("room", lambda m: got.append(m))
    a.publish("room", {"from": "a"})
    assert b.poll() >= 1
    assert got == [{"from": "a"}]


def test_pubsub_no_replay_for_late_subscriber():
    db = create_db(":memory:")
    a = kv(db)
    a.publish("c", {"past": True})
    late = kv(db)
    got = []
    late.subscribe("c", lambda m: got.append(m))
    assert late.poll() == 0
    assert got == []


def test_sorted_sets():
    c = kv(create_db(":memory:"))
    c.zadd("board", 100, "ada")
    c.zadd("board", 60, "bo")
    c.zadd("board", 80, "cy")
    assert c.zrange("board", 0, -1) == ["bo", "cy", "ada"]
    assert c.zrange("board", 0, -1, rev=True) == ["ada", "cy", "bo"]
    assert c.zrange("board", 0.7, 1.9) == ["bo", "cy"]  # fractional floored
    assert c.zscore("board", "ada") == 100
    assert c.zincrby("board", 5, "bo") == 65
    assert c.zrank("board", "ada") == 2
    assert c.zrank("board", "ada", rev=True) == 0
    assert c.zrange_by_score("board", 60, 80) == ["bo", "cy"]
    assert c.zcard("board") == 3
    assert c.zrem("board", "bo") is True and c.zcard("board") == 2


def test_zadd_rejects_nan():
    c = kv(create_db(":memory:"))
    with pytest.raises(ValueError):
        c.zadd("b", float("nan"), "x")
    with pytest.raises(ValueError):
        c.zincrby("b", float("nan"), "x")
