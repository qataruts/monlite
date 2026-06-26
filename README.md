# 🌙 monlite

> An embedded document database for TypeScript apps.
> MongoDB-like API. Prisma-like DX. SQLite under the hood. Zero config.

monlite is a local-first document database that lives inside your app as a
single `.db` file. No server to run, no schema to define, no migrations to
manage. You get the flexibility of MongoDB, the familiarity of a Prisma-style
API, and the reliability of SQLite — all in one `npm install`.

```ts
import { createDb } from "@monlite/core";

const db = createDb("./app.db");
const users = db.collection("users");

await users.create({ data: { name: "Ali", age: 28 } });
await users.findMany({ where: { age: { gte: 18 } } });
```

That's it. No setup. No config. Your data is in `app.db`.

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

// String (case-sensitive; wildcards are matched literally)
where: { name: { contains: "li" } }
where: { name: { startsWith: "A" } }
where: { name: { endsWith: "i" } }

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

---

## Structured collections (the SQL skin)

By default a collection is **document mode** — schema-free, every field stored
as JSON. Pass a `schema` to make it a **structured collection**: the declared
fields become real, typed SQL columns (fast, indexable, joinable, constrainable)
and any *other* fields overflow into a JSON column. **The CRUD/query API is
identical** — `find`, `where`, `orderBy`, `groupBy`, `distinct`, updates — only
the storage underneath changes.

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

> Note: structured collections are not yet covered by `@monlite/sync` (document
> collections are) — that's planned follow-up work.

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

---

## Database management

```ts
await db.$collections();   // string[] of collection names
await db.$drop("users");   // drop a collection and its data
await db.$dropAll();       // drop everything
await db.$disconnect();    // close the connection
db.sqlite;                 // the underlying native driver handle
db.driverName;             // "better-sqlite3" | "node:sqlite"
```

---

## Drivers & zero dependencies

monlite talks to SQLite through a tiny driver adapter, so it runs on two
interchangeable backends:

| Backend | When it's used | Notes |
|---|---|---|
| **`node:sqlite`** | Built into Node **22.5+** | **Zero dependencies.** Still flagged experimental by Node, so it prints a one-time `ExperimentalWarning`. |
| **`better-sqlite3`** | When the package is installed | Battle-tested native driver. Works on Node 18/20/22, no warning. Install it yourself: `npm i better-sqlite3`. |

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

## License

MIT 🌙
