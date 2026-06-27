"""monlite core — documents over SQLite, byte-compatible with @monlite/core.

A document collection is a table `(_id TEXT PRIMARY KEY, data TEXT, created_at INTEGER,
updated_at INTEGER)`, where `data` is the JSON body minus the system fields. This is the
exact layout the TypeScript core uses, so a .db written by Node round-trips here and back.
"""
from __future__ import annotations

import json
import re
import secrets
import sqlite3
import time
from typing import Any, Dict, List, Optional

_SYS = ("_id", "created_at", "updated_at")
_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


def _now() -> int:
    return int(time.time() * 1000)


def _gen_id() -> str:
    # objectId-like: 8 hex seconds + 16 hex random (opaque, roughly sortable)
    return format(int(time.time()), "08x") + secrets.token_hex(8)


def _dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _bindable(v: Any) -> Any:
    if isinstance(v, bool):
        return 1 if v else 0  # SQLite json_extract returns JSON true/false as 1/0
    if isinstance(v, (list, dict)):
        return _dumps(v)
    return v


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
def _translate_field(field: str, cond: Any):
    expr = _field_expr(field)
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
        elif op in ("not_in", "notIn"):
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
        elif op in ("startswith", "startsWith"):
            clauses.append(
                f"instr(lower({expr}), lower(?)) = 1" if ci else f"instr({expr}, ?) = 1"
            )
            params.append(_bindable(v))
        elif op == "has":
            clauses.append(f"EXISTS (SELECT 1 FROM json_each(data, '$.{field}') WHERE value = ?)")
            params.append(_bindable(v))
        elif op == "exists":
            clauses.append(f"{expr} IS NOT NULL" if v else f"{expr} IS NULL")
        else:
            raise ValueError(f"monlite: unsupported where operator {op!r}")
    if not clauses:
        return "", []
    return ("(" + " AND ".join(clauses) + ")" if len(clauses) > 1 else clauses[0]), params


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


class Collection:
    def __init__(self, db: "Database", name: str):
        self._conn = db.sqlite
        self.name = name
        self._conn.execute(
            f'CREATE TABLE IF NOT EXISTS "{name}" '
            "(_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
        )

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
        self._conn.execute(
            f'INSERT INTO "{self.name}" (_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)',
            (_id, _dumps(body), now, now),
        )
        self._conn.commit()
        return {**body, "_id": _id, "created_at": now, "updated_at": now}

    def create_many(self, data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        out = [self.create(d) for d in data]
        return out

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

    def update(self, where: Dict[str, Any], data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        doc = self.find_first(where=where)
        if not doc:
            return None
        updated = _apply_update(doc, data)
        now = _now()
        self._conn.execute(
            f'UPDATE "{self.name}" SET data = ?, updated_at = ? WHERE _id = ?',
            (_dumps(updated), now, doc["_id"]),
        )
        self._conn.commit()
        return {**updated, "_id": doc["_id"], "created_at": doc["created_at"], "updated_at": now}

    def update_many(self, where: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, int]:
        docs = self.find_many(where=where)
        for d in docs:
            updated = _apply_update(d, data)
            self._conn.execute(
                f'UPDATE "{self.name}" SET data = ?, updated_at = ? WHERE _id = ?',
                (_dumps(updated), _now(), d["_id"]),
            )
        self._conn.commit()
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
        self._conn.execute(f'DELETE FROM "{self.name}" WHERE _id = ?', (doc["_id"],))
        self._conn.commit()
        return doc

    def delete_many(self, where: Dict[str, Any]) -> Dict[str, int]:
        sql, params = _build_where(where)
        cur = self._conn.execute(f'DELETE FROM "{self.name}" WHERE {sql}', params)
        self._conn.commit()
        return {"count": cur.rowcount}


class Database:
    def __init__(self, path: str = ":memory:"):
        self.sqlite = sqlite3.connect(path)
        self.sqlite.execute("PRAGMA journal_mode = WAL")
        self.sqlite.execute("PRAGMA foreign_keys = ON")
        self._collections: Dict[str, Collection] = {}

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


def create_db(path: str = ":memory:") -> Database:
    """Open (or create) a monlite database at `path` (or ":memory:")."""
    return Database(path)
