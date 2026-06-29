"""monlite vector — semantic / similarity search, byte-compatible with @monlite/vector.

Each indexed collection gets a ``<collection>_vec`` table plus ``_monlite_vec_state``
bookkeeping. When the optional ``sqlite-vec`` extension loads (``pip install monlite[vector]``
and an extension-enabled ``sqlite3``), it's a ``vec0`` virtual table — fast ANN at 10K–100K+
vectors. Otherwise it falls back to a plain ``(doc_id, embedding TEXT)`` table with an exact
brute-force scan in Python (fine for the thousands-of-vectors scale a local store holds). Both
modes store embeddings as the **same JSON array string** the TS side writes, so a fallback index
round-trips with the TS fallback index (and a native one with the TS native index).

    from monlite import create_db
    from monlite.vector import vector

    db = create_db("app.db")
    db.collection("docs").create({"_id": "a", "text": "black holes", "embedding": [0.1, 0.2, 0.3]})
    vec = vector(db, "docs", field="embedding", dimensions=3)
    vec.find_similar([0.1, 0.2, 0.3], top_k=5)        # -> docs with a `_distance`
"""
from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional, Sequence

from .core import _get_path

_STATE = "_monlite_vec_state"
_WRITE_METHODS = (
    "create",
    "create_many",
    "update",
    "update_many",
    "upsert",
    "delete",
    "delete_many",
)


def _vec_table(coll: str) -> str:
    return f"{coll}_vec"


def _dumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def _l2(a: Sequence[float], b: Sequence[float]) -> float:
    return math.sqrt(sum((x - y) * (x - y) for x, y in zip(a, b)))


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    denom = na * nb
    return 1.0 if denom == 0 else 1.0 - dot / denom


def _try_load_sqlite_vec(conn: Any) -> bool:
    """Load the sqlite-vec extension if available + permitted; else use the JS-style fallback."""
    try:
        import sqlite_vec  # type: ignore
    except Exception:
        return False
    try:
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return True
    except Exception:
        return False


class VectorStore:
    """A vector index over one collection's embedding field, kept current on every write."""

    def __init__(
        self,
        db: Any,
        collection: str,
        field: str = "embedding",
        dimensions: int = 0,
        distance: str = "l2",
    ) -> None:
        if not dimensions or dimensions < 1:
            raise ValueError("monlite.vector: `dimensions` is required (the embedding length)")
        if distance not in ("l2", "cosine"):
            raise ValueError("monlite.vector: distance must be 'l2' or 'cosine'")
        self._db = db
        self._sqlite = db.sqlite
        self.collection = collection
        self.field = field
        self.dimensions = dimensions
        self.distance = distance
        self.native = _try_load_sqlite_vec(self._sqlite)
        self._ensure_state()
        self._ensure_table()
        if self._count() == 0:
            self.reindex()
        self.catch_up()
        self._install_hooks()

    # -- DDL (byte-identical to the TS) ---------------------------------------
    def _ensure_state(self) -> None:
        self._sqlite.execute(
            f"CREATE TABLE IF NOT EXISTS {_STATE} (coll TEXT PRIMARY KEY, high_water INTEGER NOT NULL)"
        )

    def _ensure_table(self) -> None:
        t = _vec_table(self.collection)
        if self.native:
            metric = " distance_metric=cosine" if self.distance == "cosine" else ""
            self._sqlite.execute(
                f'CREATE VIRTUAL TABLE IF NOT EXISTS "{t}" '
                f"USING vec0(doc_id text primary key, embedding float[{self.dimensions}]{metric})"
            )
        else:
            self._sqlite.execute(
                f'CREATE TABLE IF NOT EXISTS "{t}" (doc_id TEXT PRIMARY KEY, embedding TEXT NOT NULL)'
            )

    def _count(self) -> int:
        return self._sqlite.execute(
            f'SELECT count(*) FROM "{_vec_table(self.collection)}"'
        ).fetchone()[0]

    # -- high-water bookkeeping -----------------------------------------------
    def _high_water(self) -> int:
        row = self._sqlite.execute(
            f"SELECT high_water FROM {_STATE} WHERE coll = ?", (self.collection,)
        ).fetchone()
        return row[0] if row else 0

    def _set_high_water(self, value: int) -> None:
        self._sqlite.execute(
            f"INSERT INTO {_STATE}(coll, high_water) VALUES (?, ?) "
            "ON CONFLICT(coll) DO UPDATE SET high_water = excluded.high_water",
            (self.collection, value),
        )

    # -- indexing -------------------------------------------------------------
    def _embedding(self, doc: Dict[str, Any]) -> Optional[List[float]]:
        emb = _get_path(doc, self.field)
        if not isinstance(emb, list) or len(emb) != self.dimensions:
            return None
        return [float(x) for x in emb]

    def _index_doc(self, doc_id: str) -> None:
        t = _vec_table(self.collection)
        self._sqlite.execute(f'DELETE FROM "{t}" WHERE doc_id = ?', (doc_id,))
        doc = self._db.collection(self.collection).find_by_id(doc_id)
        if not doc:
            return
        emb = self._embedding(doc)
        if emb is None:
            return  # no (valid) embedding on this document yet
        self._sqlite.execute(
            f'INSERT INTO "{t}"(doc_id, embedding) VALUES (?, ?)', (doc_id, _dumps(emb))
        )

    def reindex(self) -> None:
        self._sqlite.execute(f'DELETE FROM "{_vec_table(self.collection)}"')
        for doc in self._db.collection(self.collection).find_many():
            self._index_doc(doc["_id"])

    def catch_up(self) -> Dict[str, int]:
        """Index docs written since the last pass and drop entries for deleted docs."""
        hw = self._high_water()
        docs = self._sqlite.execute(
            f'SELECT _id, updated_at FROM "{self.collection}" WHERE updated_at >= ?', (hw,)
        ).fetchall()
        mx = hw
        for _id, updated_at in docs:
            self._index_doc(_id)
            if updated_at > mx:
                mx = updated_at
        orphans = self._sqlite.execute(
            f'SELECT doc_id FROM "{_vec_table(self.collection)}" '
            f'WHERE doc_id NOT IN (SELECT _id FROM "{self.collection}")'
        ).fetchall()
        for (doc_id,) in orphans:
            self._sqlite.execute(
                f'DELETE FROM "{_vec_table(self.collection)}" WHERE doc_id = ?', (doc_id,)
            )
        self._set_high_water(mx)
        return {"indexed": len(docs), "removed": len(orphans)}

    # -- search ---------------------------------------------------------------
    def find_similar(
        self,
        vector: Sequence[float],
        top_k: int = 10,
        where: Optional[Dict[str, Any]] = None,
        candidates: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Nearest neighbours of `vector`; returns docs each with an added `_distance`."""
        if not isinstance(vector, (list, tuple)) or len(vector) != self.dimensions:
            raise ValueError(
                f"find_similar expects a {self.dimensions}-dimension vector for '{self.collection}'"
            )
        coll = self._db.collection(self.collection)
        if self.native:
            k = min(4096, max(candidates or top_k * 10, 200) if where else top_k)
            rows = self._sqlite.execute(
                f'SELECT doc_id, distance FROM "{_vec_table(self.collection)}" '
                "WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                (_dumps([float(x) for x in vector]), k),
            ).fetchall()
        else:
            dist = _cosine if self.distance == "cosine" else _l2
            rows = []
            for doc_id, emb in self._sqlite.execute(
                f'SELECT doc_id, embedding FROM "{_vec_table(self.collection)}"'
            ).fetchall():
                rows.append((doc_id, dist(vector, json.loads(emb))))
            rows.sort(key=lambda r: r[1])

        allowed = None
        if where is not None:
            allowed = {d["_id"] for d in coll.find_many(where=where)}
        out: List[Dict[str, Any]] = []
        for doc_id, distance in rows:
            if allowed is not None and doc_id not in allowed:
                continue
            doc = coll.find_by_id(doc_id)
            if doc:
                doc["_distance"] = distance
                out.append(doc)
            if len(out) >= top_k:
                break
        return out

    # -- keep the index current on writes (no core plugin hook) ---------------
    def _install_hooks(self) -> None:
        coll = self._db.collection(self.collection)
        if getattr(coll, "_monlite_vec_hooked", False):
            setattr(coll, "find_similar", self.find_similar)
            return
        for name in _WRITE_METHODS:
            original = getattr(coll, name, None)
            if original is not None:
                setattr(coll, name, self._wrap(original))
        setattr(coll, "_monlite_vec_hooked", True)
        setattr(coll, "find_similar", self.find_similar)
        setattr(coll, "catch_up_vectors", self.catch_up)

    def _wrap(self, original: Any) -> Any:
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            result = original(*args, **kwargs)
            self.catch_up()
            return result

        return wrapped


def vector(
    db: Any,
    collection: str,
    field: str = "embedding",
    dimensions: int = 0,
    distance: str = "l2",
) -> VectorStore:
    """Add vector / semantic search to a collection's embedding field.

    Adds ``collection.find_similar(...)``, keeps the index current on writes, and backfills
    existing documents. Pass ``distance="cosine"`` for cosine similarity (default L2).
    """
    return VectorStore(db, collection, field=field, dimensions=dimensions, distance=distance)


def hybrid_search(
    db: Any,
    collection: str,
    text: str,
    query_vector: Sequence[float],
    top_k: int = 10,
    where: Optional[Dict[str, Any]] = None,
    candidates: int = 50,
) -> List[Dict[str, Any]]:
    """Combine full-text and vector search: FTS narrows candidates, vectors re-rank them.

    The collection must already be both vector-indexed (:func:`vector`) and, for the text leg,
    FTS-indexed (:func:`monlite.fts.fts`).
    """
    coll = db.collection(collection)
    find_similar = getattr(coll, "find_similar", None)
    if find_similar is None:
        raise RuntimeError(
            "hybrid_search: collection is not vector-indexed — call vector(db, collection, ...) first"
        )
    search = getattr(coll, "search", None)
    text_ids: List[str] = []
    if search is not None and text:
        text_ids = [d["_id"] for d in search(text, limit=candidates, where=where)]
    constraint = where
    if text_ids:
        constraint = {"AND": [where, {"_id": {"in": text_ids}}]} if where else {"_id": {"in": text_ids}}
    return find_similar(query_vector, top_k=top_k, where=constraint, candidates=candidates)


__all__ = ["vector", "VectorStore", "hybrid_search"]
