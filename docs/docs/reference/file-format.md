---
id: file-format
title: File format
---

# File format

A monlite database is **a plain SQLite file** plus a few documented conventions.
Any language with a SQLite binding can read and write it — that's the
cross-language contract.

## Documents

A document collection `users` is a table:

```sql
CREATE TABLE users (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,        -- JSON document body
  created_at INTEGER NOT NULL,     -- epoch ms
  updated_at INTEGER NOT NULL
);
```

Read it from anywhere:

```sql
SELECT _id, data FROM users WHERE json_extract(data, '$.age') >= 18;
```

Structured collections promote declared fields to native columns (the rest stay
in `data`).

## Companion tables

Each companion package is its own conventioned table(s) in the same file:

| Package | Tables (shape) |
|---|---|
| `@monlite/kv` | a key/value table with `key`, JSON `value`, `expires_at` |
| `@monlite/queue` | a `_jobs` table: `queue`, `status`, JSON `payload`, `run_at`, attempts |
| `@monlite/cron` | a schedule table: name, cron expr, next-run |
| `@monlite/fts` | FTS5 virtual tables (`<coll>_fts`) |
| `@monlite/vector` | `sqlite-vec` `vec0` virtual tables |
| `@monlite/sync` | a change-feed table with per-doc LWW versions + tombstones |

Because these are ordinary SQLite tables, you can inspect, back up (copy the
file), and **interoperate across languages** — see [Python](/reference/python).
