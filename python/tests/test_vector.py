"""Vector / semantic search — brute-force fallback (always) + native vec0 (if sqlite-vec)."""
import pytest

from monlite import create_db
from monlite.vector import VectorStore, hybrid_search, vector


def _seed(db):
    d = db.collection("docs")
    d.create({"_id": "a", "text": "black holes and gravity", "embedding": [1.0, 0.0, 0.0]})
    d.create({"_id": "b", "text": "baking sourdough bread", "embedding": [0.0, 1.0, 0.0]})
    d.create({"_id": "c", "text": "neutron stars", "embedding": [0.9, 0.1, 0.0]})
    return d


def test_find_similar_ranks_by_distance():
    db = create_db(":memory:")
    _seed(db)
    vec = vector(db, "docs", field="embedding", dimensions=3)
    res = vec.find_similar([1.0, 0.0, 0.0], top_k=2)
    assert [r["_id"] for r in res] == ["a", "c"]
    assert res[0]["_distance"] == 0.0


def test_indexes_on_write_and_drops_on_delete():
    db = create_db(":memory:")
    d = _seed(db)
    vec = vector(db, "docs", field="embedding", dimensions=3)
    d.create({"_id": "e", "text": "event horizon", "embedding": [0.95, 0.05, 0.0]})
    ids = {r["_id"] for r in vec.find_similar([1.0, 0.0, 0.0], top_k=10)}
    assert "e" in ids
    d.delete({"_id": "e"})
    ids = {r["_id"] for r in vec.find_similar([1.0, 0.0, 0.0], top_k=10)}
    assert "e" not in ids


def test_cosine_distance():
    db = create_db(":memory:")
    _seed(db)
    vec = vector(db, "docs", field="embedding", dimensions=3, distance="cosine")
    res = vec.find_similar([1.0, 0.0, 0.0], top_k=1)
    assert abs(res[0]["_distance"]) < 1e-9  # same direction → distance ~0


def test_where_filter():
    db = create_db(":memory:")
    _seed(db)
    vec = vector(db, "docs", field="embedding", dimensions=3)
    res = vec.find_similar([1.0, 0.0, 0.0], top_k=5, where={"text": {"contains": "stars"}})
    assert [r["_id"] for r in res] == ["c"]


def test_dimension_guard():
    db = create_db(":memory:")
    _seed(db)
    vec = vector(db, "docs", field="embedding", dimensions=3)
    with pytest.raises(ValueError):
        vec.find_similar([1.0, 0.0], top_k=1)


def test_missing_embedding_is_skipped():
    db = create_db(":memory:")
    d = db.collection("docs")
    d.create({"_id": "x", "text": "no vector here"})  # no embedding field
    d.create({"_id": "y", "text": "has one", "embedding": [0.1, 0.2, 0.3]})
    vec = vector(db, "docs", field="embedding", dimensions=3)
    ids = {r["_id"] for r in vec.find_similar([0.1, 0.2, 0.3], top_k=10)}
    assert ids == {"y"}  # x un-indexed, no crash


def test_backfills_existing_docs():
    db = create_db(":memory:")
    _seed(db)  # docs exist BEFORE the index
    vec = vector(db, "docs", field="embedding", dimensions=3)
    assert vec._count() == 3  # backfilled on construction


def test_hybrid_search_combines_fts_and_vector():
    from monlite.fts import fts as fts_index

    db = create_db(":memory:")
    _seed(db)
    vector(db, "docs", field="embedding", dimensions=3)
    try:
        fts_index(db, "docs", fields=["text"])  # needs FTS5 in this sqlite3
    except Exception:
        pytest.skip("FTS5 not available")
    hits = hybrid_search(db, "docs", text="stars", query_vector=[0.9, 0.1, 0.0], top_k=3)
    assert all("_distance" in h for h in hits)
    assert any(h["_id"] == "c" for h in hits)


def test_hybrid_requires_vector_index():
    db = create_db(":memory:")
    _seed(db)
    with pytest.raises(RuntimeError):
        hybrid_search(db, "docs", text="x", query_vector=[1.0, 0.0, 0.0])


def test_uses_native_when_sqlite_vec_available():
    # Documents which mode is active; the native vec0 path is covered by the TS
    # suite + interop when sqlite-vec + an extension-enabled sqlite3 are present.
    db = create_db(":memory:")
    _seed(db)
    vec = vector(db, "docs", field="embedding", dimensions=3)
    try:
        import sqlite_vec  # noqa: F401
        # native is only on if the stdlib sqlite3 also permits extension loading
        assert isinstance(vec.native, bool)
    except Exception:
        assert vec.native is False
