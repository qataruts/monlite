# @monlite/postgres

The **Postgres engine** for [monlite](https://qataruts.github.io/monlite). The same
`@monlite/core` API — documents, queries, the full CRUD surface — on a networked **Postgres**
(documents stored as JSONB) instead of a local SQLite file. **Swap the engine, not your code.**

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

## Same API, different engine

Documents become `jsonb`; the query builder emits the Postgres dialect (`->`/`->>`/`@>`/`~`,
`jsonb_array_elements`, `to_jsonb`); transactions run on a pooled client with `SAVEPOINT`s. The
`db.collection(...)` API is **identical** to SQLite-backed monlite — develop on a `.db` file,
deploy to Postgres, don't rewrite a line.

**The whole data surface works:**

- **CRUD** — `create`, `createMany`, `findMany`, `findFirst`, `findById`, `count`, `exists`,
  `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `findOneAndUpdate`, `bulkWrite`,
  `purgeExpired`.
- **Aggregation** — `aggregate`, `groupBy` (with `having` + `orderBy`), `distinct`.
- **Realtime** — `watch()` via Postgres `LISTEN/NOTIFY` (truly cross-process — a write from any
  connection reaches every watcher).
- **Full-text search** — [`@monlite/fts`](https://www.npmjs.com/package/@monlite/fts) on a native
  generated `tsvector` column + GIN index.
- **Vector search** — [`@monlite/vector`](https://www.npmjs.com/package/@monlite/vector) on a
  native generated `vector` column + HNSW index (**pgvector**).

- **Job queue** — [`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue)'s
  `createPgQueue(db)`, claiming with `FOR UPDATE SKIP LOCKED`.

**Not yet:** only `explain()` (Postgres' `EXPLAIN` output is engine-specific — throws a clear error).

## Notes

- Requires **PostgreSQL 14+** (vector search needs **pgvector**; the
  [`monlite/postgres`](../../docker/postgres) image bundles it). Placeholders `?` are rewritten to
  `$1,$2,…`.
- Top-level transactions are serialized per driver instance; nested transactions use `SAVEPOINT`s.
- `@monlite/core` stays the minimal, **zero-dependency** local engine — this package is purely
  additive, opt-in.

## License

MIT
