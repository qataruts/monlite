"""monlite — the local-first database for Python.

Documents, cache (and queue/cron/fts/vector as they land) over one SQLite file,
**byte-compatible with the @monlite/* TypeScript packages** — so a .db written by
Node round-trips here and back.

    from monlite import create_db, kv

    db = create_db("app.db")
    users = db.collection("users")
    users.create({"name": "Ali", "age": 30})
    adults = users.find_many(where={"age": {"gte": 18}}, order_by={"age": "asc"})

    cache = kv(db)
    cache.set("session:42", {"user": "ali"}, ttl=60_000)
"""
from .core import Collection, Database, create_db
from .kv import KV, kv

__all__ = ["create_db", "Database", "Collection", "kv", "KV"]
__version__ = "0.1.0"
