---
id: structured
title: Structured collections
---

# Structured collections

By default a collection is **schema-free**: every document is stored as JSON in a single `data`
column. Declare a **schema** and a collection becomes **structured** — the listed fields are
promoted to real, typed SQL columns (fast, indexable, joinable, constrainable) while any
undeclared fields overflow into the JSON `data` column. The CRUD and query API is **identical**
in both modes; structured mode only changes how the chosen fields are stored on disk.

```ts
const users = db.collection("users", {
  schema: {
    email: { type: "TEXT", unique: true },
    age: { type: "INTEGER", index: true },
    tenantId: { type: "TEXT", references: "tenants(_id)" },
    role: "TEXT", // shorthand for { type: "TEXT" }
  },
});

await users.create({ data: { email: "a@x.com", age: 30, role: "admin", bio: "..." } });
// email/age/role/tenantId -> native columns; `bio` -> JSON overflow.
```

- A collection's mode is fixed on **first access**. Reopening the same collection with a
  different schema/mode throws — the storage layout can't change underneath existing data.
- Declared fields become real columns (with optional indexes, uniqueness, defaults, and foreign
  keys). Undeclared fields still work transparently — they live in the JSON overflow.
- An explicit `null` in a declared column round-trips as `null` (SQL columns always exist).
- Introspect with `collection.mode` (`"document"` | `"structured"`), `collection.columnNames`,
  or `db.$schema(name)` (physical `PRAGMA table_info`).

## Declaring columns

The `schema` maps a field name to either a `ColumnType` string or a full `ColumnDef`.

```ts
type ColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB" | "JSON";

interface ColumnDef {
  type: ColumnType;
  index?: boolean;     // create a secondary index on the column
  unique?: boolean;    // enforce uniqueness
  notNull?: boolean;   // reject NULLs
  default?: string | number | null; // literal default for omitted fields
  references?: string; // foreign key target, e.g. "users(_id)" or "users"
}
```

Type notes:

- `TEXT`, `INTEGER`, `REAL`, `BLOB` map to SQLite column affinities. `BLOB` stores binary
  (`Buffer` / `Uint8Array`); `Date` values are accepted and bound natively.
- `JSON` is stored as `TEXT` but is the column type to use when a declared field holds a
  **structured value** (object or array): it is serialized on write and parsed back on read. A
  non-JSON column rejects objects/arrays with a typed error — declare it `JSON` instead.
- `INTEGER` columns reject JS numbers above the safe-integer range (2^53); pass a `BigInt` for an
  exact large value, or use a `TEXT` column for large ids — this prevents silent precision loss.
- A column `default` is applied for omitted fields and reflected in the returned document (it
  binds the default, not an explicit `NULL`, so it cooperates with `notNull`).
- `references` adds a SQL foreign key (monlite enables `PRAGMA foreign_keys` on open).

```ts
const events = db.collection("events", {
  schema: {
    type: { type: "TEXT", notNull: true, index: true },
    payload: { type: "JSON" },              // arbitrary object, queryable
    weight: { type: "REAL", default: 1 },
    blob: { type: "BLOB" },
  },
});
```

## When to use structured vs document mode

Document mode is the default and the right choice for most collections — schema-free, no
migrations, and JSON paths are still fully queryable (with auto-indexing of hot paths). Reach for
structured columns when a field is on a **hot path** and you want native SQL behavior for it:

- **Indexed lookups / range scans** on a field that's queried or sorted constantly.
- **Uniqueness** enforced at the storage layer (a single column or a compound unique index).
- **Foreign keys** referencing another collection.
- **Joins** — `lookup` / aggregation over a real column avoids JSON extraction per row.
- **Typed defaults / NOT NULL** constraints you want the database to enforce.

The trade-off: a native column is faster to filter, sort, index, and join on than a JSON path,
but the collection's column set is fixed up front and schema changes need a migration (additive
changes are automatic; see below). Fields you don't promote still work — they just live in the
JSON overflow with the usual JSON-path query performance. You don't have to declare everything:
declare the few fields that need column behavior and let the rest overflow.

## Compound unique indexes & TTL

`uniqueIndexes` and `ttl` are collection options independent of the schema — they work on
document collections too (fields may be declared columns or JSON paths).

```ts
const jobs = db.collection("jobs", {
  // compound unique — the idempotency / dedupe primitive
  uniqueIndexes: [["tenantId", "jobId", "idempotencyKey"]],
  // TTL — cap unbounded-growth tables
  ttl: { field: "created_at", seconds: 90 * 24 * 60 * 60 },
});

await jobs.purgeExpired(); // delete rows whose ttl field is older than `seconds`
```

- A duplicate on a unique index throws `MonliteUniqueConstraintError`.
- `ttl.field` is a numeric timestamp (epoch ms) — typically `created_at`. `purgeExpired()`
  deletes rows older than `seconds` and returns `{ count }`; call it periodically (e.g. from a
  cron tick). Missing/`NULL` timestamps are never purged.

## Migrations

New declared columns are added **automatically and additively** on next access via
`ALTER TABLE ADD COLUMN` — adding a field to the schema needs no manual step (a `notNull` column
added to a non-empty table needs a `default`, or the migration errors loudly).

For **destructive** changes — dropping a column, renaming one, or changing a column's
type/constraints — use `$migrate()` (structured collections only). It performs a safe,
transactional table rebuild that preserves data:

```ts
const users = db.collection("users", { schema: { name: "TEXT", age: "INTEGER" } });

// Map an existing physical column to a new declared name, and acknowledge a removed one.
await users.$migrate({ rename: { fullname: "name" }, drop: ["legacy"] });
```

A physical column that is neither kept, renamed, nor listed in `drop` is an **unacknowledged
drop** and throws — so data is never silently lost. See the
[migrations guide](/guides/migrations) for the full workflow.

## Engine support

Structured collections are a **SQLite-engine** feature. On the
[`@monlite/postgres`](/packages/postgres) engine, collections are document (JSONB) only —
declaring a schema there raises a "structured collections are not yet supported on the postgres
engine" error. Document-mode queries, indexes on JSON paths, aggregation, and realtime all work
on Postgres.
