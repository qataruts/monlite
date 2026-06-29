"""monlite fts — full-text search over SQLite FTS5, byte-compatible with @monlite/fts.

The whole point is on-disk interop: the FTS5 virtual table, its columns, the tokenizer
(FTS5's default ``unicode61``), and the bookkeeping tables match what the TypeScript
``@monlite/fts`` writes, so an index built by Node is usable from Python and vice-versa.

For each configured collection ``<coll>`` the package maintains three objects, EXACTLY as
the TS side names and shapes them:

* ``"<coll>_fts"`` — ``CREATE VIRTUAL TABLE ... USING fts5(doc_id UNINDEXED, "f0", "f1", …)``
  One ``f<i>`` column per indexed field, in order; ``doc_id`` (the document ``_id``) is
  stored UNINDEXED so it round-trips but isn't tokenized.
* ``_monlite_fts_state(coll TEXT PRIMARY KEY, high_water INTEGER NOT NULL)`` — the
  ``updated_at`` high-water mark per collection, so :meth:`SearchIndex.catch_up` only
  processes new work.
* ``_monlite_fts_ids(coll TEXT, doc_id TEXT, rid INTEGER, PRIMARY KEY (coll, doc_id))`` —
  a ``doc_id → fts rowid`` map so a per-doc re-index deletes by rowid (O(log n)) instead of
  scanning the UNINDEXED ``doc_id`` column (which made bulk ingestion O(n²)).

The TS plugin keeps the index current through its ``afterWrite`` hook. The Python core has
no plugin hooks, so :func:`fts` wraps the collection's write methods to call the identical
per-doc indexing after each write — producing byte-identical on-disk state, not a different
one (notably: NO triggers, matching the TS, so ``sqlite_master`` stays interop-clean).

    from monlite import create_db
    from monlite.fts import fts

    db = create_db("app.db")
    db.collection("posts").create({"_id": "1", "title": "Hello world", "body": "quick brown fox"})
    index = fts(db, "posts", fields=["title", "body"])
    index.search("quick")   # -> [ { "_id": "1", "title": ..., "_score": float } ]

A second searcher process picks up writes made by another connection with
:meth:`SearchIndex.catch_up` (incrementally) or :meth:`SearchIndex.reindex` (full rebuild),
mirroring the TS ``catchUp``/``reindex``.
"""
from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional, Sequence

# Shared bookkeeping table names — byte-identical to @monlite/fts (src/index.ts).
_STATE = "_monlite_fts_state"
_IDMAP = "_monlite_fts_ids"

# Collection/field identifiers used in the dynamic-index API must be plain SQL
# identifiers (the TS guards these the same way before interpolating them).
_FTS_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Write methods on a core Collection that mutate documents; we wrap these so the
# index stays current on every write (the Python analogue of the TS afterWrite hook).
_WRITE_METHODS = (
    "create",
    "create_many",
    "update",
    "update_many",
    "upsert",
    "delete",
    "delete_many",
)


def _now() -> int:
    return int(time.time() * 1000)


def _fts_table(coll: str) -> str:
    return f"{coll}_fts"


def _col(i: int) -> str:
    return f"f{i}"


def _fts_ident(name: str) -> str:
    if not _FTS_IDENT.match(name):
        raise ValueError(f"monlite.fts: unsafe collection/field name {name!r}")
    return name


def _extract_text(doc: Dict[str, Any], path: str) -> str:
    """Pull searchable text for a dot-path field out of a document (== TS extractText).

    Strings pass through; arrays join their non-null members with spaces; numbers and
    booleans stringify; everything else (objects, null, missing) is empty.
    """
    cur: Any = doc
    for seg in path.split("."):
        if cur is None or not isinstance(cur, dict):
            return ""
        cur = cur.get(seg)
    if cur is None:
        return ""
    if isinstance(cur, str):
        return cur
    if isinstance(cur, bool):
        # bool before int (a bool IS an int in Python); TS prints true/false.
        return "true" if cur else "false"
    if isinstance(cur, (list, tuple)):
        return " ".join(str(x) for x in cur if x is not None)
    if isinstance(cur, (int, float)):
        return str(cur)
    return ""


# ────────────────────────────────────────────────────────────────────────────
# Document-collection index (mirrors the TS `fts()` plugin + `reindex`/`catchUp`)
# ────────────────────────────────────────────────────────────────────────────
class SearchIndex:
    """A full-text index over one document collection, kept in sync on every write.

    Construct via :func:`fts` (or its alias :func:`create_search_index`), which ensures the
    FTS5 table + bookkeeping tables, backfills existing documents, and wraps the collection's
    writes. ``search`` runs an FTS5 ``MATCH`` and returns the live documents in rank order.
    """

    def __init__(self, db: Any, collection: str, fields: Sequence[str]) -> None:
        if not fields:
            raise ValueError("monlite.fts: at least one field is required")
        self._db = db
        self._sqlite = db.sqlite
        self.collection = collection
        self.fields: List[str] = list(fields)
        self._ensure_state()
        self._ensure_table()
        self._migrate_idmap()
        # Backfill when the index is empty (e.g. enabling FTS on an existing db),
        # then pick up anything other processes wrote since we last indexed.
        if self._count() == 0:
            self.reindex()
        self.catch_up()
        self._install_hooks()

    # -- DDL (byte-identical to the TS) ---------------------------------------
    def _ensure_state(self) -> None:
        self._sqlite.execute(
            f"CREATE TABLE IF NOT EXISTS {_STATE} "
            "(coll TEXT PRIMARY KEY, high_water INTEGER NOT NULL)"
        )
        self._sqlite.execute(
            f"CREATE TABLE IF NOT EXISTS {_IDMAP} "
            "(coll TEXT NOT NULL, doc_id TEXT NOT NULL, rid INTEGER NOT NULL, "
            "PRIMARY KEY (coll, doc_id))"
        )

    def _ensure_table(self) -> None:
        cols = ", ".join(f'"{_col(i)}"' for i in range(len(self.fields)))
        self._sqlite.execute(
            f'CREATE VIRTUAL TABLE IF NOT EXISTS "{_fts_table(self.collection)}" '
            f"USING fts5(doc_id UNINDEXED, {cols})"
        )

    def _migrate_idmap(self) -> None:
        # Backfill the doc_id->rowid map for any existing fts rows (databases written
        # before the map existed, e.g. by an older Node build), so re-index deletes hit
        # the right row instead of leaving duplicates.
        self._sqlite.execute(
            f"INSERT OR IGNORE INTO {_IDMAP}(coll, doc_id, rid) "
            f'SELECT ?, doc_id, rowid FROM "{_fts_table(self.collection)}"',
            (self.collection,),
        )

    # -- high-water state -----------------------------------------------------
    def _get_high_water(self) -> int:
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

    def _count(self) -> int:
        return self._sqlite.execute(
            f'SELECT count(*) FROM "{_fts_table(self.collection)}"'
        ).fetchone()[0]

    # -- per-doc indexing (== TS indexDoc) ------------------------------------
    def _index_doc(self, doc_id: str) -> None:
        table = _fts_table(self.collection)
        prev = self._sqlite.execute(
            f"SELECT rid FROM {_IDMAP} WHERE coll = ? AND doc_id = ?",
            (self.collection, doc_id),
        ).fetchone()
        if prev is not None:
            self._sqlite.execute(
                f'DELETE FROM "{table}" WHERE rowid = ?', (prev[0],)
            )
        doc = self._db.collection(self.collection).find_by_id(doc_id)
        if doc is None:
            if prev is not None:
                self._sqlite.execute(
                    f"DELETE FROM {_IDMAP} WHERE coll = ? AND doc_id = ?",
                    (self.collection, doc_id),
                )
            return  # deleted
        cols = ", ".join(f'"{_col(i)}"' for i in range(len(self.fields)))
        placeholders = ", ".join("?" for _ in self.fields)
        values = [_extract_text(doc, f) for f in self.fields]
        cur = self._sqlite.execute(
            f'INSERT INTO "{table}"(doc_id, {cols}) VALUES (?, {placeholders})',
            (doc_id, *values),
        )
        self._sqlite.execute(
            f"INSERT INTO {_IDMAP}(coll, doc_id, rid) VALUES (?, ?, ?) "
            "ON CONFLICT(coll, doc_id) DO UPDATE SET rid = excluded.rid",
            (self.collection, doc_id, int(cur.lastrowid)),
        )

    # -- reindex / catch_up (== TS reindex/catchUp) ---------------------------
    def reindex(self) -> None:
        """Rebuild this collection's FTS index from scratch."""
        table = _fts_table(self.collection)
        self._sqlite.execute(f'DELETE FROM "{table}"')
        self._sqlite.execute(
            f"DELETE FROM {_IDMAP} WHERE coll = ?", (self.collection,)
        )
        for doc in self._db.collection(self.collection).find_many():
            self._index_doc(doc["_id"])
        self._set_high_water(_now())

    def catch_up(self) -> Dict[str, int]:
        """Incrementally index documents written by another process and reconcile deletes.

        Returns ``{"indexed": n, "removed": m}``. ``updated_at >= high_water`` catches recent
        writes; documents missing from the index entirely are also indexed, so a doc synced in
        with a past (below-high-water) timestamp doesn't stay unsearchable. Mirrors TS catchUp.
        """
        table = _fts_table(self.collection)
        hw = self._get_high_water()
        docs = self._sqlite.execute(
            f'SELECT _id, updated_at FROM "{self.collection}" WHERE updated_at >= ? '
            f"OR _id NOT IN (SELECT doc_id FROM {_IDMAP} WHERE coll = ?)",
            (hw, self.collection),
        ).fetchall()
        mx = hw
        for doc_id, updated_at in docs:
            self._index_doc(doc_id)
            if updated_at > mx:
                mx = updated_at
        # Remove index rows whose document was deleted (possibly by another process).
        orphans = self._sqlite.execute(
            f'SELECT rowid AS rid, doc_id FROM "{table}" '
            f'WHERE doc_id NOT IN (SELECT _id FROM "{self.collection}")'
        ).fetchall()
        for rid, doc_id in orphans:
            self._sqlite.execute(f'DELETE FROM "{table}" WHERE rowid = ?', (rid,))
            self._sqlite.execute(
                f"DELETE FROM {_IDMAP} WHERE coll = ? AND doc_id = ?",
                (self.collection, doc_id),
            )
        self._set_high_water(mx)
        return {"indexed": len(docs), "removed": len(orphans)}

    # -- MATCH (== TS ftsMatch: never throws on untrusted input) --------------
    def _fts_match(self, query: str, fetch: int) -> List[Dict[str, Any]]:
        table = _fts_table(self.collection)
        sql = (
            f'SELECT doc_id, rank FROM "{table}" '
            f'WHERE "{table}" MATCH ? ORDER BY rank LIMIT ?'
        )

        def run(q: str) -> List[Dict[str, Any]]:
            rows = self._sqlite.execute(sql, (q, fetch)).fetchall()
            return [{"doc_id": r[0], "rank": r[1]} for r in rows]

        try:
            return run(query)
        except Exception:
            # Untrusted input can contain FTS5 syntax (a stray `"`, a bare AND/*, column
            # filters) that throws "fts5: syntax error" — retry as quoted phrase tokens.
            tokens = [t for t in query.strip().split() if t]
            safe = " ".join('"' + t.replace('"', '""') + '"' for t in tokens)
            if not safe:
                return []
            try:
                return run(safe)
            except Exception:
                return []

    # -- search (== TS search) ------------------------------------------------
    def search(
        self,
        query: str,
        limit: int = 50,
        where: Optional[Dict[str, Any]] = None,
        candidates: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Run an FTS5 ``MATCH`` and return matching documents in rank order.

        Each result is the full document with an added ``_score`` (higher = better, derived
        from the negated BM25 rank). ``query`` uses FTS5 MATCH syntax (bare terms AND-ed,
        ``"a phrase"``, ``term*`` prefix, ``a OR b``); malformed input never raises. ``where``
        is a normal monlite filter applied after matching; with it set the package over-fetches
        ranked candidates (``candidates``, default ``max(limit*10, 200)``, capped 10_000) then
        filters and trims to ``limit``, so a selective filter doesn't drop deeper matches.
        """
        coll = self._db.collection(self.collection)
        if where:
            fetch = min(max(candidates if candidates is not None else limit * 10, 200), 10_000)
        else:
            fetch = limit
        rows = self._fts_match(query, fetch)

        allowed: Optional[set] = None
        if where:
            ids = [r["doc_id"] for r in rows]
            matching = coll.find_many(where={"AND": [where, {"_id": {"in": ids}}]})
            allowed = {d["_id"] for d in matching}

        out: List[Dict[str, Any]] = []
        for r in rows:
            if len(out) >= limit:  # check BEFORE pushing (limit=0 -> 0 results)
                break
            if allowed is not None and r["doc_id"] not in allowed:
                continue
            doc = coll.find_by_id(r["doc_id"])
            if doc is not None:
                out.append({**doc, "_score": -r["rank"]})
        return out

    # -- keep-in-sync hooks (the Python analogue of the TS afterWrite) --------
    def _install_hooks(self) -> None:
        """Wrap the collection's write methods so each write updates the index.

        The core has no plugin/afterWrite hook, so we monkey-patch the (memoized) Collection
        instance for this collection. After each write we re-index via catch_up(), which finds
        the just-written rows by their fresh updated_at — producing the same on-disk state the
        TS afterWrite hook would, with no triggers (so sqlite_master stays interop-clean).
        """
        coll = self._db.collection(self.collection)
        if getattr(coll, "_monlite_fts_hooked", False):
            return
        for name in _WRITE_METHODS:
            original = getattr(coll, name, None)
            if original is None:
                continue
            setattr(coll, name, self._wrap(original))
        setattr(coll, "_monlite_fts_hooked", True)
        # Expose search()/catch_up() on the collection too, mirroring the TS
        # `collection.search()` / `collection.catchUp()` ergonomics.
        setattr(coll, "search", self.search)
        setattr(coll, "catch_up", self.catch_up)

    def _wrap(self, original: Any) -> Any:
        index = self

        def wrapped(*args: Any, **kwargs: Any) -> Any:
            result = original(*args, **kwargs)
            # Re-index whatever changed; catch_up() is incremental off the high-water mark,
            # so this stays cheap, and it also reconciles deletes.
            index.catch_up()
            index._set_high_water(_now())  # our index is current to now
            return result

        return wrapped


def fts(db: Any, collection: str, fields: Sequence[str]) -> SearchIndex:
    """Build (or attach to) a full-text index over ``collection`` for the given ``fields``.

    Ensures the FTS5 table + bookkeeping tables (byte-identical to ``@monlite/fts``), backfills
    existing documents, and keeps the index current on every write to that collection. Returns a
    :class:`SearchIndex`; also attaches ``search``/``catch_up`` to the collection object.

        index = fts(db, "posts", fields=["title", "body"])
        index.search("quick")
    """
    return SearchIndex(db, collection, fields)


def create_search_index(db: Any, collection: str, fields: Sequence[str]) -> SearchIndex:
    """Alias of :func:`fts` (lower-level constructor for a document-collection index)."""
    return SearchIndex(db, collection, fields)


# ────────────────────────────────────────────────────────────────────────────
# Dynamic, programmatic index (mirrors the TS `createSearchIndex(db)` object)
#
# Where `fts()` indexes a DOCUMENT collection with a fixed field list, this indexes
# collections created at RUNTIME — RAG corpora, per-tenant indexes. Each collection is
# its own FTS5 table; `fields` are indexed and `filter_fields` are stored UNINDEXED so a
# `where` scopes the MATCH (keyword search within one case/tenant). Synchronous.
# ────────────────────────────────────────────────────────────────────────────
class DynamicSearchIndex:
    """Programmatic full-text index over collections created at runtime (== TS object).

    ``ensure_collection(name, fields=[...], filter_fields=[...])`` then ``upsert`` /
    ``search`` / ``delete``. ``fields`` are indexed; ``filter_fields`` are UNINDEXED columns
    so ``where`` scopes the MATCH without affecting ranking. Same FTS5 DDL as the TS, so its
    indexes interop.
    """

    def __init__(self, db: Any) -> None:
        self._db = db
        self._sqlite = db.sqlite
        self._configs: Dict[str, Dict[str, List[str]]] = {}

    def _create(self, name: str, fields: Sequence[str], filter_fields: Sequence[str]) -> Dict[str, List[str]]:
        n = _fts_ident(name)
        fcols = ", ".join(_fts_ident(f) for f in fields)
        ucols = "".join(f", {_fts_ident(f)} UNINDEXED" for f in filter_fields)
        self._sqlite.execute(
            f'CREATE VIRTUAL TABLE IF NOT EXISTS "{n}" '
            f"USING fts5(doc_id UNINDEXED, {fcols}{ucols})"
        )
        cfg = {"fields": list(fields), "filter_fields": list(filter_fields)}
        self._configs[name] = cfg
        return cfg

    def _known(self, name: str) -> Optional[Dict[str, List[str]]]:
        if name in self._configs:
            return self._configs[name]
        row = self._sqlite.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?", (name,)
        ).fetchone()
        if not row or not row[0]:
            return None
        # Recover the real schema from the fts5 table definition so a reopened index can
        # index/search correctly: doc_id is skipped; UNINDEXED columns are filter_fields,
        # the rest are searchable fields. (TS does the identical recovery.)
        m = re.search(r"fts5\s*\(([\s\S]*)\)", row[0], re.IGNORECASE)
        fields: List[str] = []
        filter_fields: List[str] = []
        if m:
            for raw in m.group(1).split(","):
                part = raw.strip()
                unindexed = re.search(r"\bUNINDEXED\b", part, re.IGNORECASE) is not None
                col_name = re.sub(r"\bUNINDEXED\b", "", part, flags=re.IGNORECASE).strip()
                col_name = re.sub(r'^"(.*)"$', r"\1", col_name)
                if not col_name or col_name == "doc_id":
                    continue
                (filter_fields if unindexed else fields).append(col_name)
        cfg = {"fields": fields, "filter_fields": filter_fields}
        self._configs[name] = cfg
        return cfg

    def ensure_collection(
        self,
        name: str,
        fields: Sequence[str],
        filter_fields: Sequence[str] = (),
    ) -> None:
        if name not in self._configs:
            self._create(name, fields, filter_fields)

    def upsert(self, name: str, points: Sequence[Dict[str, Any]]) -> None:
        """Insert/replace points: ``{"id", "fields": {...}, "filters": {...}}``."""
        if not points:
            return
        cfg = self._configs.get(name)
        if cfg is None:
            raise ValueError(f'monlite.fts: ensure_collection("{name}") before upsert')
        cols = [*cfg["fields"], *cfg["filter_fields"]]
        col_list = "".join(f", {c}" for c in cols)
        ph = "".join(", ?" for _ in cols)
        self._sqlite.execute("BEGIN")
        try:
            for p in points:
                pid = p["id"]
                self._sqlite.execute(f'DELETE FROM "{name}" WHERE doc_id = ?', (pid,))
                pf = p.get("fields") or {}
                pfi = p.get("filters") or {}
                vals = [pf.get(f, "") for f in cfg["fields"]] + [
                    pfi.get(f, "") for f in cfg["filter_fields"]
                ]
                self._sqlite.execute(
                    f'INSERT INTO "{name}"(doc_id{col_list}) VALUES (?{ph})',
                    (pid, *vals),
                )
            self._sqlite.execute("COMMIT")
        except BaseException:
            try:
                self._sqlite.execute("ROLLBACK")
            except Exception:
                pass
            raise

    def search(
        self,
        name: str,
        query: str,
        limit: int = 50,
        where: Optional[Dict[str, str]] = None,
    ) -> List[Dict[str, Any]]:
        """Return ``[{"id", "score"}]`` (score higher = better). ``where`` scopes the MATCH."""
        cfg = self._known(name)
        if cfg is None:
            return []
        pairs = [(k, v) for k, v in (where or {}).items() if v is not None]
        clause = "".join(f" AND {_fts_ident(k)} = ?" for k, _ in pairs)
        sql = (
            f'SELECT doc_id, rank FROM "{name}" '
            f'WHERE "{name}" MATCH ?{clause} ORDER BY rank LIMIT ?'
        )
        try:
            params = [query, *[v for _, v in pairs], limit]
            rows = self._sqlite.execute(sql, params).fetchall()
        except Exception:
            return []
        return [{"id": r[0], "score": -r[1]} for r in rows]

    def delete(
        self,
        name: str,
        id: Optional[str] = None,
        where: Optional[Dict[str, str]] = None,
    ) -> None:
        cfg = self._known(name)
        if cfg is None:
            return
        if id is not None:
            self._sqlite.execute(f'DELETE FROM "{name}" WHERE doc_id = ?', (id,))
            return
        pairs = [(k, v) for k, v in (where or {}).items() if v is not None]
        if not pairs:
            return
        clause = " AND ".join(f"{_fts_ident(k)} = ?" for k, _ in pairs)
        self._sqlite.execute(
            f'DELETE FROM "{name}" WHERE {clause}', [v for _, v in pairs]
        )


def create_dynamic_search_index(db: Any) -> DynamicSearchIndex:
    """A programmatic, dynamic full-text index (collections created at runtime; RAG/per-tenant)."""
    return DynamicSearchIndex(db)


__all__ = [
    "fts",
    "create_search_index",
    "SearchIndex",
    "DynamicSearchIndex",
    "create_dynamic_search_index",
]
