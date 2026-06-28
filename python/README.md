# monlite (Python)

The local-first database for Python — documents and a cache over **one SQLite file**, with a
pure-standard-library core. No dependencies required.

`monlite` is the Python port of [monlite](https://qataruts.github.io/monlite). It reads and writes the **same
`.db` file** as the TypeScript `@monlite/*` packages, so Python and Node can share one database.
Python ingests or embeds; Node serves — or any split you like.

```bash
pip install monlite
```

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
count = users.count(where={"role": "admin"})

# Synchronous cache + atomic locks (Redis's local role)
cache = kv(db)
cache.set("session:42", {"user": "ali"}, ttl=60_000)
cache.get("session:42")                   # {"user": "ali"}
cache.set_nx("lock:job:42", 1, ttl=5_000) # atomic set-if-absent → True / False
```

## Query operators

Mongo/Prisma-style, mirroring the TypeScript API (snake_case method names):

```python
where={"age": {"gte": 18, "lt": 65}}
where={"role": {"in": ["admin", "editor"]}}
where={"name": {"contains": "ali", "mode": "insensitive"}}
where={"tags": {"has": "admin"}}
where={"OR": [{"role": "admin"}, {"age": {"gte": 40}}]}
```

Update operators: `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`.

## Cross-language interop

Because a monlite database is plain SQLite with documented conventions, the same file is
readable from both languages without any translation:

```python
# Python reads a collection a Node process wrote
db = create_db("shared.db")
for doc in db.collection("docs").find_many(where={"tenantId": "t1"}):
    print(doc["title"])
```

The two runtimes are fully independent — each is a complete library. The shared-file interop
is a bonus you opt into. See the [file format spec](https://qataruts.github.io/monlite/reference/file-format)
for the conventions both sides follow.

## Optional extras

The core (documents + kv) uses only Python's built-in `sqlite3`. Native extras mirror the
TypeScript packages and require additional installation:

```bash
pip install "monlite[vector]"    # semantic search via sqlite-vec
pip install "monlite[postgres]"  # sync to PostgreSQL
pip install "monlite[mongo]"     # sync to MongoDB
```

## Status

**Documents and kv are implemented** and covered by tests — including an interop suite that
round-trips a `.db` file between Node and Python. Queue, cron, FTS, the `[vector]` extra, and
sync adapters are in progress. The [file format](https://qataruts.github.io/monlite/reference/file-format) is
the contract they all share.

MIT
