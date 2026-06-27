# Guide: schema & migrations

monlite has two storage modes, and how much you think about migrations depends on
which you use.

## Document mode — nothing to migrate

A collection with no `schema` stores every document as JSON. There are no columns
to evolve — add or remove fields freely, anytime:

```ts
const users = db.collection("users");
await users.create({ data: { name: "Ali" } });
await users.create({ data: { name: "Sara", age: 30, tags: ["x"] } }); // different shape, fine
```

## Structured mode — additive changes are automatic

A collection with a `schema` maps declared fields to native columns. **Adding a
new field is automatic**: re-declare the collection with the new column and
monlite runs `ALTER TABLE ADD COLUMN` on open.

```ts
// v1
db.collection("orders", { schema: { total: "REAL" } });

// v2 — just add the column; existing rows get the default/NULL
db.collection("orders", { schema: { total: "REAL", status: { type: "TEXT", default: "new" } } });
```

> Give a `NOT NULL` column a `default` so existing rows can be backfilled when the
> column is added.

## Destructive changes — `$migrate()`

Dropping, renaming, or changing a column's type/constraints can't be done with a
plain `ALTER` in SQLite. `collection.$migrate()` performs them with a safe,
transactional **table rebuild** (create new table → copy data → swap → recreate
indexes) that reconciles the table to your **new declared schema**.

```ts
// New schema: `fullname` → `name`, `age` is now INTEGER, `legacy` removed.
const users = db.collection("users", { schema: { name: "TEXT", age: "INTEGER" } });

await users.$migrate({
  rename: { fullname: "name" }, // copy data from the old column
  drop: ["legacy"], // acknowledge the removal
});
```

What it does:

| Change | How |
| --- | --- |
| **Add** column | automatic (or part of the rebuild) |
| **Rename** column | `rename: { old: new }` (new must be in the schema) |
| **Drop** column | list it in `drop: [...]` |
| **Change type / constraint** | just declare the new type — the rebuild re-casts data |

**Safety:** a column that exists on disk but is *neither* in the new schema *nor*
in `drop` throws — so you can never lose data by forgetting to declare a field.

### Recipes

```ts
// Rename only
await c.$migrate({ rename: { email_address: "email" } });

// Drop a column
await c.$migrate({ drop: ["deprecated"] });

// Change a type: declare the new type, then rebuild
db.collection("c", { schema: { qty: "INTEGER" } }); // was TEXT
await db.collection("c").$migrate();
```

## Tips

- **Run migrations at startup**, before using the collection.
- **Snapshot first** for safety: `await db.backup("backup.db")` writes a
  consistent copy via `VACUUM INTO`.
- Migrations run in a transaction — a failure rolls back, leaving the table intact.
