---
id: structured
title: Structured collections
---

# Structured collections

By default a collection stores documents as JSON. Declare a **schema** to back
chosen fields with **native SQL columns** (typed, indexed, joinable) — other
fields overflow to JSON. The query API is identical.

```ts
const users = db.collection("users", {
  schema: {
    email: { type: "text", unique: true },
    age: { type: "integer", index: true },
    tenantId: { type: "text", references: "tenants(_id)" },
  },
});
```

- Declared fields become real columns (with indexes, uniqueness, foreign keys).
- Undeclared fields still work — they live in the JSON overflow.
- Introspect with `collection.mode` / `db.$schema`.

## Constraints & indexes

```ts
const jobs = db.collection("jobs", {
  // compound unique — the idempotency / dedupe primitive
  uniqueIndexes: [["tenantId", "jobId", "idempotencyKey"]],
  // TTL — cap unbounded-growth tables
  ttl: { field: "created_at", seconds: 90 * 24 * 60 * 60 },
});
await jobs.purgeExpired(); // delete past-TTL rows (or run periodically)
```

A duplicate on a unique index throws `MonliteUniqueConstraintError`.

## Migrations

New declared columns are added automatically (`ALTER TABLE ADD COLUMN`). For
destructive changes (drop/rename/retype), use `$migrate` — see the
[migrations guide](/guides/migrations).
