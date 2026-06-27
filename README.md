# 🌙 monlite

> **The local-first data platform for TypeScript.** Documents, vectors, full-text
> search, cache, queue, cron — and reactive live queries — in **one SQLite file**,
> with a **zero-dependency core**. The complete local backend for AI agents.

```ts
import { createDb } from "@monlite/core";

const db = createDb("./app.db");
const users = db.collection("users");

await users.create({ data: { name: "Ali", age: 28 } });
await users.findMany({ where: { age: { gte: 18 } } });
```

That's the whole setup — no server, no migrations, no config. Your data is in `app.db`.

📖 **Full documentation:** [monlite.dev](https://monlite.dev) · 🤖 [The local AI-agent backend](#the-complete-local-backend-for-an-ai-agent)

---

## One file replaces your local stack

monlite is a **platform**, not just a document store. The zero-dependency core does
documents; opt-in packages cover the rest — each a separate `npm install`, so you
only pull what you use.

| Package | Replaces | Adds |
| --- | --- | --- |
| **[`@monlite/core`](https://www.npmjs.com/package/@monlite/core)** | MongoDB | documents + native-column tables, one query API, transactions, **reactive `watch()`** |
| **[`@monlite/vector`](https://www.npmjs.com/package/@monlite/vector)** | Qdrant / Pinecone | vector / semantic search (sqlite-vec) — `findSimilar()` + dynamic `createVectorStore()` |
| **[`@monlite/fts`](https://www.npmjs.com/package/@monlite/fts)** | search engines | full-text search (SQLite FTS5) — `search()` + dynamic `createSearchIndex()` |
| **[`@monlite/kv`](https://www.npmjs.com/package/@monlite/kv)** | Redis (cache) | synchronous cache + locks with TTL |
| **[`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue)** | BullMQ / Redis | durable job queue — retries, backoff, delays, dedupe |
| **[`@monlite/cron`](https://www.npmjs.com/package/@monlite/cron)** | cron | persisted scheduled jobs |
| **[`@monlite/sync`](https://www.npmjs.com/package/@monlite/sync)** | cloud sync | local-first replication to MongoDB / PostgreSQL / MySQL |
| **[`@monlite/wasm`](https://www.npmjs.com/package/@monlite/wasm)** | — | run it all in the **browser** (SQLite-WASM) |

> Same file from **Python**, too — [`pip install monlite`](https://pypi.org/project/monlite/)
> reads and writes the same `.db`.

With reactive `watch()` + cloud `sync`, monlite is effectively a **local-first
Firebase**: live data, no Docker, no servers.

---

## The complete local backend for an AI agent

A coding agent, RAG app, or autonomous worker needs the same local services — and
monlite is **all of them, in one `.db`, with no Docker, no Redis, no Qdrant**.

| Agent needs | monlite |
| --- | --- |
| Memory / state | `@monlite/core` documents |
| Semantic recall (RAG) | `@monlite/vector` — `createVectorStore()` |
| Keyword recall | `@monlite/fts` — `createSearchIndex()` |
| Cache & locks | `@monlite/kv` — `setNX` |
| Durable task queue | `@monlite/queue` — retries, dedupe |
| Scheduling | `@monlite/cron` |
| Exactly-once job claim | `findOneAndUpdate` — cross-process CAS |
| Live UI updates | `collection.watch()` |

```ts
// RAG memory — scoped + exact — in the same file as everything else
const mem = createVectorStore(db);
mem.ensureCollection("memory", { dimensions: 384, indexedFields: ["agentId"] });
mem.upsert("memory", [{ id, vector, metadata: { agentId, text } }]);
const recall = mem.search("memory", { vector: q, topK: 5, where: { agentId } });

// a durable job a separate worker claims exactly ONCE (cross-process CAS)
const claimed = await jobs.findOneAndUpdate({
  where: { _id: jobId, status: "pending" },
  data: { $set: { status: "active" }, $inc: { version: 1 } },
  returnDocument: "after",
});
```

This is exactly how a real durable job/mission/approval engine + RAG can run on a
**single file** — proven in production integration. See the
[AI-agent backend guide](https://monlite.dev/guides/ai-agent-backend).

---

## Why monlite

- **One file.** Documents, vectors, cache, queue, cron — all in one SQLite file.
  Backup = copy the file.
- **Zero-dependency core.** Runs on Node's built-in `node:sqlite` (Node ≥ 22.5) with
  no native build, or on `better-sqlite3` when you install it.
- **One query API.** Mongo/Prisma-style `find`/`where`/`orderBy`/`groupBy`, the same
  whether a field is JSON or a native SQL column.
- **Production-hardened.** Atomic async transactions, cross-process compare-and-swap,
  crash-tested durability, observability, encryption at rest, cross-platform CI
  (Linux/macOS/Windows).
- **Local-first.** Sync to MongoDB / PostgreSQL / MySQL when you want the cloud.

**Boundary:** monlite targets **local / edge / desktop / single-machine**. For
multi-site shared state, very high write volume, or strict HA, keep the managed
services and [sync](https://monlite.dev/packages/sync) to them — same code, flip the
backend.

---

## Install

```bash
npm install @monlite/core
```

Zero required dependencies — on **Node 22.5+** it uses built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html). For Node 18/20 (or to avoid the
experimental warning), also install the native driver:

```bash
npm install @monlite/core better-sqlite3
```

---

## A 60-second tour

```ts
// Typed collections: where/orderBy are checked, select narrows the result
interface User { name: string; age: number; roles?: string[] }
const users = db.collection<User>("users");

await users.createMany({ data: [{ name: "Ali", age: 30 }, { name: "Sara", age: 25 }] });
await users.findMany({ where: { age: { gte: 18 }, roles: { has: "admin" } }, orderBy: { age: "desc" } });

// Rich operators — elemMatch, regex, dot-paths
await orders.findMany({ where: { items: { elemMatch: { sku: "A", qty: { gte: 2 } } } } });
await users.findMany({ where: { email: { regex: "@acme\\.com$" } } });

// Atomic transactions + compare-and-swap
await db.transactionAsync(async (tx) => { /* read → compute → write, all-or-nothing */ });

// Reactive live queries — re-runs only when a relevant change lands
const handle = users.watch({ where: { roles: { has: "admin" } } }, (u) => render(u.results));
```

→ Full reference: **[Documents](https://monlite.dev/core/documents)** ·
[Queries](https://monlite.dev/core/queries) ·
[Transactions & CAS](https://monlite.dev/core/transactions) ·
[Structured collections](https://monlite.dev/core/structured) ·
[Aggregation](https://monlite.dev/core/aggregation).

---

## Reactive — a local-first Firebase

`collection.watch()` delivers an initial snapshot, then re-emits only when a change
actually affects the result set (row-level matching) — including changes applied by
`@monlite/sync`. Wrap it in a hook for auto-updating UI:

```ts
const stop = todos.watch({ where: { done: false } }, ({ results, added, removed }) => {
  setTodos(results);
});
```

---

## Cross-language — Python & interop

A monlite database is **plain SQLite + documented conventions**, so other languages
read and write the same file. The Python port mirrors the API:

```python
from monlite import create_db, kv
db = create_db("app.db")                      # the SAME file Node uses
db.collection("users").find_many(where={"age": {"gte": 18}})
kv(db).set("session:42", {"user": "ali"}, ttl=60_000)
```

The classic split is first-class: **Python ingests/embeds, Node serves**, over one
file. See [Python / interop](https://monlite.dev/reference/python) and the
[file format](https://monlite.dev/reference/file-format).

---

## Documentation

The full guide lives at **[monlite.dev](https://monlite.dev)**:

- [Getting started](https://monlite.dev/getting-started) · [Core API](https://monlite.dev/core/documents)
- Packages: [sync](https://monlite.dev/packages/sync) · [vector](https://monlite.dev/packages/vector) · [fts](https://monlite.dev/packages/fts) · [kv](https://monlite.dev/packages/kv) · [queue](https://monlite.dev/packages/queue) · [cron](https://monlite.dev/packages/cron) · [wasm](https://monlite.dev/packages/wasm)
- Guides: [production](https://monlite.dev/guides/production) · [migrations](https://monlite.dev/guides/migrations) · [the AI-agent backend](https://monlite.dev/guides/ai-agent-backend) · [custom adapters](https://monlite.dev/guides/custom-adapter)
- Reference: [file format](https://monlite.dev/reference/file-format) · [Python](https://monlite.dev/reference/python) · [benchmarks](https://monlite.dev/reference/benchmarks)

Runnable demos are in [`examples/`](examples/); the docs site source is in [`docs/`](docs/).

---

## Status

Production-ready and published. Current versions: `@monlite/core` **2.6.1**,
`@monlite/sync` 1.3.0, `@monlite/vector` & `@monlite/fts` 0.4.0,
`@monlite/kv` & `@monlite/queue` 0.2.0, `@monlite/cron` 0.1.1, `@monlite/wasm` 0.2.0.
The 2.x API is frozen. The Python port (`pip install monlite`) currently covers
documents + kv, with the rest of the family on the way.

## License

MIT 🌙
