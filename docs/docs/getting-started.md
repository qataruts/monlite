---
id: getting-started
title: Getting started
---

# Getting started

## Install

```bash
# Zero-dependency: uses Node's built-in node:sqlite (Node >= 22.5)
npm install @monlite/core

# For Node 18/20, or to avoid the experimental flag:
npm install @monlite/core better-sqlite3
```

`createDb` auto-selects `better-sqlite3` when installed; otherwise falls back to `node:sqlite`.
Both backends are fully tested.

## Open a database

```ts
import { createDb } from "@monlite/core";

const db = createDb("app.db");    // file on disk
const mem = createDb(":memory:"); // ephemeral, gone when the process exits
```

## Collections and documents

A collection is created on first use. Type it for end-to-end inference, or leave it untyped
for schema-free usage.

```ts
interface User {
  name: string;
  age: number;
  roles?: string[];
}

const users = db.collection<User>("users");

// Create
await users.create({ data: { name: "Ali", age: 30, roles: ["admin"] } });
await users.createMany({ data: [{ name: "Sara", age: 25 }, { name: "Omar", age: 40 }] });

// Read
const ali = await users.findFirst({ where: { name: "Ali" } });
const admins = await users.findMany({ where: { roles: { has: "admin" } } });
const total = await users.count({ where: { age: { gte: 18 } } });

// Update
await users.update({ where: { _id: ali!._id }, data: { $inc: { age: 1 } } });

// Delete
await users.delete({ where: { _id: ali!._id } });
```

monlite adds `_id`, `created_at`, and `updated_at` to every document automatically.

For typed collections, `where` and `orderBy` reject unknown fields at compile time, and
`select` narrows the result type. Untyped collections (`db.collection("name")`) are fully
schema-free.

## Query operators

```ts
// Comparison
{ age: { gte: 18, lt: 65 } }
{ role: { in: ["admin", "editor"] } }

// String
{ name: { contains: "ali", mode: "insensitive" } }
{ email: { regex: "@acme\\.com$" } }

// Arrays
{ roles: { has: "admin" } }
{ items: { elemMatch: { sku: "A", qty: { gte: 2 } } } }

// Logical
{ OR: [{ role: "admin" }, { age: { gte: 40 } }] }

// Existence
{ profileUrl: { exists: true } }
```

## Opt-in packages

The core handles documents. Install packages for the rest:

```bash
npm install @monlite/vector   # vector / semantic search
npm install @monlite/fts      # full-text search
npm install @monlite/kv       # cache + atomic locks
npm install @monlite/queue    # durable job queue
npm install @monlite/cron     # scheduled jobs
npm install @monlite/sync     # local-first cloud sync
npm install @monlite/wasm     # browser / SQLite-WASM
```

## Where next

- [Documents & CRUD](/core/documents)
- [Queries & operators](/core/queries) — elemMatch, regex, OR/AND, dot-paths
- [Transactions & CAS](/core/transactions)
- [Structured collections](/core/structured) — native SQL columns
- [Aggregation](/core/aggregation) — GROUP BY, $lookup, pipelines
- [The AI-agent backend guide](/guides/ai-agent-backend)
