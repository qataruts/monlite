# monlite on-disk format (v1)

A monlite database is **a plain SQLite file** with a small set of conventions.
This means **any language with a SQLite library can read and write monlite data**
— you do not need a monlite port. This document is the cross-language contract.

There are two levels of interop:

- **Read/write documents** (Tier 0) — trivial; just follow the table layout below.
- **Participate in sync** (Tier 1) — also append to the change feed using the
  version scheme below.

Everything here is regular SQLite: no custom file format, no extensions required
for the core (FTS5/vector are optional SQLite features layered on top).

---

## Collections

Each collection is one SQLite table named exactly after the collection
(identifier-like: `[A-Za-z_][A-Za-z0-9_]*`). There are two physical shapes; both
expose the *same* logical document.

### Document mode (schema-free)

```sql
CREATE TABLE "<collection>" (
  _id        TEXT    PRIMARY KEY,   -- see "Identifiers"
  data       TEXT    NOT NULL,      -- JSON object of all user fields
  created_at INTEGER NOT NULL,      -- creation time, epoch milliseconds
  updated_at INTEGER NOT NULL       -- last-update time, epoch milliseconds
);
```

`data` is the document encoded as JSON **with the system fields removed**
(`_id`, `created_at`, `updated_at` live in their own columns, not in `data`).

### Structured mode (declared columns)

```sql
CREATE TABLE "<collection>" (
  _id        TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',  -- JSON overflow for UNDECLARED fields
  <field>    <TYPE>, ...                     -- one column per declared field
);
```

Declared fields become native columns (`TEXT` / `INTEGER` / `REAL` / `BLOB`;
a `JSON` field is stored as `TEXT` containing JSON). Any field **not** declared
is stored inside the `data` JSON overflow. Indexes are named
`idx_<collection>_<field>` (and `uq_<collection>_<field>` for unique).

### Reconstructing a document (read)

1. Start with `JSON.parse(data)` (`{}` if absent).
2. In structured mode, set each declared column's value (decode `JSON` columns
   with a JSON parse; `NULL` columns round-trip as `null`).
3. Add `_id`, `created_at`, `updated_at` from their columns.

### Writing a document

Reverse the above: split system fields into columns; in structured mode route
declared fields to their columns and everything else into `data`; in document
mode put all user fields into `data`. Set `created_at`/`updated_at` to epoch ms.

---

## Identifiers

`_id` is a **24-character lowercase hex string**, MongoDB **ObjectId-compatible**
(4-byte big-endian seconds timestamp + random + counter), so ids are roughly
time-sortable. Any unique string is accepted as an `_id`, but generated ids use
this scheme. Test with `/^[0-9a-f]{24}$/i`.

---

## Reserved names

Tables and columns prefixed `_monlite_` are reserved for monlite. The system
columns `_id`, `created_at`, `updated_at`, and `data` are reserved on every
collection table. Companion packages own their own tables (e.g. `_kv`, `_jobs`,
`_schedules` for the kv/queue/cron harness, `<coll>_fts` for full-text search);
those are documented by their packages.

---

## Sync participation (Tier 1)

Sync is **opt-in** — these tables exist only in sync-enabled databases. To make
writes replicate, append one change-feed row per mutation.

### Change feed

```sql
CREATE TABLE _monlite_changes (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  coll    TEXT    NOT NULL,               -- collection name
  doc_id  TEXT    NOT NULL,               -- the document _id
  op      TEXT    NOT NULL,               -- 'upsert' | 'delete'
  version TEXT    NOT NULL,               -- LWW token (see below)
  ts      INTEGER NOT NULL,               -- epoch ms
  source  TEXT    NOT NULL DEFAULT 'local', -- 'local', or a remote's name
  pushed  INTEGER NOT NULL DEFAULT 0      -- 0 = not yet pushed to a remote
);
```

Deletes are **tombstones** — a `delete` row in the feed (the document row may be
removed). Readers reconcile by taking, per `(coll, doc_id)`, the row with the
greatest `version`.

### Version tokens (last-write-wins)

A version is a string that sorts correctly with plain comparison:

```
<ms>:<nodeId>[:<seq>]
  ms     = wall-clock epoch milliseconds, zero-padded to 15 digits
  nodeId = this database's stable node id (see _monlite_meta)
  seq    = optional per-node monotonic counter, zero-padded to 12 digits
```

Examples: `000001782538068281:phone` or `000001782538068281:phone:000000000004`.
Greater string = newer. Conflicts resolve to the higher version (ties by nodeId).

### Supporting tables

```sql
CREATE TABLE _monlite_sync_state (         -- per-remote cursor/checkpoint
  remote TEXT PRIMARY KEY, cursor TEXT,
  last_pull_at INTEGER, last_push_seq INTEGER, last_push_at INTEGER
);
CREATE TABLE _monlite_conflicts (          -- audit log of resolved conflicts
  id INTEGER PRIMARY KEY AUTOINCREMENT, coll TEXT, doc_id TEXT,
  local_version TEXT, remote_version TEXT, winner TEXT, ts INTEGER
);
CREATE TABLE _monlite_meta (key TEXT PRIMARY KEY, value TEXT); -- holds 'nodeId'
```

---

## Example (Python, read-only — no monlite needed)

```python
import sqlite3, json
con = sqlite3.connect("app.db")
for _id, data, created in con.execute("SELECT _id, data, created_at FROM notes"):
    doc = json.loads(data)
    doc["_id"] = _id
    print(doc)
```

Writing is the inverse `INSERT`/`UPDATE`; to participate in sync, also
`INSERT INTO _monlite_changes (...)` with a correctly-formatted `version`.

---

## Versioning of this spec

This is format **v1**. The on-disk columns are plain SQLite types, so the format
can evolve additively. Tools should ignore unknown `_monlite_*` tables/columns.
