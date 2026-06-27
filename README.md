# 🌙 monlite

> Your app's local database. A MongoDB-like API and Prisma-style DX in a single
> file. Zero config, zero migrations, zero server.

```ts
import { createDb } from "@monlite/core";

const db = createDb("./app.db");
const users = db.collection("users");

await users.create({ data: { name: "Ali", age: 28 } });
await users.findMany({ where: { age: { gte: 18 } } });
```

That's the whole setup. Your data is in `app.db`.

---

## Mental model (read this first)

monlite is **one database with one query API.** You never have to choose "SQL or
NoSQL." You only choose, per collection, **where each field is stored:**

- **Document mode** (default) — the whole document is stored as JSON. Flexible
  and schema-free, like MongoDB.
- **Structured mode** (`db.collection(name, { schema })`) — the fields you
  declare become real SQL columns (typed, indexed, joinable). Anything else
  overflows into JSON automatically.

> **A schema changes the _storage_, never the _syntax_.**
> `create`, `find`, `where`, `orderBy`, `groupBy` are identical in both modes and
> return identical results — structured mode is just faster and SQL-native underneath.

Raw SQL is the one optional place SQL becomes visible: the `$queryRaw` escape
hatch, for joins/CTEs/window functions the document API doesn't cover.

| You decide… | Document (default) | Structured (`{ schema }`) |
| --- | --- | --- |
| **How you query** | `find` / `where` / `orderBy` / `groupBy` | **identical** |
| **Where a field lives** | JSON `data` blob | a native column (declared) — the rest overflow to JSON |
| **Pick it when** | the shape is unknown or varies per record | the shape is stable and you want joins, FKs, reporting, or fast native indexes |

You can mix both in the same `.db`, and move a collection from document to
structured later without changing a single query.

---

## Install

```bash
npm install @monlite/core
```

**monlite has zero required dependencies.** On **Node 22.5+** it uses the
built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) engine out of the
box. To run on Node 18/20 — or to avoid `node:sqlite`'s experimental warning —
also install the (optional) native driver:

```bash
npm install @monlite/core better-sqlite3
```

See [Drivers & zero dependencies](#drivers--zero-dependencies) below.

---

## When to use monlite

| Situation | Use |
|---|---|
| Desktop / Electron / Tauri app needing local data | ✅ monlite |
| CLI tool with persistent state | ✅ monlite |
| Local-first app syncing with a cloud MongoDB | ✅ monlite |
| Prototype / MVP needing fast iteration, flexible schema | ✅ monlite |
| Server app with Postgres/MySQL | ❌ use your DB directly |
| Strictly relational, known, stable schema | ❌ use SQLite directly |
| Production cloud database | ❌ use MongoDB / a managed DB |

If your data is structured and you already know your schema, plain SQLite adds
nothing on top of monlite — use it directly. monlite earns its keep when your
documents are dynamic, schema-free, or mirror a cloud NoSQL store.

### How monlite compares

| | monlite | MongoDB | better-sqlite3 | Prisma + SQLite |
|---|---|---|---|---|
| Schema-free documents | ✅ | ✅ | ⚠️ manual JSON | ❌ |
| Native typed columns | ✅ (opt-in) | ❌ | ✅ | ✅ |
| Same API for both | ✅ | — | — | — |
| Raw SQL escape hatch | ✅ | ❌ | ✅ | ✅ (`$queryRaw`) |
| No server / single file | ✅ | ❌ | ✅ | ✅ |
| No migrations / codegen | ✅ | ✅ | ✅ | ❌ |
| Aggregation API | ✅ | ✅ | ⚠️ manual | ⚠️ limited |
| Local-first sync | ✅ (`@monlite/sync`) | ⚠️ Atlas/Realm | ❌ | ❌ |
| Runtime dependencies | **0** (Node 22.5+) | server | 1 (native) | several |

---

## Setup

```ts
import { createDb } from "@monlite/core";

const db = createDb("./app.db");      // creates the file if missing
const mem = createDb(":memory:");      // in-memory database
```

### Options

```ts
const db = createDb("./app.db", {
  driver: "auto",       // "auto" | "better-sqlite3" | "node:sqlite" (default: "auto")
  autoIndex: true,      // auto-create indexes on hot JSON paths (default: true)
  autoIndexAfter: 10,   // create an index after a path is queried N times (default: 10)
  readonly: false,      // open read-only (default: false)
  wal: true,            // use WAL journal mode (default: true)
  verbose: (sql) => console.log(sql), // log every executed SQL statement
});
```

---

## Collections

Collections are created automatically on first access — no schema, no migration,
no definition needed. Pass a type for full inference.

```ts
interface User {
  name: string;
  age?: number;
  address?: { city: string };
  tags?: string[];
}

const users = db.collection<User>("users");
```

Every stored document gains three system fields:

| Field | Type | Notes |
|---|---|---|
| `_id` | `string` | Auto-generated, ObjectId-compatible (24 hex chars), time-sortable. Provide your own to override. |
| `created_at` | `number` | Unix epoch milliseconds, set on insert. |
| `updated_at` | `number` | Unix epoch milliseconds, bumped on every update. |

---

## CRUD

```ts
// create
const user = await users.create({
  data: { name: "Ali", age: 28, address: { city: "Riyadh" } },
});
// user._id, user.created_at, user.updated_at are populated

// createMany (single transaction)
await users.createMany({ data: [{ name: "Sara" }, { name: "Omar" }] });

// read
await users.findById("…");                                  // doc | null
await users.findFirst({ where: { name: "Ali" } });          // doc | null
await users.findUnique({ where: { email: "a@x.com" } });    // alias of findFirst
await users.findFirstOrThrow({ where: { name: "Ali" } });   // throws if missing
await users.exists({ role: "admin" });                      // boolean
await users.findMany({
  where: { age: { gte: 18 } },
  orderBy: { age: "desc" },
  select: { name: true, age: true },
  skip: 0,
  take: 10,
});

// update (first match) — returns the updated doc or null
await users.update({ where: { _id: "…" }, data: { age: 29 } });
await users.updateMany({ where: { role: "admin" }, data: { active: true } }); // { count }

// upsert
await users.upsert({
  where: { name: "Ali" },
  create: { name: "Ali", age: 1 },
  update: { age: 2 },
});

// delete — returns the deleted doc or null
await users.delete({ where: { _id: "…" } });
await users.deleteMany({ where: { active: false } });       // { count }
await users.deleteMany();                                    // delete all → { count }

// count
await users.count({ where: { role: "admin" } });
```

---

## Where operators

Prisma-style, no `$` prefix. A bare value is shorthand for `equals`.

```ts
// Comparison
where: { age: 28 }                       // shorthand equals
where: { age: { equals: 28 } }
where: { age: { not: 28 } }              // also matches docs missing the field
where: { age: { gt: 18 } }               // gt, gte, lt, lte
where: { role: { in: ["admin", "editor"] } }
where: { role: { notIn: ["guest"] } }

// String (case-sensitive by default; wildcards are matched literally)
where: { name: { contains: "li" } }
where: { name: { startsWith: "A" } }
where: { name: { endsWith: "i" } }
where: { name: { contains: "ALI", mode: "insensitive" } }  // case-insensitive (ASCII)

// Arrays
where: { tags: { contains: "admin" } }   // element membership
where: { tags: { has: "admin" } }        // explicit element membership

// Existence
where: { phone: { exists: true } }       // field present (even if null)
where: { phone: { exists: false } }

// Nested paths (dot notation)
where: { "address.city": { equals: "Riyadh" } }
where: { "meta.score": { gte: 9 } }

// Logical
where: { AND: [{ age: { gte: 18 } }, { active: true }] }
where: { OR:  [{ role: "admin" }, { role: "editor" }] }
where: { NOT: { role: "guest" } }
where: { role: "admin", age: { gt: 30 } } // multiple fields => implicit AND
```

> `contains`/`startsWith`/`endsWith` are **case-sensitive** (implemented with
> SQLite's `instr`/`substr`, so `%` and `_` are literal). On an array field,
> `contains` checks element membership.

---

## Update operators

The `data` payload is either a plain object (shallow-merged) or update operators.
The two forms cannot be mixed.

```ts
// Default — shallow merge
await c.update({ where: { _id }, data: { age: 29, name: "Ali Updated" } });

// $set — set fields, including nested dot paths
await c.update({ where: { _id }, data: { $set: { "address.city": "Jeddah" } } });

// $inc — increment (missing field starts at 0)
await c.update({ where: { _id }, data: { $inc: { score: 1 } } });

// $push — append to an array ($each pushes many)
await c.update({ where: { _id }, data: { $push: { tags: "moderator" } } });
await c.update({ where: { _id }, data: { $push: { tags: { $each: ["a", "b"] } } } });

// $pull — remove matching elements from an array
await c.update({ where: { _id }, data: { $pull: { tags: "guest" } } });

// $unset — remove a field
await c.update({ where: { _id }, data: { $unset: { temporaryField: true } } });
```

`_id` is immutable — attempts to set it via update data are ignored.

---

## Aggregation

```ts
// aggregate
const stats = await users.aggregate({
  where: { active: true },
  _count: true,
  _sum: { age: true },
  _avg: { age: true },
  _min: { age: true },
  _max: { age: true },
});
// { _count: 42, _sum: { age: 1200 }, _avg: { age: 28.5 }, _min: { age: 18 }, _max: { age: 64 } }

// groupBy
const grouped = await users.groupBy({
  by: ["role"],
  where: { active: true },
  _count: true,
  _sum: { age: true },
  orderBy: { _count: "desc" },
});
// [ { role: "admin", _count: 5, _sum: { age: 140 } }, … ]

// groupBy + having (filter groups by an aggregate, like SQL HAVING)
await users.groupBy({
  by: ["role"],
  _count: true,
  _sum: { age: true },
  having: {
    _count: { gte: 2 },          // keep groups with COUNT(*) >= 2
    _sum: { age: { gt: 50 } },   // and SUM(age) > 50
  },
});
// having comparisons: equals, not, gt, gte, lt, lte — on _count and on
// _sum/_avg/_min/_max of any field.
```

### distinct

```ts
await users.distinct("role");                       // ["admin", "editor"]
await users.distinct("age", { role: "admin" });     // [28, 31]

// Array fields are unwound — each element is a value (like MongoDB):
await users.distinct("tags");                        // ["a", "b", "c"]
```

### Joins (`$lookup` / `$unwind`)

Pull in related documents from another collection with a `lookup` on `findMany`
— a left join, run as **two queries (no N+1)**, in either storage mode:

```ts
// Attach each user's orders as an array ($lookup):
await db.collection("users").findMany({
  lookup: { from: "orders", localField: "_id", foreignField: "user_id", as: "orders" },
});
// → [{ _id: "u1", name: "Ali", orders: [ {…}, {…} ] }, …]

// Flatten to one row per match with `unwind` ($unwind); use "preserve" to keep
// rows that have no match (left-outer):
await db.collection("orders").findMany({
  lookup: { from: "users", localField: "user_id", foreignField: "_id", as: "user", unwind: true },
});
// → [{ _id: "o1", user_id: "u1", user: { _id: "u1", name: "Ali" } }, …]
```

Pass an array of specs to join several collections at once.

---

## Live queries (reactivity)

`collection.watch()` keeps a query result live. The callback fires once
immediately (`type: "init"`) and again whenever a change **affects this query** —
matching is **row-level**, so unrelated writes don't trigger a recompute. It also
fires for changes applied by `@monlite/sync`, so the UI updates when cloud data
arrives.

```ts
const handle = users.watch({ where: { role: "admin" } }, (event) => {
  event.results; // full current result set
  event.added;   // docs that just entered the set
  event.removed; // docs that just left
  event.changed; // docs still in the set whose contents changed
});

handle.results; // current results, kept up to date
handle.stop();  // unsubscribe
```

Perfect for Electron/Tauri UIs: bind `handle.results` to your view and it stays
in sync with every write (local or synced).

---

## Structured collections (native SQL columns)

By default a collection is **document mode** — schema-free, every field stored
as JSON. Pass a `schema` to make it a **structured collection**: the declared
fields become real, typed SQL columns (fast, indexable, joinable, constrainable)
and any *other* fields overflow into a JSON column. **The CRUD/query API is
identical** — `find`, `where`, `orderBy`, `groupBy`, `distinct`, updates. As the
[mental model](#mental-model-read-this-first) says: a schema changes the storage,
not the syntax.

```ts
const orders = db.collection("orders", {
  schema: {
    user_id: { type: "TEXT", index: true, references: "users(_id)" },
    amount: "REAL",
    status: { type: "TEXT", notNull: true, default: "pending" },
    meta: "JSON",            // objects/arrays, transparently (de)serialized
  },
});

// Same API as document collections — but `amount`/`status` are real columns:
await orders.create({ data: { user_id: "u1", amount: 100, status: "paid", note: "rush" } });
await orders.findMany({ where: { amount: { gte: 50 }, status: "paid" } });
await orders.groupBy({ by: ["status"], _sum: { amount: true } });

// Undeclared fields (like `note`) still work — they overflow into JSON.
await orders.findMany({ where: { note: { contains: "rush" } } });
```

Because the columns are native, they join, constrain, and index like any SQL
table — including from the raw SQL hatch with no `json_extract`:

```ts
await db.$queryRaw`
  SELECT u.name, SUM(o.amount) AS revenue
  FROM users u JOIN orders o ON o.user_id = u._id
  GROUP BY u._id
`;
```

Column types: `"TEXT" | "INTEGER" | "REAL" | "BLOB" | "JSON"`. A full column
definition supports `index`, `unique`, `notNull`, `default`, and `references`.

**Migrations are automatic for additive changes.** Re-opening a collection with a
new declared column adds it (`ALTER TABLE ADD COLUMN`) on declaration — give
`NOT NULL` columns a `default` so existing rows can be backfilled.

For **destructive changes** — dropping, renaming, or changing a column's
type/constraints — call `$migrate()`. It safely rebuilds the table (in a
transaction, preserving data and indexes) to match the new declared schema:

```ts
// v2 schema: `fullname` → `name`, `age` is now INTEGER, `legacy` removed.
const users = db.collection("users", { schema: { name: "TEXT", age: "INTEGER" } });
await users.$migrate({ rename: { fullname: "name" }, drop: ["legacy"] });
```

A column that exists on disk but isn't in the new schema (and isn't listed in
`drop`) throws — so you never lose data by accident. Run migrations at startup,
before using the collection.

### Do I have to care: JSON vs native columns?

- **For correctness — no.** Both modes return identical results through the same API.
- **For performance & SQL interop — a little.** Native columns + native indexes are
  faster and join/constrain cleanly; JSON is for when the shape is unknown or varies.

monlite never hides which is which:

```ts
orders.mode;             // "structured" | "document"
await db.$schema("orders"); // physical columns: [{ name, type, notNull, primaryKey }, …]
createDb("./app.db", { verbose: (sql) => console.log(sql) }); // see json_extract vs bare columns
```

> **Rule of thumb:** unknown/flexible shape → document (JSON); known/stable shape
> with heavy joins, reporting, or external SQL tooling → structured (native columns).

> Both document and structured collections are syncable via
> [`@monlite/sync`](#sync--local-first). To sync a structured collection, open it
> with its `schema` on every node before syncing (so each side knows the native
> columns).

---

## Sync & local-first

The companion package [`@monlite/sync`](https://www.npmjs.com/package/@monlite/sync)
replicates a local monlite database with a remote source of truth — MongoDB
first — so apps can work offline and converge when reconnected.

Opt in with `{ sync: true }` (adds a change feed + tombstones + versioning; zero
overhead when off), then drive an engine:

```ts
import { createDb } from "@monlite/core";
import { sync, MongoAdapter } from "@monlite/sync";
import { MongoClient } from "mongodb";

const db = createDb("./app.db", { sync: true });
const mongo = new MongoClient(uri);
await mongo.connect();

const engine = sync(db, {
  adapter: new MongoAdapter({ client: mongo, db: "app" }),
  collections: "*",
  mode: "two-way",   // "pull" | "push" | "two-way"
  conflict: "lww",   // or a custom resolver
  interval: 5000,
});

await engine.start();
```

Pull / push / two-way replication, last-write-wins (or custom) conflict
resolution, and pluggable adapters (`MongoAdapter`, `PostgresAdapter`,
`MySqlAdapter`, `MonliteAdapter` for monlite-to-monlite, `MemoryAdapter` for
tests) — keep local monlite as the embedded runtime and a server DB as the cloud
of record. See the
[`@monlite/sync` README](https://www.npmjs.com/package/@monlite/sync) for details.

---

## SQL escape hatch

When you need full SQL power — complex joins, analytics, cross-collection
queries — drop to raw SQL. Documents live in a `data` JSON column, queryable
with SQLite's `json_extract`.

```ts
// Tagged template — values are safely parameterized
const report = await db.$queryRaw`
  SELECT json_extract(u.data, '$.name')        AS customer,
         SUM(json_extract(o.data, '$.amount')) AS revenue
  FROM users u
  JOIN orders o ON json_extract(o.data, '$.userId') = u._id
  WHERE json_extract(u.data, '$.role') = 'admin'
  GROUP BY u._id
`;

// Execute (returns affected row count)
await db.$executeRaw`UPDATE users SET updated_at = ${Date.now()} WHERE _id = ${id}`;

// String form with positional params
await db.$queryRawUnsafe(`SELECT * FROM users WHERE _id = ?`, id);
await db.$executeRawUnsafe(`DELETE FROM users WHERE _id = ?`, id);

// Synchronous transaction (the callback must not be async)
await db.$transaction((tx) => {
  // ...use tx.collection(...) or tx.sqlite...
});
```

Need the raw driver? `db.sqlite` is the underlying native handle (a
`better-sqlite3` `Database` or a `node:sqlite` `DatabaseSync`, depending on the
active backend), and `db.driverName` tells you which one is in use.

---

## Auto-indexing

monlite tracks which JSON paths your `where`/`orderBy`/aggregation clauses touch.
Once a path crosses the threshold (default 10 queries), an expression index is
created silently:

```sql
CREATE INDEX IF NOT EXISTS idx_users_address_city
ON users(json_extract(data, '$.address.city'));
```

You never think about indexes. Disable with `createDb("./app.db", { autoIndex: false })`.

Want to see whether a query uses an index? Ask:

```ts
await users.explain({ where: { "address.city": "Riyadh" } });
// { sql, usesIndex: true, plan: [{ id, parent, detail }, …] }
```

---

## Database management

```ts
await db.$collections();   // string[] of collection names
await db.$drop("users");   // drop a collection and its data
await db.$dropAll();       // drop everything
await db.backup("./snapshot.db"); // consistent on-disk snapshot
await db.$disconnect();    // close the connection
db.sqlite;                 // the underlying native driver handle
db.driverName;             // "better-sqlite3" | "node:sqlite"
```

---

## Plugins

`@monlite/core` stays lean; heavier or optional capabilities are opt-in plugins
passed to `createDb`:

```ts
import { createDb } from "@monlite/core";
import { fts } from "@monlite/fts";

const db = createDb("./app.db", {
  plugins: [fts({ posts: ["title", "body"] })],
});

await db.collection("posts").search("hello world"); // full-text search
```

| Plugin | Adds |
|---|---|
| [`@monlite/fts`](https://www.npmjs.com/package/@monlite/fts) | Full-text search (SQLite FTS5) via `collection.search()` |
| [`@monlite/vector`](https://www.npmjs.com/package/@monlite/vector) | Vector / semantic search (sqlite-vec) via `collection.findSimilar()` — RAG, agent memory |

Write your own against the `MonlitePlugin` interface (`init` / `afterWrite` /
`collectionMethods` hooks).

---

## The local backend for AI agents

monlite aims to be your **entire local data layer** — one embedded `.db`, one
install — collapsing the services you'd otherwise run (Mongo, Qdrant, Redis) for
a local/edge/desktop agent. Documents and vectors are core + a plugin; the
Redis-style primitives are small companion packages:

| Package | Replaces (locally) | Provides |
|---|---|---|
| [`@monlite/kv`](https://www.npmjs.com/package/@monlite/kv) | Redis cache | Synchronous `get/set/incr` KV with TTLs |
| [`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue) | Redis / BullMQ | Durable job queue — retries, backoff, delays, priorities, concurrency |
| [`@monlite/cron`](https://www.npmjs.com/package/@monlite/cron) | cron / scheduler | Persisted cron schedules; composes with the queue |

```ts
import { kv } from "@monlite/kv";
import { createQueue } from "@monlite/queue";
import { createCron } from "@monlite/cron";

const cache = kv(db);
cache.set("session:42", { user: "ali" }, { ttl: 60_000 });

const queue = createQueue(db, { maxAttempts: 3 });
queue.process("email", async (job) => send(job.payload), { concurrency: 5 });
queue.add("email", { to: "ali@example.com" });

createCron(db).schedule("nightly", "0 0 * * *", () => queue.add("report", {}));
```

These target **local / edge / desktop** runtimes — not a distributed cloud-scale
Redis/Mongo/Qdrant replacement. For scale, keep the real services and
[`@monlite/sync`](https://www.npmjs.com/package/@monlite/sync) to them.

**Building an Electron app?** [`@monlite/electron`](https://www.npmjs.com/package/@monlite/electron)
keeps the database in the main process and shares it with renderer windows over
IPC, with cross-window reactivity.

---

## Drivers & zero dependencies

monlite talks to SQLite through a tiny driver adapter, so it runs on
interchangeable backends:

| Backend | When it's used | Notes |
|---|---|---|
| **`node:sqlite`** | Built into Node **22.5+** | **Zero dependencies.** Still flagged experimental by Node, so it prints a one-time `ExperimentalWarning`. |
| **`better-sqlite3`** | When the package is installed | Battle-tested native driver. Works on Node 18/20/22, no warning. Install it yourself: `npm i better-sqlite3`. |
| **WASM (browser)** | Via [`@monlite/wasm`](https://www.npmjs.com/package/@monlite/wasm) | Runs monlite **in the browser** on SQLite-WASM (sql.js); pass `driver: wasmDriver(SQL)`. Snapshot persistence to IndexedDB/OPFS. |

By default (`driver: "auto"`) monlite uses `better-sqlite3` if it's installed,
otherwise falls back to the built-in `node:sqlite`. Force one explicitly:

```ts
createDb("./app.db", { driver: "node:sqlite" });    // zero-dep (Node 22.5+)
createDb("./app.db", { driver: "better-sqlite3" }); // native, no warning
```

Both backends pass the exact same test suite, so behavior is identical — pick
based on your Node version and whether you want the extra dependency.

> Want truly zero dependencies on Node 22.5+? Just `npm install @monlite/core`
> and don't install `better-sqlite3`. To silence the experimental warning,
> either install `better-sqlite3` or run Node with `--no-warnings`.

---

## Encryption at rest

Encrypt the whole database file with a key. Install the drop-in cipher driver
and pass an `encryption` option:

```bash
npm install better-sqlite3-multiple-ciphers
```

```ts
const db = createDb("./secure.db", { encryption: { key: process.env.DB_KEY } });
// ...use db exactly as normal — everything on disk is encrypted.

db.rekey(newKey); // rotate the key
```

- A **wrong or missing key throws `MonliteEncryptionError`** when opening.
- Optional `cipher` selects the scheme (`"sqlcipher"`, `"chacha20"`,
  `"aes256cbc"`, …); the default is ChaCha20-Poly1305.
- Encryption requires `better-sqlite3-multiple-ciphers` (a drop-in for
  `better-sqlite3`) and is **not** available on the `node:sqlite` backend.

---

## How it works

Every collection is a single SQLite table:

```sql
CREATE TABLE IF NOT EXISTS "users" (
  _id        TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,   -- your document as JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Your entire document lives in the `data` column as JSON; `_id`, `created_at`
and `updated_at` are real columns. SQLite's built-in `json_extract` /
`json_each` power all document queries. No columns are added per field, so
there is no schema and no migration — ever.

All operations are synchronous under the hood (both SQLite backends are sync)
but are exposed as `async` (they return Promises) for API consistency and
future-proofing.

### Notes & limitations

- `_id`, `created_at`, `updated_at` are reserved; document fields with those
  names are managed by monlite and won't round-trip as ordinary data.
- `contains`/`startsWith`/`endsWith` are case-sensitive (see above).
- `$transaction` callbacks run synchronously and must not be `async`.
- Collection names must be identifier-like (`[A-Za-z_][A-Za-z0-9_]*`).

---

## Examples

Runnable demos live in [`examples/`](examples/): a notes app (CRUD + full-text
search + live queries), AI-agent memory (vector + hybrid search), local-first
sync, the cache/queue/cron harness, `$lookup`/`$unwind` joins, and the WASM
browser backend. `cd examples && npm install && node notes.mjs`.

## Guides

- [Schema & migrations](docs/guides/migrations.md) — auto-additive changes and
  `$migrate()` for drop/rename/type-change.
- [Custom adapters & drivers](docs/guides/custom-adapter.md) — add a sync backend
  or a new SQLite binding/environment.

## Benchmarks

[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) compares monlite to the raw SQLite
driver, NeDB, and lowdb (`pnpm bench` to reproduce). In short: ~150k–250k
ops/sec, roughly 2× the raw-driver overhead for the full document API, and it
**stays flat on indexed reads where JSON-file stores degrade** (lowdb point reads
are ~15× slower at 10k docs).

## On-disk format (cross-language)

A monlite database is **just a SQLite file** with documented conventions, so any
language with a SQLite library can read/write it — no port required. The contract
is in [`docs/FORMAT.md`](docs/FORMAT.md).

---

## License

MIT 🌙
