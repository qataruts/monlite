"""monlite.fts — full-text search over SQLite FTS5.

Mirrors the @monlite/fts TypeScript test suite: index-on-write + rank, updates/deletes,
where-filtering, nested (dot-path) fields, cross-process catch_up, malformed-input safety,
and the dynamic programmatic index. Skips cleanly when FTS5 isn't compiled into sqlite3.
"""
import os
import sqlite3
import tempfile

import pytest

from monlite import create_db
from monlite.fts import create_dynamic_search_index, create_search_index, fts


def _fts5_available() -> bool:
    c = sqlite3.connect(":memory:")
    try:
        c.execute("CREATE VIRTUAL TABLE _t USING fts5(x)")
        return True
    except Exception:
        return False
    finally:
        c.close()


# Skip the whole module (don't fail) if FTS5 is unavailable in this Python's sqlite3.
pytestmark = pytest.mark.skipif(not _fts5_available(), reason="SQLite FTS5 not available")


@pytest.fixture
def db():
    d = create_db(":memory:")
    yield d
    d.close()


def _ids(rows):
    return [r["_id"] for r in rows]


# ── document-collection index (the `fts()` plugin analogue) ──────────────────
def test_indexes_on_write_and_searches_by_rank(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "title": "Hello world", "body": "the quick brown fox"})
    posts.create({"_id": "2", "title": "Goodbye", "body": "lazy dog sleeps"})

    index = fts(db, "posts", fields=["title", "body"])
    r = index.search("quick")
    assert _ids(r) == ["1"]
    assert isinstance(r[0]["_score"], float)
    assert r[0]["title"] == "Hello world"  # full document returned


def test_doc_inserted_after_index_is_found(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "title": "alpha"})
    index = fts(db, "posts", fields=["title"])
    assert _ids(index.search("beta")) == []

    # written AFTER the index exists — the write hook keeps it in sync
    posts.create({"_id": "2", "title": "beta gamma"})
    assert _ids(index.search("beta")) == ["2"]
    assert _ids(index.search("gamma")) == ["2"]


def test_reflects_updates_and_deletes(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "body": "quick fox"})
    posts.create({"_id": "2", "body": "lazy dog"})
    index = fts(db, "posts", fields=["body"])

    posts.update({"_id": "2"}, {"body": "quick rabbit"})
    assert sorted(_ids(index.search("quick"))) == ["1", "2"]

    posts.delete({"_id": "1"})
    assert _ids(index.search("quick")) == ["2"]


def test_combines_search_with_a_where_filter(db):
    posts = db.collection("posts")
    posts.create_many(
        [
            {"_id": "1", "title": "quick start", "status": "published"},
            {"_id": "2", "title": "quick notes", "status": "draft"},
        ]
    )
    index = fts(db, "posts", fields=["title"])
    r = index.search("quick", where={"status": "draft"})
    assert _ids(r) == ["2"]


def test_searches_nested_dot_path_fields(db):
    users = db.collection("users")
    users.create({"_id": "u1", "name": "Ali", "profile": {"bio": "loves astronomy"}})
    index = fts(db, "users", fields=["name", "profile.bio"])
    assert _ids(index.search("astronomy")) == ["u1"]


def test_prefix_and_multiword_queries(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "body": "the quick brown fox"})
    posts.create({"_id": "2", "body": "slow green turtle"})
    index = fts(db, "posts", fields=["body"])

    # multi-word terms are AND-ed
    assert _ids(index.search("quick fox")) == ["1"]
    assert _ids(index.search("quick turtle")) == []
    # prefix query
    assert _ids(index.search("qui*")) == ["1"]
    # OR
    assert sorted(_ids(index.search("fox OR turtle"))) == ["1", "2"]


def test_limit_zero_returns_nothing(db):
    posts = db.collection("posts")
    posts.create_many([{"body": "apple"}, {"body": "apple"}])
    index = fts(db, "posts", fields=["body"])
    assert index.search("apple", limit=0) == []
    assert index.search("apple", limit=0, where={"body": "apple"}) == []


def test_search_tolerates_malformed_fts5_input(db):
    posts = db.collection("posts")
    posts.create_many([{"body": "the quick brown fox"}])
    index = fts(db, "posts", fields=["body"])
    for q in ["quick", 'a "b', '"', "AND", "fox*", "x:y", "a OR", "("]:
        assert index.search(q) is not None  # never raises
    assert len(index.search("quick")) == 1


def test_backfills_existing_documents_when_enabled_later():
    # A file written WITHOUT fts, then opened and indexed — existing docs are backfilled.
    tmp = tempfile.mkdtemp(prefix="monlite-fts-")
    path = os.path.join(tmp, "app.db")
    a = create_db(path)
    a.collection("posts").create({"_id": "p1", "title": "prewritten content"})
    a.close()

    b = create_db(path)
    try:
        index = fts(b, "posts", fields=["title"])
        assert _ids(index.search("prewritten")) == ["p1"]
    finally:
        b.close()


def test_catch_up_picks_up_cross_process_writes_and_deletes():
    tmp = tempfile.mkdtemp(prefix="monlite-fts-")
    path = os.path.join(tmp, "app.db")
    reader = create_db(path)
    writer = create_db(path)  # separate connection (no index hooks)
    try:
        index = fts(reader, "posts", fields=["title"])

        # the writer adds a doc — the reader's index doesn't know about it yet
        writer.collection("posts").create({"_id": "p1", "title": "hello world"})
        assert len(index.search("hello")) == 0

        res = index.catch_up()
        assert res["indexed"] > 0
        assert _ids(index.search("hello")) == ["p1"]

        # a cross-process delete is reconciled too
        writer.collection("posts").delete({"_id": "p1"})
        res2 = index.catch_up()
        assert res2["removed"] == 1
        assert len(index.search("hello")) == 0
    finally:
        reader.close()
        writer.close()


def test_catch_up_indexes_past_timestamp_docs(db):
    posts = db.collection("posts")
    posts.create_many([{"_id": "x", "body": "alpha"}])
    index = fts(db, "posts", fields=["body"])
    # simulate a cross-process write with a past (below high-water) timestamp
    db.sqlite.execute(
        'INSERT INTO "posts" (_id, data, created_at, updated_at) VALUES (?, ?, 1, 1)',
        ("y", '{"body":"beta"}'),
    )
    index.catch_up()
    assert _ids(index.search("beta")) == ["y"]


def test_reindex_rebuilds_from_scratch(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "body": "quick fox"})
    index = fts(db, "posts", fields=["body"])
    assert _ids(index.search("quick")) == ["1"]
    index.reindex()
    assert _ids(index.search("quick")) == ["1"]  # no duplicate/loss after rebuild
    assert len(index.search("quick")) == 1


def test_create_search_index_alias(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "body": "hello"})
    index = create_search_index(db, "posts", fields=["body"])
    assert _ids(index.search("hello")) == ["1"]


def test_collection_search_attached(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "title": "quick brown fox"})
    fts(db, "posts", fields=["title"])
    # the index attaches `search` onto the collection object, mirroring TS ergonomics
    assert _ids(posts.search("quick")) == ["1"]


# ── interop: the on-disk DDL matches what @monlite/fts writes ────────────────
def test_on_disk_ddl_matches_ts(db):
    posts = db.collection("posts")
    posts.create({"_id": "1", "title": "a", "body": "b"})
    fts(db, "posts", fields=["title", "body"])

    sql = db.sqlite.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'posts_fts'"
    ).fetchone()[0]
    norm = " ".join(sql.split())
    # exact fts5 column list the TS produces: doc_id UNINDEXED + f0, f1, ...
    assert 'USING fts5(doc_id UNINDEXED, "f0", "f1")' in norm

    # bookkeeping tables exist with the TS names; NO triggers were created
    names = {
        r[0]
        for r in db.sqlite.execute("SELECT name FROM sqlite_master").fetchall()
    }
    assert "_monlite_fts_state" in names
    assert "_monlite_fts_ids" in names
    triggers = db.sqlite.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='trigger'"
    ).fetchone()[0]
    assert triggers == 0  # the TS keeps in sync via a hook, not triggers


# ── dynamic programmatic index (createSearchIndex analogue) ──────────────────
def test_dynamic_index_searches_by_relevance(db):
    idx = create_dynamic_search_index(db)
    idx.ensure_collection("docs", fields=["title", "body"], filter_fields=["docId"])
    idx.upsert(
        "docs",
        [
            {"id": "c1", "fields": {"title": "hello world", "body": "the quick brown fox"}, "filters": {"docId": "d1"}},
            {"id": "c2", "fields": {"title": "goodbye", "body": "lazy dog sleeps"}, "filters": {"docId": "d2"}},
        ],
    )
    hits = idx.search("docs", "quick fox")
    assert [h["id"] for h in hits] == ["c1"]
    assert hits[0]["score"] > -100


def test_dynamic_index_scopes_with_where(db):
    idx = create_dynamic_search_index(db)
    idx.ensure_collection("docs", fields=["body"], filter_fields=["docId"])
    idx.upsert(
        "docs",
        [
            {"id": "a", "fields": {"body": "contract terms and conditions"}, "filters": {"docId": "d1"}},
            {"id": "b", "fields": {"body": "contract pricing schedule"}, "filters": {"docId": "d2"}},
        ],
    )
    assert len(idx.search("docs", "contract")) == 2
    scoped = idx.search("docs", "contract", where={"docId": "d1"})
    assert [h["id"] for h in scoped] == ["a"]


def test_dynamic_index_upsert_idempotent_and_delete(db):
    idx = create_dynamic_search_index(db)
    idx.ensure_collection("docs", fields=["body"], filter_fields=["docId"])
    idx.upsert("docs", [{"id": "a", "fields": {"body": "alpha"}, "filters": {"docId": "d1"}}])
    idx.upsert("docs", [{"id": "a", "fields": {"body": "beta"}, "filters": {"docId": "d1"}}])
    assert len(idx.search("docs", "alpha")) == 0
    assert [h["id"] for h in idx.search("docs", "beta")] == ["a"]

    idx.upsert("docs", [{"id": "b", "fields": {"body": "beta"}, "filters": {"docId": "d2"}}])
    idx.delete("docs", id="a")
    assert [h["id"] for h in idx.search("docs", "beta")] == ["b"]
    idx.delete("docs", where={"docId": "d2"})
    assert len(idx.search("docs", "beta")) == 0


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-q"]))
