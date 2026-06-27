---
id: python
title: Python / interop
---

# Python & cross-language interop

monlite is a TypeScript library, but a monlite database is **plain SQLite**. So a
Python program can read and write the **same `.db` file** with the standard
library — no port required. This makes the classic AI split first-class: **Python
ingests and embeds, Node serves**, over one file.

## Documents

```python
import sqlite3, json

db = sqlite3.connect("app.db")
for (_id, data) in db.execute("SELECT _id, data FROM users"):
    doc = json.loads(data)
    print(doc["name"])

# write a document Node will read
import time, uuid
now = int(time.time() * 1000)
db.execute(
    "INSERT INTO users(_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)",
    (str(uuid.uuid4()), json.dumps({"name": "Ada"}), now, now),
)
db.commit()
```

## Full-text search

FTS5 ships with Python's `sqlite3`, so you query the same index Node wrote:

```python
rows = db.execute("SELECT doc_id FROM posts_fts WHERE posts_fts MATCH ?", ("hello",)).fetchall()
```

## Vectors

`sqlite-vec` has official Python bindings:

```python
import sqlite_vec
db.enable_load_extension(True)
sqlite_vec.load(db)
hits = db.execute(
    "SELECT doc_id, distance FROM docs WHERE embedding MATCH ? AND k = 5 ORDER BY distance",
    (json.dumps(query_vector),),
).fetchall()
```

## Cache & queue handoff

The `kv` and `queue` tables are plain SQLite, so a Python worker and a Node API
can hand work back and forth: Python enqueues a job (INSERT into the `_jobs`
table) and Node's `queue.process(...)` picks it up, or vice-versa — sharing one
cache and one queue with no extra infrastructure.

## A native Python package

Because the whole family is "conventions over one SQLite file," a single
`pip install monlite` can mirror the entire family — documents, kv, queue, cron,
fts, vector — over `sqlite3`. That's on the roadmap; until then, the
[file format](/reference/file-format) is the interop contract.
