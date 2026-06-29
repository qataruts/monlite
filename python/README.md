# monlite (Python)

The local-first database for Python — documents, cache, durable queue, cron, and full-text
search over **one SQLite file**, with a pure-standard-library core. No dependencies required.

`monlite` is the Python port of [monlite](https://qataruts.github.io/monlite). It reads and writes the **same
`.db` file** as the TypeScript `@monlite/*` packages — same documents, change feed, `_kv`/sorted-set
tables, `_jobs` queue, `_schedules`, and FTS5 index — so **Python ingests or embeds while Node
serves** (or any split you like). Every table layout is byte-compatible and covered by an interop
suite that round-trips a file between the two runtimes.

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

cache = kv(db)
cache.set("session:42", {"user": "ali"}, ttl=60_000)
```

## Query operators

Mongo/Prisma-style, mirroring the TypeScript API (snake_case method names):

```python
where={"age": {"gte": 18, "lt": 65}}
where={"role": {"in": ["admin", "editor"]}, "name": {"not": "root"}}
where={"name": {"contains": "ali", "mode": "insensitive"}}
where={"sku": {"startsWith": "AB", "endsWith": "-1"}}
where={"email": {"regex": r"@example\.com$"}}
where={"tags": {"has": "admin"}}                       # array contains
where={"items": {"elemMatch": {"qty": {"gte": 5}}}}     # any array element matches
where={"OR": [{"role": "admin"}, {"age": {"gte": 40}}]}
```

Update operators: `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`. Plus
`aggregate(_count=True, _sum=["amt"], _avg=["amt"], _min=[...], _max=[...])` and
`group_by("category", _count=True, _sum=["amt"])`.

### Transactions

```python
with db.transaction():           # nestable via SAVEPOINTs; rolls back on exception
    orders.create({...})
    inventory.update({"_id": sku}, {"$inc": {"stock": -1}})
```

## Change feed — see what Node wrote (and vice-versa)

Opt in with `changefeed=True`; writes append to `_monlite_changes` in the exact format the TS side
reads (`upsert`/`delete` ops, the `<padded-ms>:<nodeId>:<padded-seq>` version string):

```python
db = create_db("shared.db", changefeed=True)
last = 0
while True:
    for ch in db.changes(since=last):     # ordered; includes Node's writes
        handle(ch["coll"], ch["doc_id"], ch["op"])
        last = ch["seq"]
    time.sleep(0.2)
```

## kv — cache, locks, pub/sub, sorted sets (Redis's local role)

```python
c = kv(db)
c.set("k", {"v": 1}, ttl=60_000); c.incr("hits")
c.set_nx("lock:job", 1, ttl=5_000)          # atomic set-if-absent
with c.with_lock("report", ttl_ms=10_000):  # ergonomic distributed lock
    build_report()

c.subscribe("jobs", lambda m: print("got", m))
c.publish("jobs", {"id": 7})                 # same-process now; c.poll() drains other writers

c.zadd("board", 100, "ada"); c.zincrby("board", 5, "bo")
c.zrange("board", 0, -1, rev=True)           # leaderboard; zrank/zscore/zrange_by_score too
```

## Durable queue

```python
from monlite import create_queue

q = create_queue(db)
q.add("email", {"to": "a@b.c"}, priority=5, max_attempts=3)   # retries + backoff + dedupe (job_id)
q.process("email", lambda payload: send(payload))             # claim+run loop (multi-process safe)
```

A Node `@monlite/queue` worker and this one share `_jobs` — enqueue in Python, process in Node, or
the reverse.

## Cron

```python
from monlite import create_cron, next_cron_run

cron = create_cron(db)
cron.schedule("digest", "0 9 * * *", send_digest, tz="Europe/Istanbul", jitter=30_000)
cron.tick()   # fire due schedules (call on your own loop; multi-process safe via atomic claim)
next_cron_run("*/15 * * * *")  # -> datetime
```

## Full-text search (FTS5)

```python
from monlite import fts

idx = fts(db, "posts", fields=["title", "body"])  # builds the FTS5 index + keeps it current
posts = db.collection("posts")
posts.create({"title": "SQLite is great", "body": "embedded and fast"})
idx.search("sqlite", limit=10)                    # ranked documents (interop-compatible with Node)
```

## Cross-language interop

Each runtime is a complete, independent library; the shared-file interop is a bonus you opt into.
The interop test suite round-trips documents, the **change feed**, **sorted sets**, and the
**queue** between Node and Python over one file. See the
[file format spec](https://qataruts.github.io/monlite/reference/file-format) for the conventions both sides follow.

## Optional extras

The whole stack above is pure standard-library `sqlite3`. Native extras mirror the TypeScript
packages and install separately:

```bash
pip install "monlite[vector]"    # semantic search via sqlite-vec
pip install "monlite[postgres]"  # sync to PostgreSQL
pip install "monlite[mongo]"     # sync to MongoDB
```

## Status

**Documents (with transactions, aggregation, and the change feed), kv (cache, locks, pub/sub,
sorted sets), the durable queue, cron, and FTS5 are implemented** and covered by tests — including
a cross-runtime interop suite. The `[vector]` extra and sync adapters are next. The
[file format](https://qataruts.github.io/monlite/reference/file-format) is the contract every part shares.

MIT
