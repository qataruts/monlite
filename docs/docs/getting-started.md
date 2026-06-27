---
id: getting-started
title: Getting started
---

# Getting started

## Install

```bash
# Zero-dependency: uses Node's built-in node:sqlite (Node ≥ 22.5)
npm install @monlite/core

# …or add the native driver (Node 20+, auto-selected when present)
npm install @monlite/core better-sqlite3
```

`createDb()` auto-selects `better-sqlite3` if installed, otherwise falls back to
`node:sqlite`. Both are fully tested.

## Open a database

```ts
import { createDb } from "@monlite/core";

const db = createDb("app.db");      // file on disk
const mem = createDb(":memory:");   // ephemeral
```

## Collections & documents

A collection is created on first use. Type it for end-to-end inference, or leave
it untyped (schema-free).

```ts
interface User {
  _id: string;        // monlite adds _id, created_at, updated_at
  name: string;
  age: number;
  roles?: string[];
}

const users = db.collection<User>("users");

await users.create({ data: { name: "Ali", age: 30, roles: ["admin"] } });
await users.createMany({ data: [{ name: "Sara", age: 25 }, { name: "Omar", age: 40 }] });

const ali = await users.findFirst({ where: { name: "Ali" } });
const admins = await users.findMany({ where: { roles: { has: "admin" } } });

await users.update({ where: { _id: ali!._id }, data: { age: 31 } });
await users.delete({ where: { _id: ali!._id } });

await users.count({ where: { age: { gte: 18 } } });
```

For typed collections, `where`/`orderBy` reject unknown fields and `select`
narrows the result type. Untyped collections (`db.collection("users")`) are fully
schema-free.

## Where next

- [Documents & CRUD](/core/documents)
- [Queries & operators](/core/queries) — including `elemMatch` and `regex`
- [Transactions & CAS](/core/transactions)
- [The package family](/packages/vector)
