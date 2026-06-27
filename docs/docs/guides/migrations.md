---
id: migrations
title: Migrations
---

# Migrations

## Additive (automatic)

Declaring a structured collection ensures and migrates its table immediately. New
declared columns are added via `ALTER TABLE ADD COLUMN`:

```ts
// v1
db.collection("users", { schema: { email: { type: "text" } } });

// v2 — `age` is added automatically on next open
db.collection("users", { schema: { email: { type: "text" }, age: { type: "integer" } } });
```

A new `NOT NULL` column without a default throws a clear error (it can't be
back-filled safely).

## Destructive ($migrate)

For changes the additive path can't do — **drop**, **rename**, or **change a
column's type/constraints** — use `$migrate`. It's a safe, transactional table
rebuild that preserves data and recreates indexes:

```ts
await db.collection("users").$migrate({
  rename: { fullName: "name" },
  drop: ["legacyField"],           // dropping requires acknowledgement
});
```

An unacknowledged column drop throws, so data is never lost by accident.

## Document collections

Document collections are schemaless — there's nothing to migrate. Reshape data
with an `updateMany` + update operators, or a one-off script over `findMany`.
