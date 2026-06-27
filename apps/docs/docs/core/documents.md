---
id: documents
title: Documents & CRUD
---

# Documents & CRUD

Every document gets three system fields: `_id` (string, auto-generated if omitted),
`created_at`, and `updated_at` (epoch ms).

## Create

```ts
await users.create({ data: { name: "Ali", age: 30 } });          // → WithId<User>
await users.create({ data: { _id: "u1", name: "Sara" } });        // explicit _id
await users.createMany({ data: [{ name: "Omar" }, { name: "Lina" }] });
```

## Read

```ts
await users.findById("u1");
await users.findFirst({ where: { name: "Ali" } });
await users.findUnique({ where: { _id: "u1" } });
await users.findMany({ where: { age: { gte: 18 } }, orderBy: { age: "desc" }, take: 20, skip: 0 });
await users.count({ where: { age: { gte: 18 } } });
await users.exists({ where: { name: "Ali" } });
```

`select` narrows both the returned columns and (for typed collections) the result type:

```ts
const names = await users.findMany({ select: { name: true } }); // { _id, name }[]
```

## Update

```ts
await users.update({ where: { _id: "u1" }, data: { age: 31 } });
await users.updateMany({ where: { age: { lt: 18 } }, data: { $set: { minor: true } } });
await users.upsert({ where: { _id: "u1" }, create: { name: "Ali" }, update: { $inc: { visits: 1 } } });
```

Update operators: `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet` (with `$each`).

## Delete

```ts
await users.delete({ where: { _id: "u1" } });
await users.deleteMany({ where: { age: { lt: 13 } } });
```

## Bulk & atomic ops

```ts
// Mixed operations in one transaction (all-or-nothing)
await users.bulkWrite([
  { insertOne: { name: "A" } },
  { updateMany: { where: { age: { gte: 65 } }, data: { $set: { senior: true } } } },
  { deleteOne: { where: { _id: "x" } } },
]);

// Atomic read-modify-return (compare-and-swap) — see Transactions
const claimed = await jobs.findOneAndUpdate({
  where: { _id: "j1", status: "pending" },
  data: { $set: { status: "active" }, $inc: { version: 1 } },
  returnDocument: "after",
});
```

See [Queries](/core/queries) for the full operator set and [Transactions](/core/transactions)
for atomicity guarantees.
