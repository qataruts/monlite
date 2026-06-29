---
id: python
title: Python
---

# Python

monlite has a **native Python port** — `pip install monlite` — that reads and writes the **same
`.db` file** as the TypeScript `@monlite/*` packages. It's byte-compatible across every shared
table (documents, the change feed, `_kv` / sorted sets / pub-sub, the `_jobs` queue, `_schedules`,
and the FTS5 index), so the classic AI split is first-class: **Python ingests and embeds, Node
serves** — over one file, no extra infrastructure.

Pure standard library (`sqlite3`), no dependencies. Python 3.9+.

```bash
pip install monlite
```

```python
from monlite import create_db, kv, create_queue, create_cron, fts

db = create_db("app.db", changefeed=True)
users = db.collection("users")

users.create({"name": "Ada", "age": 30, "tags": ["admin"]})
adults = users.find_many(where={"age": {"gte": 18}}, order_by={"age": "asc"})
users.update({"_id": ada_id}, {"$inc": {"age": 1}, "$push": {"tags": "vip"}})

# see what a Node process wrote (and vice-versa)
for change in db.changes():
    print(change["coll"], change["op"], change["doc_id"])
```

## What's in the package

| Module | API |
|---|---|
| **core** | documents; `find_many`/`find_first`/`count`; operators incl. `gte`/`in`/`contains`/`startsWith`/`endsWith`/`regex`/`has`/`elemMatch`/`not`/`notIn`; `aggregate(_count=…, _sum=[…])` + `group_by(...)`; nestable `with db.transaction(): …`; the **change feed** (`db.changes()`, `db.current_seq()`) |
| **kv** | `set`/`get`/`incr`/`ttl`; atomic locks (`set_nx`, `with_lock`); pub/sub (`publish`/`subscribe`/`poll`); sorted sets (`zadd`/`zincrby`/`zrank`/`zrange`/`zrange_by_score`/…) |
| **queue** | durable `_jobs`: `add`/`claim`/`complete`/`fail`/`process`, retries + backoff, delay, priority, dedupe |
| **cron** | `parse_cron`, `next_cron_run` (tz via `zoneinfo`, jitter), `schedule`/`tick` with an atomic multi-process claim |
| **fts** | FTS5 — `fts(db, "posts", fields=["title", "body"])` then `idx.search("query")` |
| **vector** | `vector(db, "docs", field="embedding", dimensions=…)` → `find_similar(...)`; native `sqlite-vec` (`[vector]` extra) or a pure-Python fallback; `hybrid_search` for RAG |

The change feed, sorted sets, and the queue are exercised by a **cross-runtime interop test
suite** that round-trips a `.db` between Node and Python.

```python
# durable queue shared with a Node worker
from monlite import create_queue
q = create_queue(db)
q.add("email", {"to": "a@b.c"}, priority=5, max_attempts=3)
q.process("email", lambda payload: send(payload))

# full-text search over the same FTS5 index Node builds
from monlite import fts
idx = fts(db, "posts", fields=["title", "body"])
idx.search("sqlite", limit=10)
```

## Vector / semantic search

`pip install "monlite[vector]"` adds the AI-agent memory layer — native `vec0` (sqlite-vec) when
the extension loads, an exact brute-force fallback over a plain JSON table otherwise:

```python
from monlite import vector

vec = vector(db, "docs", field="embedding", dimensions=1536, distance="cosine")
vec.find_similar(query_embedding, top_k=5, where={"tenant": "t1"})  # docs ranked by distance
```

It indexes a collection's embedding field, adds `collection.find_similar(...)`, keeps the index
current on writes, and backfills existing docs. `hybrid_search(db, coll, text, query_vector, …)`
combines FTS candidates with a vector re-rank for RAG. The `<coll>_vec` + `_monlite_vec_state`
tables and the JSON embedding format match `@monlite/vector`, so same-mode indexes interoperate
with Node (both native, or both fallback).

## Lower-level: just SQLite

A monlite database is plain SQLite with [documented conventions](/reference/file-format), so any
language with an SQLite driver can read it without the package — handy for quick scripts or other
runtimes:

```python
import sqlite3, json
db = sqlite3.connect("app.db")
for (_id, data) in db.execute("SELECT _id, data FROM users"):
    print(json.loads(data)["name"])
# FTS5 ships with Python's sqlite3:
db.execute("SELECT doc_id FROM posts_fts WHERE posts_fts MATCH ?", ("hello",)).fetchall()
```

See the [file format spec](/reference/file-format) for the table layouts both sides share.
