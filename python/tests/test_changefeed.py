"""The change feed: record-on-write + db.changes() reader, in the TS on-disk format."""
from monlite import create_db


def test_records_upsert_and_delete_ops():
    db = create_db(":memory:", changefeed=True)
    c = db.collection("users")
    c.create({"_id": "a", "name": "Ada", "age": 30})
    c.update({"_id": "a"}, {"$inc": {"age": 1}})
    c.create({"_id": "b", "name": "Bo"})
    c.delete({"_id": "b"})
    changes = db.changes()
    assert [c["op"] for c in changes] == ["upsert", "upsert", "upsert", "delete"]
    assert db.current_seq() == 4


def test_version_string_matches_ts_layout():
    db = create_db(":memory:", changefeed=True)
    db.collection("c").create({"_id": "x"})
    v = db.changes()[0]["version"]
    # <zero-padded-ms (15)>:<nodeId>:<zero-padded-seq (12)>
    parts = v.split(":")
    assert len(parts) == 3
    assert len(parts[0]) == 15 and parts[0].isdigit()
    assert len(parts[2]) == 12 and parts[2].isdigit()


def test_changes_pages_by_since_and_filters_by_coll():
    db = create_db(":memory:", changefeed=True)
    db.collection("a").create({"_id": "1"})
    db.collection("b").create({"_id": "2"})
    db.collection("a").create({"_id": "3"})
    assert len(db.changes(since=1)) == 2
    assert [c["doc_id"] for c in db.changes(coll="a")] == ["1", "3"]


def test_disabled_by_default():
    db = create_db(":memory:")
    db.collection("c").create({"_id": "1"})
    assert db.changefeed_enabled is False


def test_rollback_discards_change_rows():
    db = create_db(":memory:", changefeed=True)
    t = db.collection("t")
    t.create({"_id": "keep"})
    try:
        with db.transaction():
            t.create({"_id": "ghost"})
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert t.find_by_id("ghost") is None
    assert not any(c["doc_id"] == "ghost" for c in db.changes())


def test_seq_continues_monotonically_across_opens(tmp_path):
    p = str(tmp_path / "feed.db")
    db = create_db(p, changefeed=True)
    db.collection("c").create({"_id": "1"})
    first_seq = db.changes()[0]["version"].split(":")[2]
    db.close()
    db2 = create_db(p, changefeed=True)
    db2.collection("c").create({"_id": "2"})
    second_seq = db2.changes()[-1]["version"].split(":")[2]
    assert int(second_seq) > int(first_seq)  # tiebreaker keeps climbing
    db2.close()
