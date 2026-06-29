---
id: postgres
title: "@monlite/postgres"
---

# @monlite/postgres — the Postgres engine

The same monlite API, on a networked **Postgres** (documents stored as JSONB) instead of a local
SQLite file. The collection code you write is **identical** — develop against a `.db` file, deploy
to Postgres, don't rewrite a line.

```bash
npm install @monlite/core @monlite/postgres pg
```

```ts
import { createDb } from "@monlite/postgres";

const db = createDb("postgres://user@host/db");

await db.collection("users").create({ data: { name: "Ada", age: 30, tags: ["admin"] } });
const adults = await db.collection("users").findMany({
  where: { age: { gte: 18 }, tags: { has: "admin" } },
  orderBy: { age: "desc" },
});
```

Or pass the engine to core's `createDb`:

```ts
import { createDb } from "@monlite/core";
import { postgres } from "@monlite/postgres";

const db = createDb("pg", { driver: postgres("postgres://…", { pool: { max: 10 } }) });
```

## How it works

`@monlite/core` exposes an **async driver seam**: a collection's data methods are all `async`, so
an engine that talks to the network is invisible above the API. `@monlite/postgres` provides that
driver — documents become a `jsonb` column, the shared query builder emits the Postgres dialect
(`->`/`->>`/`@>`/`~`, `jsonb_array_elements`, `to_jsonb`), and transactions run on a pooled client
with `SAVEPOINT`s. The SQLite path is byte-for-byte unchanged; this package is purely additive.

## What works

The whole **data surface** runs on Postgres:

- **CRUD** — `create`, `createMany`, `findMany`, `findFirst`, `findById`, `count`, `exists`,
  `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `findOneAndUpdate`, `bulkWrite`,
  `purgeExpired`.
- **The full query language** — operators, nested paths, arrays, `AND`/`OR`/`NOT`, `orderBy`,
  `take`/`skip`, `select`.
- **Aggregation** — `aggregate`, `groupBy` (with `having` and `orderBy`), `distinct`.
- **Realtime** — [`watch()`](../core/realtime) over Postgres `LISTEN/NOTIFY`. A per-table trigger
  notifies on every write **from any connection**, so live queries are truly cross-process; the
  delta engine (added/removed/changed/moved) is shared with the SQLite path.
- **Full-text search** — [`@monlite/fts`](./fts) on a native generated `tsvector` column + GIN
  index, maintained by Postgres (`websearch_to_tsquery`).
- **Vector search** — [`@monlite/vector`](./vector) on a native generated `vector` column + HNSW
  index (**pgvector**).

Job queue too — [`@monlite/queue`](./queue)'s `createPgQueue(db)` claims with `FOR UPDATE SKIP
LOCKED` so workers across processes never contend.

**Not yet:** only `explain()` (Postgres' `EXPLAIN` output is engine-specific — it throws a clear
error).

## The Docker image

A ready-to-use [`monlite/postgres`](https://github.com/qataruts/monlite/tree/main/docker/postgres)
image bundles Postgres 16 + **pgvector**, with the extension enabled on first boot and
`LISTEN/NOTIFY` available out of the box:

```bash
docker run -d -e POSTGRES_PASSWORD=monlite -p 5432:5432 monlite/postgres:16
```

## Notes

- Requires **PostgreSQL 14+** (vector search needs pgvector — the image bundles it).
- The query builder's `?` placeholders are rewritten to `$1,$2,…` at execution.
- Top-level transactions are serialized per driver instance; nested ones use `SAVEPOINT`s.
- For `LISTEN/NOTIFY`, avoid transaction-pooling proxies (PgBouncer in transaction mode), which
  drop notifications.
