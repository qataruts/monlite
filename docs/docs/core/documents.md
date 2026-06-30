---
id: documents
title: Documents & CRUD
---

# Documents & CRUD

A collection stores plain JSON documents. You get one from the database handle and
call CRUD methods on it:

```ts
import { createDb } from "@monlite/core";

const db = createDb("./app.db");
const users = db.collection("users");

const ada = await users.create({ data: { name: "Ada", age: 30, tags: ["admin"] } });
// → { name: "Ada", age: 30, tags: ["admin"], _id: "…", created_at: …, updated_at: … }
```

Every method on a collection is `async` (returns a `Promise`), so the exact same code
runs unchanged on the [Postgres engine](/packages/postgres), which is asynchronous by
nature. On the local SQLite engine the work happens synchronously and the promise
resolves immediately.

## System fields

monlite manages three fields on every stored document — you never set them by hand:

| Field | Type | Meaning |
|---|---|---|
| `_id` | `string` | Primary key. Auto-generated (a sortable object id) if you don't pass one. |
| `created_at` | `number` | Unix epoch **milliseconds**, set once at insert. |
| `updated_at` | `number` | Unix epoch milliseconds, bumped on every write to the document. |

`_id` is always stored as a string. If you create a document with a numeric id
(`create({ data: { _id: 123 } })`) it is coerced to `"123"`, and `findById(123)` or
`where: { _id: 123 }` coerce the query value too, so the lookup still matches.

## Typed vs untyped collections

```ts
interface User {
  name: string;
  age: number;
  tags: string[];
}
const users = db.collection<User>("users"); // typed
const log = db.collection("events");         // untyped (Doc = Record<string, any>)
```

A **typed** collection type-checks `where`, `orderBy`, `select`, and the create/update
payloads against `User`, and narrows the return type (an unknown field is a compile
error; dot-paths stay open). An **untyped** collection accepts any field — fully
schema-free. The runtime behavior is identical; typing is purely a compile-time aid.

## Create

### `create`

Insert one document. Returns the stored document including its system fields.

```ts
const order = await orders.create({
  data: { customerId: "c-1", total: 49.9, status: "pending" },
});
order._id;        // generated id
order.created_at; // === order.updated_at at insert time
```

Pass `_id` explicitly to control the key:

```ts
await config.create({ data: { _id: "singleton", theme: "dark" } });
```

### `createMany`

Insert many documents in **one transaction** (all-or-nothing). Returns a count, not
the documents.

```ts
const { count } = await users.createMany({
  data: [
    { name: "Ada", age: 30 },
    { name: "Linus", age: 25 },
  ],
});
// { count: 2 }
```

## Read

### `findById`

Look up a single document by `_id`. Returns `null` if there is no match.

```ts
const user = await users.findById(ada._id); // (User & SystemFields) | null
```

### `findFirst`

The first document matching a `where`, with optional `orderBy`, `select`, `skip`, and
`lookup`. Returns `null` if nothing matches. See [Queries & operators](/core/queries)
for the full `where` surface.

```ts
const newest = await orders.findFirst({
  where: { status: "pending" },
  orderBy: { created_at: "desc" },
});
```

`findUnique` is an alias of `findFirst` (Prisma familiarity). `findFirstOrThrow` is
identical but throws `MonliteError` instead of returning `null`.

### `findMany`

All matching documents. Supports `where`, `orderBy`, `select`, `take`, `skip`, and
`lookup` (joins). With no arguments it returns the whole collection.

```ts
const admins = await users.findMany({
  where: { tags: { has: "admin" }, age: { gte: 18 } },
  orderBy: { age: "desc" },
  take: 20,
});
```

If you set `maxRows` on the database, an unbounded `findMany` (no `take`) that would
return more rows than the cap throws `MonliteQueryError` instead of materializing the
whole table — add a `take` or a tighter `where`.

### `count` and `exists`

```ts
const pending = await orders.count({ where: { status: "pending" } });
const any = await orders.exists({ status: "pending" }); // boolean — stops at the first match
```

`count()` with no args counts the whole collection. `exists()` takes the `where` object
**directly** (not wrapped in `{ where }`) and is cheaper than `count() > 0`.

### `distinct`

The distinct values of a field, optionally scoped by a `where`. Array fields are
**unwound** — each element counts as a value — matching MongoDB's `distinct`.

```ts
await orders.distinct("status");                        // ["pending", "shipped"]
await users.distinct("tags");                           // every distinct tag across all users
await orders.distinct("status", { customerId: "c-1" }); // scoped by a where
```

## Update

Updates take a `where` (which documents) and a `data` payload. The payload is either a
**plain object** (shallow-merged into the document) or one using **update operators** —
the two forms cannot be mixed in one call.

### Update operators

| Operator | Effect |
|---|---|
| `$set` | Set fields (dot-paths supported, e.g. `"address.city"`). |
| `$unset` | Remove fields. Value is `{ field: true }` (or `1`). |
| `$inc` | Add a number to a field (negative to decrement). |
| `$push` | Append a value to an array. |
| `$addToSet` | Append to an array only if not already present. Supports `{ $each: [...] }`. |
| `$pull` | Remove matching values from an array. |

### `update`

Update the **first** matching document. Returns the updated document, or `null` if
nothing matched.

```ts
const updated = await users.update({
  where: { _id: ada._id },
  data: { $inc: { age: 1 }, $push: { tags: "verified" } },
});

// plain-object form (shallow merge)
await users.update({ where: { _id: ada._id }, data: { name: "Ada Lovelace" } });
```

### `updateMany`

Update **every** matching document in one transaction. Returns a count.

```ts
const { count } = await orders.updateMany({
  where: { status: "pending", created_at: { lt: cutoff } },
  data: { $set: { status: "expired" } },
});
```

### `upsert`

Update the first match, or create a document if none exists. The `where`'s equality
fields seed the new document (Prisma/Mongo semantics), so a repeated upsert stays
idempotent instead of inserting duplicates; explicit `create` fields win on conflict.
The find + create/update run in **one transaction**, so concurrent upserts can't both
miss and double-insert. Returns the resulting document.

```ts
await counters.upsert({
  where: { _id: "page-views" },
  create: { _id: "page-views", n: 1 },
  update: { $inc: { n: 1 } },
});
```

## Delete

### `delete`

Delete the **first** matching document. Returns the deleted document, or `null`.

```ts
const removed = await users.delete({ where: { _id: ada._id } });
```

### `deleteMany`

Delete **every** matching document in one transaction. Returns a count. With no `where`
it clears the collection.

```ts
await orders.deleteMany({ where: { status: "expired" } });
await orders.deleteMany(); // delete all
```

## `findOneAndUpdate` — atomic claim / compare-and-swap

Atomically find the first matching document, update it, and return it. `returnDocument`
selects whether you get the document `"before"` or `"after"` the change (default
`"after"`). The read-modify-write runs in a single transaction under `BEGIN IMMEDIATE`,
so a guard placed in the `where` is a true compare-and-swap — even **across processes**.

```ts
// Exactly-once job claim: N workers race, exactly one wins, the rest get null.
const claimed = await jobs.findOneAndUpdate({
  where: { status: "pending" },
  data: { $set: { status: "active", workerId } },
  returnDocument: "after",
});
if (claimed) process(claimed);

// Optimistic concurrency: only update if the version still matches.
const next = await docs.findOneAndUpdate({
  where: { _id, version: 7 },
  data: { $set: { body }, $inc: { version: 1 } },
});
if (!next) throw new Error("stale write — someone else updated it");
```

See [Transactions & compare-and-swap](/core/transactions) for the concurrency
guarantees in depth.

## `bulkWrite` — a mixed batch in one transaction

Run a sequence of `insertOne` / `updateOne` / `updateMany` / `deleteOne` /
`deleteMany` operations atomically. Returns `{ inserted, updated, deleted }` counts.

```ts
const res = await ledger.bulkWrite([
  { insertOne: { account: "a", delta: -100 } },
  { insertOne: { account: "b", delta: +100 } },
  { updateOne: { where: { _id: "a" }, data: { $inc: { balance: -100 } } } },
  { updateMany: { where: { stale: true }, data: { $set: { stale: false } } } },
  { deleteOne: { where: { _id: "tmp" } } },
]);
// { inserted: 2, updated: …, deleted: 1 }
```

If any operation throws, the whole batch rolls back.

## Projection — `select`

`select` narrows the returned shape (and, on a typed collection, the return type). A
`select` of `{ field: true, … }` keeps exactly those fields; dot-paths are supported.
System fields (`_id`, `created_at`, `updated_at`) are always present.

```ts
const slim = await users.findMany({
  where: { tags: { has: "admin" } },
  select: { name: true, age: true },
});
// typed collection → Array<{ name: string; age: number } & SystemFields>
```

On an untyped (`Doc`) collection, `select` still filters the returned fields at runtime
but the static type stays the full document.

## TTL collections — `purgeExpired`

Give a collection a `ttl` option to make documents expire. `field` is a timestamp field
(epoch ms — typically `created_at`); documents older than `seconds` are removed when you
call `purgeExpired()`. Expiry is **not** automatic — call `purgeExpired()` periodically,
e.g. from a [cron](/packages/cron) tick.

```ts
const sessions = db.collection("sessions", {
  ttl: { field: "created_at", seconds: 60 * 60 }, // expire 1h after creation
});

// later, periodically:
const { count } = await sessions.purgeExpired(); // number removed
```

Calling `purgeExpired()` on a collection without a `ttl` option throws. A document
missing the TTL field is never purged.

## Notes & gotchas

- **Update payloads can't mix forms.** Either a plain merge object *or* operators — not
  both in one `data`.
- **`updated_at` changes on every write**; `created_at` is set once. To detect a
  never-modified document, compare them.
- **`distinct` unwinds arrays.** `distinct("tags")` returns individual tags, not array
  values.
- **`exists` takes the where object directly**, while `count`/`findMany`/`findFirst`
  take `{ where }`.
- **The same API runs on Postgres.** Every method here behaves identically on
  [`@monlite/postgres`](/packages/postgres), where documents are stored as JSONB.
  (Columnar/structured collections and `lookup` joins are SQLite-engine features today;
  plain document collections port fully.)
