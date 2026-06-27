# monlite (Python)

**The local-first database for Python** — documents and a cache (with queue, cron,
full-text, and vectors landing) over **one SQLite file**, with a pure-standard-library
core.

`monlite` is the Python port of [monlite](https://monlite.dev). It reads and writes the
**same `.db` file** as the TypeScript `@monlite/*` packages, so Python and Node can share
one database — *Python ingests/embeds, Node serves*, or any split you like.

```bash
pip install monlite
```

No dependencies for the core — it uses Python's built-in `sqlite3` (with FTS5).

## Quick start

```python
from monlite import create_db, kv

db = create_db("app.db")
users = db.collection("users")

users.create({"name": "Ali", "age": 30, "tags": ["admin"]})
users.create_many([{"name": "Sara", "age": 25}, {"name": "Omar", "age": 40}])

adults = users.find_many(where={"age": {"gte": 18}}, order_by={"age": "asc"})
ali = users.find_first(where={"name": "Ali"})
users.update({"_id": ali["_id"]}, {"$inc": {"age": 1}, "$push": {"tags": "vip"}})
users.count(where={"role": "admin"})

# a synchronous cache + locks (Redis's local role)
cache = kv(db)
cache.set("session:42", {"user": "ali"}, ttl=60_000)
cache.get("session:42")            # {"user": "ali"}
cache.set_nx("lock:job", 1, ttl=5_000)   # atomic set-if-absent → True/False
```

## Query operators

Mongo/Prisma-style, mirroring the TypeScript API:

```python
where={"age": {"gte": 18, "lt": 65}}
where={"role": {"in": ["admin", "editor"]}}
where={"name": {"contains": "ali", "mode": "insensitive"}}
where={"tags": {"has": "admin"}}
where={"OR": [{"role": "admin"}, {"age": {"gte": 40}}]}
```

Update operators: `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`.

## Cross-language interop

Because a monlite database is **plain SQLite + documented conventions**, the same file
works from both languages:

```python
# Python reads a collection a Node process wrote — and queries it
db = create_db("shared.db")
for doc in db.collection("docs").find_many(where={"tenantId": "t1"}):
    print(doc["title"])
```

The two sides are **independent** — each is a complete database library on its own. The
shared-file interop is a bonus you opt into.

## Optional extras

The core (documents + kv + queue + cron + fts) is pure-stdlib. Native bits are extras,
mirroring the TypeScript packages:

```bash
pip install "monlite[vector]"    # semantic search via sqlite-vec
pip install "monlite[postgres]"  # sync to PostgreSQL
pip install "monlite[mongo]"     # sync to MongoDB
```

## Status

Early release: **documents + kv** are implemented and covered by tests (including an
interop suite that round-trips a `.db` between Node and Python). Queue, cron, FTS, the
`[vector]` extra, and sync adapters are on the way — the
[file format](https://monlite.dev/reference/file-format) is the contract they all share.

MIT.
