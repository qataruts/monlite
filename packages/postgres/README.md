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

**Supported today:** `create`, `createMany`, `findMany`, `findFirst`, `findById`, `count`,
`exists`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`.

**Not yet** (these throw a clear error rather than misbehave): `aggregate`, `groupBy`, `distinct`,
`watch` (the changefeed via `LISTEN/NOTIFY`), full-text (`tsvector`), and vector (pgvector). Those
are the next increments.

## Notes

- Requires **PostgreSQL 14+**. The query builder's `?` placeholders are rewritten to `$1,$2,…`.
- Top-level transactions are serialized per driver instance; nested transactions use `SAVEPOINT`s.
- `@monlite/core` stays the minimal, **zero-dependency** local engine — this package is purely
  additive, opt-in.

## License

MIT
