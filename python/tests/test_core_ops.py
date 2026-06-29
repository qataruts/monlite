"""Newer core parity: regex/elemMatch/endsWith operators, aggregation, transactions."""
import pytest

from monlite import create_db


@pytest.fixture
def col():
    db = create_db(":memory:")
    c = db.collection("p")
    c.create_many(
        [
            {"_id": "1", "sku": "AB-1", "qty": 5, "items": [{"n": "x", "q": 2}, {"n": "y", "q": 9}]},
            {"_id": "2", "sku": "CD-2", "qty": 1, "items": [{"n": "z", "q": 1}]},
        ]
    )
    return c


def test_regex(col):
    assert [d["_id"] for d in col.find_many(where={"sku": {"regex": "^AB"}})] == ["1"]
    assert [d["_id"] for d in col.find_many(where={"sku": {"regex": "ab", "mode": "insensitive"}})] == ["1"]


def test_ends_with(col):
    assert [d["_id"] for d in col.find_many(where={"sku": {"endsWith": "-2"}})] == ["2"]


def test_elem_match_object_and_scalar(col):
    assert [d["_id"] for d in col.find_many(where={"items": {"elemMatch": {"q": {"gte": 5}}}})] == ["1"]
    col.create({"_id": "3", "sku": "EF-3", "qty": 0, "nums": [1, 2, 99]})
    assert [d["_id"] for d in col.find_many(where={"nums": {"elemMatch": {"gt": 50}}})] == ["3"]


def test_not_and_not_in(col):
    assert [d["_id"] for d in col.find_many(where={"sku": {"not": "AB-1"}})] == ["2"]
    assert [d["_id"] for d in col.find_many(where={"qty": {"notIn": [5]}})] == ["2"]


def test_aggregate():
    db = create_db(":memory:")
    o = db.collection("o")
    o.create_many([{"cat": "a", "amt": 10}, {"cat": "a", "amt": 20}, {"cat": "b", "amt": 5}])
    agg = o.aggregate(_count=True, _sum=["amt"], _avg=["amt"], _min=["amt"], _max=["amt"])
    assert agg["_count"] == 3
    assert agg["_sum"]["amt"] == 35
    assert agg["_avg"]["amt"] == 35 / 3
    assert agg["_min"]["amt"] == 5 and agg["_max"]["amt"] == 20


def test_group_by():
    db = create_db(":memory:")
    o = db.collection("o")
    o.create_many([{"cat": "a", "amt": 10}, {"cat": "a", "amt": 20}, {"cat": "b", "amt": 5}])
    groups = {r["cat"]: r for r in o.group_by("cat", _count=True, _sum=["amt"])}
    assert groups["a"]["_count"] == 2 and groups["a"]["_sum"]["amt"] == 30
    assert groups["b"]["_count"] == 1 and groups["b"]["_sum"]["amt"] == 5


def test_transaction_commit_and_rollback():
    db = create_db(":memory:")
    t = db.collection("t")
    t.create({"_id": "keep"})
    with db.transaction():
        t.create({"_id": "x"})
        t.create({"_id": "y"})
    assert t.count() == 3
    with pytest.raises(RuntimeError):
        with db.transaction():
            t.create({"_id": "z"})
            raise RuntimeError("boom")
    assert t.find_by_id("z") is None
    assert t.count() == 3


def test_nested_transaction_savepoint_rollback():
    db = create_db(":memory:")
    t = db.collection("t")
    with db.transaction():
        t.create({"_id": "outer"})
        try:
            with db.transaction():
                t.create({"_id": "inner"})
                raise RuntimeError("inner boom")
        except RuntimeError:
            pass
    # outer commits, inner savepoint rolled back
    assert t.find_by_id("outer") is not None
    assert t.find_by_id("inner") is None
