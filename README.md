# monlite

> **Stop spinning up Docker stacks.** Documents, vectors, full-text search, cache, queue, and
> cron — in one SQLite file, with a zero-dependency TypeScript core.

```ts
import { createDb } from "@monlite/core";

const db = createDb("./app.db");
```

That's it. No server. No migrations. No configuration. Everything below lives in `app.db`.

📖 [Docs](https://qataruts.github.io/monlite) · 🎮 [Live demo](https://qataruts.github.io/monlite/demo) — monlite running in your browser · 💻 [GitHub](https://github.com/qataruts/monlite)

---

## Replace your entire local stack with one file

Most local apps, CLIs, and AI agents juggle the same set of services. monlite collapses all
of them into a single `.db` file:

| You were running | monlite gives you |
|---|---|
| MongoDB / Mongoose | `@monlite/core` — document collections, typed queries, reactive `watch()` |
| Redis (cache) | `@monlite/kv` — synchronous cache, atomic locks, TTLs, pub/sub, sorted sets |
| BullMQ + Redis | `@monlite/queue` — durable job queue, retries, backoff, dedupe |
| Qdrant / Pinecone | `@monlite/vector` — vector search, `findSimilar()`, hybrid RAG |
| Elasticsearch / Typesense | `@monlite/fts` — full-text search, FTS5, `search()` |
| Cron server | `@monlite/cron` — persisted scheduled jobs (time zones, jitter) |
| MongoDB Atlas sync | `@monlite/sync` — local-first replication to MongoDB / PostgreSQL / MySQL |
| Firebase / Pusher (realtime) | `@monlite/realtime` — stream live queries & docs to clients over SSE |

**One npm install per feature. One `.db` file for all of them. Backup = `cp app.db backup.db`.**

---

## The AI agent backend — without Docker

A coding agent, RAG pipeline, or autonomous worker typically needs MongoDB for memory,
Redis for cache and locks, Qdrant for semantic search, and BullMQ for the task queue.

With monlite, that entire stack is one file:

```ts
import { createDb } from "@monlite/core";
import { kv } from "@monlite/kv";
import { createVectorStore } from "@monlite/vector";
import { createQueue } from "@monlite/queue";
import { createCron } from "@monlite/cron";

const db = createDb("./agent.db");

// Memory / state — document collections
const memories = db.collection("memories");
await memories.create({ data: { agentId: "a1", content: "user prefers dark mode" } });

// Semantic recall — vector search over embeddings
const store = createVectorStore(db);
store.ensureCollection("memory", { dimensions: 384, indexedFields: ["agentId"] });
const recall = store.search("memory", { vector: queryEmb, topK: 5, where: { agentId: "a1" } });

// Exactly-once job claim — cross-process compare-and-swap
const claimed = await jobs.findOneAndUpdate({
  where: { status: "pending", type: "summarize" },
  data: { $set: { status: "active" }, $inc: { version: 1 } },
  returnDocument: "after",
});
// 8 workers race. Exactly one wins. The rest get null.

// Cache + atomic locks — set-if-absent
const lock = kv(db);
const acquired = lock.setNX("lock:job:42", 1, { ttl: 30_000 }); // true = you own it

// Durable task queue — retries, backoff, dead-letter
const queue = createQueue(db, { maxAttempts: 3 });
queue.process("embed", async (job) => await embed(job.payload.text), { concurrency: 4 });

// Scheduled work — persisted across restarts
const cron = createCron(db);
cron.schedule("nightly-cleanup", "0 3 * * *", () => queue.add("cleanup", {}));
```

No Docker. No `.env` files with connection strings. No Redis setup. **One file, `node serve.mjs`.**

---

## Real-time reactivity — local Firebase

`collection.watch()` delivers a live result set that re-emits only when a relevant change lands.
Row-level matching, no spurious re-renders. Watch a single doc with `watchDoc()`, scope to
specific `fields`, and get `added`/`removed`/`changed`/`moved` deltas. Works with changes from
`@monlite/sync` too.

```ts
// Initial snapshot → then re-fires only when an admin is added/changed/removed
const stop = users.watch(
  { where: { roles: { has: "admin" } } },
  ({ results, added, removed }) => renderAdminList(results),
);

// Single-document listener (Firebase-style onSnapshot)
orders.watchDoc("o-123", (doc) => render(doc)); // doc is null on delete
```

Turn on the **change feed** (`{ changefeed: true }`) for a durable, resumable, ordered stream —
and `watch()` then sees writes from **other processes** on the same file too:

```ts
const db = createDb("./app.db", { changefeed: true });
for await (const ev of db.changes("orders", { since: lastSeq })) {
  // { seq, collection, id, op: "upsert" | "delete", ts } — resumable by seq
}
```

Pair with `@monlite/sync` and your local database becomes a live replica of MongoDB or
PostgreSQL — **fully offline capable, syncs when reconnected**. See the
[realtime docs](https://qataruts.github.io/monlite/docs/core/realtime).

---

## A proper query language — not a toy

monlite has a Mongo/Prisma-style query API. Typed collections get compile-time checked
`where`/`orderBy` and return types that narrow with `select`.

```ts
interface Order {
  customerId: string;
  items: { sku: string; qty: number }[];
  status: "pending" | "shipped" | "returned";
  total: number;
}

const orders = db.collection<Order>("orders");

// elemMatch — query inside arrays of objects
await orders.findMany({
  where: { items: { elemMatch: { sku: "WIDGET-A", qty: { gte: 5 } } } },
});

// Regex — case-insensitive pattern matching
await orders.findMany({ where: { status: { regex: "^pend", mode: "insensitive" } } });

// Grouped aggregation — GROUP BY with sums/averages, HAVING, and top-N ordering
await orders.groupBy({
  by: ["customerId"],
  where: { status: "shipped" },
  _sum: { total: true },
  orderBy: { _sum: { total: "desc" } },
  take: 10,
});
// → [{ customerId: "c1", _sum: { total: 4200 } }, …]

// Atomic async transactions — await inside, all-or-nothing
await db.transactionAsync(async (tx) => {
  const account = await tx.findFirst({ where: { _id: "acc-1" } });
  if (account.balance < 100) throw new Error("insufficient funds");
  await tx.update({ where: { _id: "acc-1" }, data: { $inc: { balance: -100 } } });
  await tx.update({ where: { _id: "acc-2" }, data: { $inc: { balance: +100 } } });
});
```

---

## Hybrid search — keyword + semantic in one call

Get the best of both worlds: FTS5 keyword ranking fused with vector similarity via Reciprocal
Rank Fusion. One query, one ranked list.

```ts
import { fts } from "@monlite/fts";
import { vector, hybridSearch } from "@monlite/vector";

const db = createDb("./app.db", {
  allowExtensions: true,
  plugins: [
    fts({ docs: ["title", "body"] }),
    vector({ docs: { field: "embedding", dimensions: 384 } }),
  ],
});

const hits = await hybridSearch(db.collection("docs"), {
  text: "machine learning fundamentals",
  vector: await embed("machine learning fundamentals"),
  topK: 10,
  where: { published: true },
});
// Fused ranking — semantically similar AND keyword-relevant results, best first
```

---

## Python reads the same file

A monlite database is plain SQLite with documented conventions, so the Python port reads
and writes the same `.db`. Python ingests, Node serves — or any split you like.

```python
from monlite import create_db, kv

db = create_db("app.db")   # the exact same file your Node process uses
users = db.collection("users")
users.create({"name": "Ali", "age": 30, "tags": ["admin"]})
users.find_many(where={"tags": {"has": "admin"}})

kv(db).set("session:42", {"user": "ali"}, ttl=60_000)
```

One file. Two runtimes. Zero translation layer.

---

## Works everywhere SQLite runs

| Environment | How |
|---|---|
| Node 22.5+ | `@monlite/core` — uses built-in `node:sqlite`, **zero native build** |
| Node 18/20 | `@monlite/core` + `better-sqlite3` — auto-selected when present |
| Browser | `@monlite/wasm` — same API on SQLite-WASM (sql.js) |
| Electron | `@monlite/electron` — DB in main process, same API in renderer over IPC |
| Python | `pip install monlite` — same `.db` file, pure stdlib core |

---

## Outgrow local? The same code runs on Postgres

The collection API is engine-agnostic. Build against a local `.db` file; when you need a
networked, multi-writer backend, swap the engine — **not your code**:

```ts
// local / edge — SQLite, zero-dependency
import { createDb } from "@monlite/core";        const db = createDb("app.db");

// server / scale — Postgres, identical API
import { createDb } from "@monlite/postgres";     const db = createDb("postgres://…");
```

[`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres) runs the whole data surface
on Postgres (documents as JSONB): CRUD, the full query language, `aggregate`/`groupBy`, realtime
`watch()` over `LISTEN/NOTIFY` (truly cross-process), full-text search (`tsvector`) and vector
search (pgvector) — the **same** `@monlite/fts` and `@monlite/vector` plugins, the same
`search()` / `findSimilar()` calls. A ready-to-use [`monlite/postgres`](docker/postgres) Docker
image bundles Postgres + pgvector, preconfigured.

---

## Install

Two ways in. **Batteries-included** — the whole stack in one install (database + cache, queue,
cron, full-text + vector search, sync, realtime):

```bash
npm install monlite
```

```ts
import { createDb, kv, createQueue, fts, vector } from "monlite";
```

Or the **minimal, zero-dependency core** and add packages à la carte:

```bash
# Zero-dependency: uses Node's built-in node:sqlite (Node >= 22.5)
npm install @monlite/core

# For Node 18/20, or to avoid the experimental flag:
npm install @monlite/core better-sqlite3
```

Add packages as you need them:

```bash
npm install @monlite/vector    # semantic search
npm install @monlite/fts       # full-text search
npm install @monlite/kv        # cache, locks, pub/sub, sorted sets
npm install @monlite/queue     # durable job queue
npm install @monlite/cron      # scheduler (time zones, jitter)
npm install @monlite/sync      # cloud sync (MongoDB / PostgreSQL / MySQL)
npm install @monlite/postgres  # run the same API on a networked Postgres (JSONB)
npm install @monlite/realtime  # stream live queries to clients over SSE
npm install @monlite/wasm      # browser / SQLite-WASM
npm install @monlite/electron  # Electron: DB in main, shared to renderers over IPC
```

Plus a zero-install inspector: **`npx @monlite/studio app.db`** opens a local web UI to browse
collections, view documents, and run queries.

---

## Why not just use…

**SQLite directly?** You could — but you'd be writing the document layer, the query translator,
the FTS integration, the vector extension wiring, the change feed, the sync engine, and all the
TypeScript types yourself. monlite is that work, already done and tested.

**MongoDB + Redis + Qdrant?** For local / edge / desktop / single-machine work, you're paying
the operational cost of three separate services to solve one problem. monlite puts them all in
one file, with one API, and zero infrastructure.

**Firebase / Supabase?** Great for shared cloud state. Not so great when you need to work
offline, ship a CLI tool, build a desktop app, or keep data on-device. monlite is local-first;
[`@monlite/sync`](docs/docs/packages/sync.md) handles the cloud part when you need it.

---

## Documentation

Full guide at the [documentation site](https://qataruts.github.io/monlite):

- [Getting started](docs/docs/getting-started.md) · [Core API](docs/docs/core/documents.md)
- Packages: [vector](docs/docs/packages/vector.md) · [fts](docs/docs/packages/fts.md) · [kv](docs/docs/packages/kv.md) · [queue](docs/docs/packages/queue.md) · [cron](docs/docs/packages/cron.md) · [sync](docs/docs/packages/sync.md) · [wasm](docs/docs/packages/wasm.md)
- Guides: [AI-agent backend](docs/docs/guides/ai-agent-backend.md) · [production](docs/docs/guides/production.md) · [migrations](docs/docs/guides/migrations.md) · [custom sync adapters](docs/docs/guides/custom-adapter.md)
- Reference: [file format](docs/docs/reference/file-format.md) · [Python](docs/docs/reference/python.md) · [benchmarks](docs/docs/reference/benchmarks.md)

Runnable demos are in [`examples/`](examples/).

---

## Status

Production-ready and published. Current versions: `@monlite/core` **2.8.1**, `@monlite/sync`
**1.3.4**, `@monlite/realtime` **0.2.0**, `@monlite/vector` **0.5.6**, `@monlite/fts` **0.5.5**,
`@monlite/kv` **0.4.1**, `@monlite/queue` **0.5.0**, `@monlite/cron` **0.2.1**, `@monlite/wasm`
**0.2.2**, `@monlite/electron` **0.1.1**, `@monlite/studio` **0.1.1**, and the all-in-one
`monlite` **0.1.0**. The 2.x API is frozen.

Vector and full-text indexing are **linear at scale** — verified ingesting 100K documents
in ~0.8s and 50K vectors in ~8s (no O(n²) re-index), so it comfortably backs 10K–100K-document
RAG. The core bundles cleanly for the browser (no Node built-ins in the import graph).

The [live demo](https://qataruts.github.io/monlite/demo) showcases every package — documents,
full-text (FTS5), **vector/semantic search**, cache, queue, and cron — running 100% in the
browser on SQLite-WASM, with semantic embeddings computed on-device via Transformers.js.

The **Python port** — [`pip install monlite`](https://pypi.org/project/monlite/) — is at feature
parity: documents (with transactions, aggregation, and the change feed), kv (cache, locks, pub/sub,
sorted sets), the durable queue, cron, FTS5, and vector / semantic search (`monlite[vector]`) — all
reading and writing the **same `.db`** as the Node packages. A cross-runtime interop suite
round-trips a file between the two. Pure standard library, Python 3.9+. So **Python ingests/embeds
while Node serves**, over one file.

## License

MIT
