"""monlite core — documents over SQLite, byte-compatible with @monlite/core.

A document collection is a table `(_id TEXT PRIMARY KEY, data TEXT, created_at INTEGER,
updated_at INTEGER)`, where `data` is the JSON body minus the system fields. This is the
exact layout the TypeScript core uses, so a .db written by Node round-trips here and back.

Opt into the change feed with ``create_db(path, changefeed=True)`` — writes are then appended
to ``_monlite_changes`` in the same on-disk format the TS side reads, so Node ``watch()`` sees
Python's writes and ``db.changes()`` here sees Node's. The version string and ``upsert``/``delete``
ops match ``@monlite/core`` exactly.
"""
from __future__ import annotations

import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional

_SYS = ("_id", "created_at", "updated_at")
_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")
# Scalar operator keys (used to tell `elemMatch` scalar-form from object-form).
_OP_KEYS = {
    "equals", "not", "gt", "gte", "lt", "lte", "in", "notIn", "not_in",
    "contains", "startsWith", "startswith", "endsWith", "endswith", "regex",
    "has", "exists", "mode",
}

# Version string layout — must match src/sync/version.ts.
_TS_WIDTH = 15
_SEQ_WIDTH = 12


def _now() -> int:
    return int(time.time() * 1000)


def _gen_id() -> str:
    # objectId-like: 8 hex seconds + 16 hex random (opaque, roughly sortable)
    return format(int(time.time()), "08x") + secrets.token_hex(8)


def make_version(ts: int, node_id: str, seq: Optional[int] = None) -> str:
    """`<zero-padded-ms>:<nodeId>[:<zero-padded-seq>]` — string-sortable, like the TS port."""
    base = str(ts).rjust(_TS_WIDTH, "0") + ":" + node_id
    return base if seq is None else base + ":" + str(seq).rjust(_SEQ_WIDTH, "0")


def _dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _bindable(v: Any) -> Any:
    if isinstance(v, bool):
        return 1 if v else 0  # SQLite json_extract returns JSON true/false as 1/0
    if isinstance(v, (list, dict)):
        return _dumps(v)
    return v


def _regexp(pattern: Optional[str], value: Optional[str]) -> int:
    if pattern is None or value is None:
        return 0
    try:
        return 1 if re.search(pattern, str(value)) else 0
    except re.error:
        return 0


def _field_expr(field: str) -> str:
    if field in _SYS:
        return field
    if not _FIELD_RE.match(field):
        raise ValueError(f"monlite: invalid field path {field!r}")
    return f"json_extract(data, '$.{field}')"


# ── value <-> path helpers (dot notation) ────────────────────────────────────
def _get_path(obj: Dict[str, Any], path: str) -> Any:
    cur: Any = obj
    for seg in path.split("."):
        if not isinstance(cur, dict) or seg not in cur:
            return None
        cur = cur[seg]
    return cur


def _set_path(obj: Dict[str, Any], path: str, value: Any) -> None:
    segs = path.split(".")
    cur = obj
    for seg in segs[:-1]:
        nxt = cur.get(seg)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[seg] = nxt
        cur = nxt
    cur[segs[-1]] = value


def _unset_path(obj: Dict[str, Any], path: str) -> None:
    segs = path.split(".")
    cur = obj
    for seg in segs[:-1]:
        cur = cur.get(seg)
        if not isinstance(cur, dict):
            return
    cur.pop(segs[-1], None)


# ── where translation (mirrors @monlite/core operators) ──────────────────────
def _cond_on_expr(expr: str, cond: Any, field: Optional[str] = None):
    """Translate an operator object (or a scalar equality) applied to `expr`.

    `field` is the dotted path (needed for the array operators `has`/`elemMatch`,
    which use `json_each(data, '$.field')`).
    """
    if not isinstance(cond, dict):
        if cond is None:
            return f"{expr} IS NULL", []
        return f"{expr} = ?", [_bindable(cond)]

    ci = cond.get("mode") == "insensitive"
    clauses: List[str] = []
    params: List[Any] = []
    for op, v in cond.items():
        if op == "mode":
            continue
        if op == "equals":
            if v is None:
                clauses.append(f"{expr} IS NULL")
            else:
                clauses.append(f"{expr} = ?")
                params.append(_bindable(v))
        elif op == "not":
            if v is None:
                clauses.append(f"{expr} IS NOT NULL")
            else:
                clauses.append(f"({expr} IS NULL OR {expr} != ?)")
                params.append(_bindable(v))
        elif op in ("gt", "gte", "lt", "lte"):
            sql_op = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            clauses.append(f"{expr} {sql_op} ?")
            params.append(_bindable(v))
        elif op == "in":
            if not v:
                clauses.append("0")
            else:
                clauses.append(f"{expr} IN ({','.join('?' * len(v))})")
                params.extend(_bindable(x) for x in v)
        elif op in ("notIn", "not_in"):
            if not v:
                clauses.append("1")
            else:
                clauses.append(f"({expr} IS NULL OR {expr} NOT IN ({','.join('?' * len(v))}))")
                params.extend(_bindable(x) for x in v)
        elif op == "contains":
            clauses.append(
                f"instr(lower({expr}), lower(?)) > 0" if ci else f"instr({expr}, ?) > 0"
            )
            params.append(_bindable(v))
        elif op in ("startsWith", "startswith"):
            clauses.append(
                f"instr(lower({expr}), lower(?)) = 1" if ci else f"instr({expr}, ?) = 1"
            )
            params.append(_bindable(v))
        elif op in ("endsWith", "endswith"):
            e = f"lower({expr})" if ci else expr
            needle = "lower(?)" if ci else "?"
            # suffix match: the needle sits at the end of the string
            clauses.append(
                f"({e} LIKE '%' || {needle}) AND "
                f"substr({e}, length({e}) - length({needle}) + 1) = {needle}"
            )
            params.extend([_bindable(v), _bindable(v), _bindable(v)])
        elif op == "regex":
            pat = f"(?i){v}" if ci else v
            clauses.append(f"{expr} REGEXP ?")
            params.append(pat)
        elif op == "has":
            if field is None:
                raise ValueError("monlite: `has` is only valid on a top-level field")
            clauses.append(
                f"EXISTS (SELECT 1 FROM json_each(data, '$.{field}') WHERE value = ?)"
            )
            params.append(_bindable(v))
        elif op == "elemMatch":
            if field is None:
                raise ValueError("monlite: `elemMatch` is only valid on a top-level field")
            sub_sql, sub_params = _elem_match_clause(v)
            clauses.append(
                f"EXISTS (SELECT 1 FROM json_each(data, '$.{field}') WHERE {sub_sql})"
            )
            params.extend(sub_params)
        elif op == "exists":
            clauses.append(f"{expr} IS NOT NULL" if v else f"{expr} IS NULL")
        else:
            raise ValueError(f"monlite: unsupported where operator {op!r}")
    if not clauses:
        return "", []
    return ("(" + " AND ".join(clauses) + ")" if len(clauses) > 1 else clauses[0]), params


def _elem_match_clause(sub: Any):
    """Build the predicate for one `json_each` element (the `value` column).

    Scalar form (`{"gte": 5}`) constrains the element directly; object form
    (`{"qty": {"gt": 1}}`) constrains JSON sub-fields of each element.
    """
    if isinstance(sub, dict) and sub and all(k in _OP_KEYS for k in sub):
        return _cond_on_expr("value", sub)
    clauses: List[str] = []
    params: List[Any] = []
    for k, cond in (sub or {}).items():
        s, p = _cond_on_expr(f"json_extract(value, '$.{k}')", cond)
        if s:
            clauses.append(s)
            params.extend(p)
    if not clauses:
        return "1", []
    return ("(" + " AND ".join(clauses) + ")" if len(clauses) > 1 else clauses[0]), params


def _translate_field(field: str, cond: Any):
    return _cond_on_expr(_field_expr(field), cond, field=field)


def _translate_obj(where: Dict[str, Any]):
    parts: List[str] = []
    params: List[Any] = []
    for key, value in where.items():
        if value is None and key not in ("AND", "OR", "NOT"):
            s, p = _translate_field(key, None)
            if s:
                parts.append(s)
                params.extend(p)
            continue
        if key in ("AND", "OR"):
            subs = value if isinstance(value, list) else [value]
            sub_clauses = []
            for w in subs:
                s, p = _translate_obj(w)
                if s and s != "1":
                    sub_clauses.append(s)
                    params.extend(p)
            if sub_clauses:
                joiner = " AND " if key == "AND" else " OR "
                parts.append("(" + joiner.join(sub_clauses) + ")")
        elif key == "NOT":
            subs = value if isinstance(value, list) else [value]
            sub_clauses = []
            for w in subs:
                s, p = _translate_obj(w)
                if s and s != "1":
                    sub_clauses.append(s)
                    params.extend(p)
            if sub_clauses:
                parts.append("NOT (" + " AND ".join(sub_clauses) + ")")
        else:
            s, p = _translate_field(key, value)
            if s:
                parts.append(s)
                params.extend(p)
    return (" AND ".join(parts) if parts else "1", params)


def _build_where(where: Optional[Dict[str, Any]]):
    if not where:
        return "1", []
    return _translate_obj(where)


def _order_clause(order_by) -> str:
    if not order_by:
        return ""
    specs = order_by if isinstance(order_by, list) else [order_by]
    terms = []
    for spec in specs:
        for field, direction in spec.items():
            d = "DESC" if str(direction).lower() == "desc" else "ASC"
            terms.append(f"{_field_expr(field)} {d}")
    return " ORDER BY " + ", ".join(terms) if terms else ""


def _apply_update(doc: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    result = {k: v for k, v in doc.items() if k not in _SYS}
    has_ops = any(isinstance(k, str) and k.startswith("$") for k in data)
    if not has_ops:
        result.update({k: v for k, v in data.items() if k not in _SYS})
        return result
    for op, fields in data.items():
        if op == "$set":
            for k, v in fields.items():
                _set_path(result, k, v)
        elif op == "$unset":
            keys = fields.keys() if isinstance(fields, dict) else fields
            for k in keys:
                _unset_path(result, k)
        elif op == "$inc":
            for k, v in fields.items():
                _set_path(result, k, (_get_path(result, k) or 0) + v)
        elif op == "$push":
            for k, v in fields.items():
                arr = _get_path(result, k) or []
                arr.append(v)
                _set_path(result, k, arr)
        elif op == "$pull":
            for k, v in fields.items():
                arr = _get_path(result, k) or []
                _set_path(result, k, [x for x in arr if x != v])
        elif op == "$addToSet":
            for k, v in fields.items():
                arr = _get_path(result, k) or []
                if v not in arr:
                    arr.append(v)
                _set_path(result, k, arr)
        else:
            raise ValueError(f"monlite: unsupported update operator {op!r}")
    return result


def _project(doc: Dict[str, Any], select: Dict[str, bool]) -> Dict[str, Any]:
    keep = {k for k, on in select.items() if on}
    out = {k: v for k, v in doc.items() if k in keep}
    out["_id"] = doc["_id"]
    return out


# ── aggregation ──────────────────────────────────────────────────────────────
def _aggregate_rows(docs: List[Dict[str, Any]], spec: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for acc, fields in spec.items():
        if acc == "_count":
            out["_count"] = len(docs)
            continue
        agg = {}
        for field in (fields if isinstance(fields, (list, tuple)) else fields.keys()):
            vals = [v for v in (_get_path(d, field) for d in docs) if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if acc == "_sum":
                agg[field] = sum(vals)
            elif acc == "_avg":
                agg[field] = (sum(vals) / len(vals)) if vals else None
            elif acc == "_min":
                agg[field] = min(vals) if vals else None
            elif acc == "_max":
                agg[field] = max(vals) if vals else None
            else:
                raise ValueError(f"monlite: unsupported aggregate {acc!r}")
        out[acc] = agg
    return out


class _ChangeFeed:
    """Append-only recorder for `_monlite_changes`, matching the TS sync store."""

    def __init__(self, conn: sqlite3.Connection, node_id: Optional[str] = None):
        self._conn = conn
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS _monlite_changes (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              coll TEXT NOT NULL, doc_id TEXT NOT NULL, op TEXT NOT NULL,
              version TEXT NOT NULL, ts INTEGER NOT NULL,
              source TEXT NOT NULL DEFAULT 'local', pushed INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS _idx_changes_doc ON _monlite_changes(coll, doc_id, seq);
            CREATE INDEX IF NOT EXISTS _idx_changes_push ON _monlite_changes(source, pushed, seq);
            CREATE TABLE IF NOT EXISTS _monlite_meta (key TEXT PRIMARY KEY, value TEXT);
            """
        )
        self.node_id = self._resolve_node_id(node_id)
        row = conn.execute(
            "SELECT version FROM _monlite_changes WHERE source = 'local' ORDER BY seq DESC LIMIT 1"
        ).fetchone()
        # Continue the per-node tiebreaker monotonically across opens.
        self._seq = 0
        if row and row[0]:
            parts = str(row[0]).split(":")
            if len(parts) == 3:
                try:
                    self._seq = int(parts[2]) + 1
                except ValueError:
                    self._seq = 0

    def _resolve_node_id(self, explicit: Optional[str]) -> str:
        if explicit:
            self._conn.execute(
                "INSERT OR REPLACE INTO _monlite_meta (key, value) VALUES ('nodeId', ?)",
                (explicit,),
            )
            return explicit
        row = self._conn.execute(
            "SELECT value FROM _monlite_meta WHERE key = 'nodeId'"
        ).fetchone()
        if row and row[0]:
            return row[0]
        generated = _gen_id()
        self._conn.execute(
            "INSERT INTO _monlite_meta (key, value) VALUES ('nodeId', ?)", (generated,)
        )
        return generated

    def record(self, collection: str, doc_id: str, op: str, ts: int) -> str:
        version = make_version(ts, self.node_id, self._seq)
        self._seq += 1
        self._conn.execute(
            "INSERT INTO _monlite_changes (coll, doc_id, op, version, ts, source, pushed) "
            "VALUES (?, ?, ?, ?, ?, 'local', 0)",
            (collection, doc_id, op, version, ts),
        )
        return version


class Collection:
    def __init__(self, db: "Database", name: str):
        self._db = db
        self._conn = db.sqlite
        self.name = name
        self._conn.execute(
            f'CREATE TABLE IF NOT EXISTS "{name}" '
            "(_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
        )
        if db._tx_depth == 0:
            self._conn.commit()

    def _row_to_doc(self, row) -> Dict[str, Any]:
        _id, data, created_at, updated_at = row
        doc = json.loads(data)
        doc["_id"] = _id
        doc["created_at"] = created_at
        doc["updated_at"] = updated_at
        return doc

    def create(self, data: Dict[str, Any]) -> Dict[str, Any]:
        doc = dict(data)
        _id = doc.pop("_id", None) or _gen_id()
        body = {k: v for k, v in doc.items() if k not in _SYS}
        now = _now()
        with self._db._write():
            self._conn.execute(
                f'INSERT INTO "{self.name}" (_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)',
                (_id, _dumps(body), now, now),
            )
            self._db._record(self.name, _id, "upsert", now)
        return {**body, "_id": _id, "created_at": now, "updated_at": now}

    def create_many(self, data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        # transaction() tracks depth, so each create()'s own _write() becomes a no-op
        # and the whole batch commits once (atomically).
        with self._db.transaction():
            return [self.create(d) for d in data]

    def find_by_id(self, _id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            f'SELECT _id, data, created_at, updated_at FROM "{self.name}" WHERE _id = ?', (_id,)
        ).fetchone()
        return self._row_to_doc(row) if row else None

    def find_many(self, where=None, order_by=None, take=None, skip=None, select=None) -> List[Dict[str, Any]]:
        sql, params = _build_where(where)
        q = f'SELECT _id, data, created_at, updated_at FROM "{self.name}" WHERE {sql}'
        q += _order_clause(order_by)
        if take is not None:
            q += f" LIMIT {int(take)}"
        if skip is not None:
            q += f"{'' if take is not None else ' LIMIT -1'} OFFSET {int(skip)}"
        rows = self._conn.execute(q, params).fetchall()
        docs = [self._row_to_doc(r) for r in rows]
        return [_project(d, select) for d in docs] if select else docs

    def find_first(self, where=None, order_by=None, select=None) -> Optional[Dict[str, Any]]:
        rows = self.find_many(where=where, order_by=order_by, take=1, select=select)
        return rows[0] if rows else None

    def count(self, where=None) -> int:
        sql, params = _build_where(where)
        return self._conn.execute(f'SELECT count(*) FROM "{self.name}" WHERE {sql}', params).fetchone()[0]

    def exists(self, where=None) -> bool:
        return self.count(where) > 0

    def aggregate(self, where=None, **spec) -> Dict[str, Any]:
        """`_count`, and `_sum`/`_avg`/`_min`/`_max` over a list of numeric fields.

        e.g. ``c.aggregate(_count=True, _sum=["amount"], _avg=["amount"])``.
        """
        docs = self.find_many(where=where)
        norm = {k: (list(v) if isinstance(v, (list, tuple)) else v) for k, v in spec.items()}
        return _aggregate_rows(docs, norm)

    def group_by(self, by, where=None, **spec) -> List[Dict[str, Any]]:
        """Group rows by one or more fields; each group carries the aggregates in `spec`."""
        fields = by if isinstance(by, (list, tuple)) else [by]
        docs = self.find_many(where=where)
        groups: Dict[tuple, List[Dict[str, Any]]] = {}
        for d in docs:
            key = tuple(_get_path(d, f) for f in fields)
            groups.setdefault(key, []).append(d)
        out: List[Dict[str, Any]] = []
        for key, rows in groups.items():
            entry = {f: key[i] for i, f in enumerate(fields)}
            entry.update(_aggregate_rows(rows, spec))
            out.append(entry)
        return out

    def update(self, where: Dict[str, Any], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        doc = self.find_first(where=where)
        if not doc:
            return None
        updated = _apply_update(doc, data)
        now = _now()
        with self._db._write():
            self._conn.execute(
                f'UPDATE "{self.name}" SET data = ?, updated_at = ? WHERE _id = ?',
                (_dumps(updated), now, doc["_id"]),
            )
            self._db._record(self.name, doc["_id"], "upsert", now)
        return {**updated, "_id": doc["_id"], "created_at": doc["created_at"], "updated_at": now}

    def update_many(self, where: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, int]:
        docs = self.find_many(where=where)
        with self._db._write():
            for d in docs:
                updated = _apply_update(d, data)
                now = _now()
                self._conn.execute(
                    f'UPDATE "{self.name}" SET data = ?, updated_at = ? WHERE _id = ?',
                    (_dumps(updated), now, d["_id"]),
                )
                self._db._record(self.name, d["_id"], "upsert", now)
        return {"count": len(docs)}

    def upsert(self, where: Dict[str, Any], create: Dict[str, Any], update: Dict[str, Any]) -> Dict[str, Any]:
        existing = self.find_first(where=where)
        if existing:
            return self.update({"_id": existing["_id"]}, update)
        return self.create(create)

    def delete(self, where: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        doc = self.find_first(where=where)
        if not doc:
            return None
        now = _now()
        with self._db._write():
            self._conn.execute(f'DELETE FROM "{self.name}" WHERE _id = ?', (doc["_id"],))
            self._db._record(self.name, doc["_id"], "delete", now)
        return doc

    def delete_many(self, where: Dict[str, Any]) -> Dict[str, int]:
        docs = self.find_many(where=where)
        with self._db._write():
            for d in docs:
                self._conn.execute(f'DELETE FROM "{self.name}" WHERE _id = ?', (d["_id"],))
                self._db._record(self.name, d["_id"], "delete", _now())
        return {"count": len(docs)}


class Database:
    def __init__(self, path: str = ":memory:", changefeed: bool = False, node_id: Optional[str] = None):
        # Autocommit mode: we manage BEGIN/COMMIT/SAVEPOINT ourselves so a write and
        # its change-feed row commit atomically, and `transaction()` can batch them.
        self.sqlite = sqlite3.connect(path, isolation_level=None)
        self.sqlite.create_function("regexp", 2, _regexp, deterministic=True)
        self.sqlite.execute("PRAGMA journal_mode = WAL")
        self.sqlite.execute("PRAGMA foreign_keys = ON")
        self.sqlite.execute("PRAGMA busy_timeout = 5000")
        self._collections: Dict[str, Collection] = {}
        self._tx_depth = 0
        # Enable the feed if asked, or if the file already has one (don't break it).
        has_feed = self.sqlite.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_monlite_changes'"
        ).fetchone()
        self._feed = _ChangeFeed(self.sqlite, node_id) if (changefeed or has_feed) else None

    # -- transactions ---------------------------------------------------------
    @contextmanager
    def transaction(self) -> Iterator["Database"]:
        """Group writes into one atomic transaction (nestable via SAVEPOINTs)."""
        sp = f"monlite_sp_{self._tx_depth}"
        self.sqlite.execute("BEGIN" if self._tx_depth == 0 else f"SAVEPOINT {sp}")
        self._tx_depth += 1
        try:
            yield self
            self._tx_depth -= 1
            self.sqlite.execute("COMMIT" if self._tx_depth == 0 else f"RELEASE {sp}")
        except BaseException:
            self._tx_depth -= 1
            if self._tx_depth == 0:
                self.sqlite.execute("ROLLBACK")
            else:
                self.sqlite.execute(f"ROLLBACK TO {sp}")
                self.sqlite.execute(f"RELEASE {sp}")
            raise

    @contextmanager
    def _write(self) -> Iterator[None]:
        """Make one logical write (doc row + change row) atomic when not already in a txn."""
        if self._tx_depth > 0:
            yield
            return
        self.sqlite.execute("BEGIN")
        try:
            yield
            self.sqlite.execute("COMMIT")
        except BaseException:
            self.sqlite.execute("ROLLBACK")
            raise

    def _record(self, collection: str, doc_id: str, op: str, ts: int) -> None:
        if self._feed is not None:
            self._feed.record(collection, doc_id, op, ts)

    # -- change feed (read) ---------------------------------------------------
    def current_seq(self) -> int:
        row = self.sqlite.execute("SELECT MAX(seq) FROM _monlite_changes").fetchone()
        return (row[0] or 0) if row else 0

    def changes(self, coll: Optional[str] = None, since: int = 0, limit: int = 1000) -> List[Dict[str, Any]]:
        """Read the ordered change feed with `seq > since` (across all writers, incl. Node)."""
        q = "SELECT seq, coll, doc_id, op, version, ts, source FROM _monlite_changes WHERE seq > ?"
        params: List[Any] = [since]
        if coll is not None:
            q += " AND coll = ?"
            params.append(coll)
        q += " ORDER BY seq ASC LIMIT ?"
        params.append(int(limit))
        cols = ("seq", "coll", "doc_id", "op", "version", "ts", "source")
        return [dict(zip(cols, r)) for r in self.sqlite.execute(q, params).fetchall()]

    @property
    def changefeed_enabled(self) -> bool:
        return self._feed is not None

    def collection(self, name: str) -> Collection:
        if name not in self._collections:
            self._collections[name] = Collection(self, name)
        return self._collections[name]

    def close(self) -> None:
        self.sqlite.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def create_db(path: str = ":memory:", changefeed: bool = False, node_id: Optional[str] = None) -> Database:
    """Open (or create) a monlite database at `path` (or ":memory:").

    Pass ``changefeed=True`` to append writes to ``_monlite_changes`` (so Node ``watch()``
    sees them and ``db.changes()`` works). A file that already has a feed keeps recording.
    """
    return Database(path, changefeed=changefeed, node_id=node_id)
