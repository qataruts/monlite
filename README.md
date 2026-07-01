# monlite

> ### The complete backend for AI agents — in one file.
> Document **memory**, semantic (**vector**) recall, full-text search, a durable **task queue**,
> atomic **locks**, cache, and **cron** — over a single SQLite file, with a zero-dependency
> TypeScript core. **No Docker. No connection strings. Nothing to run.**
> And the *same code* scales to Postgres the day you need it.

A coding agent, RAG pipeline, or autonomous worker needs memory, semantic search, a job queue, and
locks. That's normally MongoDB + Qdrant + Redis + BullMQ — four services and a Docker compose file.
**monlite is all of it, in a file you can `cp` to back up:**

```ts
import { createDb } from "@monlite/core";
import { vector } from "@monlite/vector";
import { createQueue } from "@monlite/queue";
import { kv } from "@monlite/kv";

// one file = the agent's entire backend
const db = createDb("./agent.db", {
  allowExtensions: true,
  plugins: [vector({ memory: { field: "embedding", dimensions: 384 } })],
});

// 🧠 memory — typed document collections
await db.collection("memory").create({ data: { note: "user prefers dark mode", embedding } });

// 🔎 semantic recall — vector search over embeddings
const recall = await db.collection("memory").findSimilar({ vector: query, topK: 5 });

// 🔒 an atomic lock (run-once)  +  📋 a durable task queue (retries, backoff, dedupe, concurrency)
if (kv(db).setNX("lock:ingest", 1, { ttl: 30_000 })) startIngest();
createQueue(db).process("embed", (job) => embed(job.payload.text), { concurrency: 4 });
```

Exactly-once job claims, locks, scheduling, and full-text + semantic search — with **no server, no
migrations, and no native build** (Node 22.5+ uses the built-in `node:sqlite`).

📖 [Docs](https://qataruts.github.io/monlite) · 🎮 [Live demo](https://qataruts.github.io/monlite/demo) (runs in your browser) · 📦 [npm](https://www.npmjs.com/package/monlite) · 💻 [GitHub](https://github.com/qataruts/monlite)

---

## One file replaces the whole local stack

Most apps, CLIs, and AI agents wire up the same services. monlite gives you each one as a small
package over a single `.db` file — install only what you use, the core stays zero-dependency:

| Instead of | Use | Gives you |
|---|---|---|
| MongoDB / Mongoose | [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) | document collections, a typed query language, transactions, reactive `watch()` |
| Elasticsearch / Typesense | [`@monlite/fts`](https://www.npmjs.com/package/@monlite/fts) | full-text search — `collection.search()` |
| Qdrant / Pinecone | [`@monlite/vector`](https://www.npmjs.com/package/@monlite/vector) | vector / semantic search, `findSimilar()`, hybrid RAG |
| Redis (cache) | [`@monlite/kv`](https://www.npmjs.com/package/@monlite/kv) | cache, atomic locks, TTLs, pub/sub, sorted sets |
| BullMQ + Redis | [`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue) | durable job queue — retries, backoff, dedupe, concurrency |
| A cron server | [`@monlite/cron`](https://www.npmjs.com/package/@monlite/cron) | persisted scheduled jobs (time zones, jitter) |
| Firebase / Pusher | [`@monlite/realtime`](https://www.npmjs.com/package/@monlite/realtime) | stream live queries & docs to clients over SSE |
| MongoDB Atlas sync | [`@monlite/sync`](https://www.npmjs.com/package/@monlite/sync) | local-first replication to MongoDB / PostgreSQL / MySQL |
| A managed Postgres | [`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres) | **the same API on a networked Postgres** when you outgrow one file |

No Docker. No `.env` full of connection strings. One file, one API, `node serve.mjs`.

---

## Install

**Batteries-included** — the whole stack in one package:

```bash
npm install monlite
```

```ts
import { createDb, kv, createQueue, createCron, fts, vector } from "monlite";
```

Or the **minimal, zero-dependency core**, plus packages à la carte:

```bash
npm install @monlite/core                 # zero-dep core (Node ≥ 22.5, built-in node:sqlite)
npm install @monlite/core better-sqlite3  # Node 18/20, or to skip the experimental flag

npm install @monlite/fts        # full-text search          @monlite/vector   # semantic search
npm install @monlite/kv         # cache, locks, pub/sub      @monlite/queue    # durable job queue
npm install @monlite/cron       # scheduler                  @monlite/realtime # live queries over SSE
npm install @monlite/postgres   # run the same API on Postgres
npm install @monlite/sync       # cloud sync (MongoDB / PostgreSQL / MySQL)
npm install @monlite/wasm       # browser / SQLite-WASM      @monlite/electron # Electron main↔renderer
```

Zero-install inspector: **`npx @monlite/studio app.db`** opens a local web UI to browse
collections, view documents, and run queries.

---

## A real query language — typed, not a toy

A Mongo/Prisma-style API. Typed collections get compile-time-checked `where`/`orderBy`, and return
types that narrow with `select`.

```ts
interface Order {
  customerId: string;
  items: { sku: string; qty: number }[];
  status: "pending" | "shipped" | "returned";
  total: number;
}
const orders = db.collection<Order>("orders");

// query inside arrays of objects
await orders.findMany({ where: { items: { elemMatch: { sku: "WIDGET", qty: { gte: 5 } } } } });

// case-insensitive regex
await orders.findMany({ where: { status: { regex: "^pend", mode: "insensitive" } } });

// grouped aggregation — GROUP BY with sums, HAVING, top-N
await orders.groupBy({
  by: ["customerId"],
  where: { status: "shipped" },
  _sum: { total: true },
  orderBy: { _sum: { total: "desc" } },
  take: 10,
});

// atomic transactions — await inside, all-or-nothing
await db.transactionAsync(async (tx) => {
  const accounts = tx.collection("accounts");
  await accounts.update({ where: { _id: "acc-1" }, data: { $inc: { balance: -100 } } });
  await accounts.update({ where: { _id: "acc-2" }, data: { $inc: { balance: +100 } } });
});

// cross-process compare-and-swap — exactly-once job claim
const claimed = await orders.findOneAndUpdate({
  where: { status: "pending" },
  data: { $set: { status: "active" } },
  returnDocument: "after",
}); // N workers race; exactly one wins, the rest get null
```

Full surface: `create`/`createMany`, `findMany`/`findFirst`/`findById`, `update`/`updateMany`,
`upsert`, `delete`/`deleteMany`, `count`/`exists`/`distinct`, `aggregate`/`groupBy`, `bulkWrite`,
`findOneAndUpdate`, TTL collections, `explain()`, and structured (columnar) collections.

---

## Real-time reactivity — a local Firebase

`collection.watch()` returns a live result set that re-emits only when a *relevant* change lands
(row-level matching — no spurious re-renders), with `added`/`removed`/`changed`/`moved` deltas.

```ts
// initial snapshot, then re-fires only when an admin is added/changed/removed
users.watch({ where: { roles: { has: "admin" } } }, ({ results, added, removed }) =>
  renderAdminList(results),
);

// single-document listener (Firebase-style onSnapshot) — doc is null on delete
orders.watchDoc("o-123", (doc) => render(doc));
```

Enable the **change feed** (`{ changefeed: true }`) for a durable, resumable, ordered stream — and
`watch()` then also sees writes from **other processes** on the same file:

```ts
for await (const ev of db.changes("orders", { since: lastSeq })) {
  // { seq, collection, id, op: "upsert" | "delete", ts } — resumable by seq
}
```

---

## Search — full-text, vector, and hybrid

Add the plugins, point them at fields, and they index automatically on every write. Keyword
ranking and vector similarity fuse into one ranked list via Reciprocal Rank Fusion.

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

await db.collection("docs").search("brown fox");                 // keyword (FTS5)
await db.collection("docs").findSimilar({ vector: emb, topK: 5 }); // semantic (sqlite-vec)

const hits = await hybridSearch(db.collection("docs"), {          // both, fused
  text: "machine learning", vector: await embed("machine learning"),
  topK: 10, where: { published: true },
});
```

Indexing is **linear at scale** — verified ingesting 100K documents in ~0.8s and 50K vectors in
~8s (no O(n²) re-index), comfortably backing a 10K–100K-document RAG corpus.

---

## Cache, queue, and cron — the operational trio

```ts
import { kv } from "@monlite/kv";
import { createQueue } from "@monlite/queue";
import { createCron } from "@monlite/cron";

// Redis-like cache: get/set with TTL, atomic locks, counters, sorted sets, pub/sub
const cache = kv(db);
cache.set("session:42", { user: "ali" }, { ttl: 60_000 });
if (cache.setNX("lock:job:42", 1, { ttl: 30_000 })) runOnce(); // atomic lock

// durable job queue: retries, backoff, dedupe, concurrency, rate limits
const queue = createQueue(db, { maxAttempts: 3 });
queue.process("embed", async (job) => embed(job.payload.text), { concurrency: 4 });

// persisted scheduler: 5-field cron, time zones, jitter, multi-process safe
const cron = createCron(db);
cron.schedule("nightly", "0 3 * * *", () => queue.add("cleanup", {}));
```

The full [AI-agent-backend walkthrough](https://qataruts.github.io/monlite/guides/ai-agent-backend)
puts these together with memory + semantic recall into one runtime.

---

## Outgrow one file? The same code runs on Postgres

The collection API is engine-agnostic. Develop against a local `.db`; when you need a networked,
multi-writer backend, **swap the engine, not your app**:

```ts
import { createDb } from "@monlite/core";        const db = createDb("app.db");      // local
import { createDb } from "@monlite/postgres";    const db = createDb("postgres://…"); // server
```

[`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres) runs the **entire** surface
on Postgres (documents as JSONB): all CRUD, the full query language, `aggregate`/`groupBy`,
`explain()`, realtime `watch()` over `LISTEN/NOTIFY` (truly cross-process), full-text search
(`tsvector`), vector search (pgvector), the job queue (`SKIP LOCKED`), cache, and cron — the *same*
plugins and the same calls. A ready-to-run [`monlite/postgres`](https://hub.docker.com/r/monlite/postgres)
Docker image bundles Postgres 16 + pgvector, preconfigured.

---

## Runs everywhere SQLite runs

| Environment | How |
|---|---|
| Node 22.5+ | `@monlite/core` — built-in `node:sqlite`, **zero native build** |
| Node 18/20 | `@monlite/core` + `better-sqlite3` (auto-selected when present) |
| Browser | `@monlite/wasm` — same API on SQLite-WASM |
| Electron | `@monlite/electron` — DB in main, same API in renderers over IPC |
| Python | `pip install monlite` — the **same `.db` file**, pure stdlib |

The **Python port** is at feature parity — documents (transactions, aggregation, change feed), kv,
queue, cron, FTS5, and vector search — reading and writing the same file as the Node packages, with
a cross-runtime interop suite round-tripping a database between them. So **Python ingests/embeds
while Node serves**, over one file.

```python
from monlite import create_db, kv
db = create_db("app.db")                       # the same file your Node process uses
db.collection("users").find_many(where={"tags": {"has": "admin"}})
kv(db).set("session:42", {"user": "ali"}, ttl=60_000)
```

---

## Why monlite

- **vs. raw SQLite** — you'd hand-write the document layer, query translator, FTS/vector wiring,
  change feed, sync engine, and all the types. monlite is that work, done and tested.
- **vs. MongoDB + Redis + Qdrant** — for local / edge / desktop / single-machine work you'd run
  three services to solve one problem. monlite is one file, one API, zero infrastructure — and
  scales to Postgres with the same code when you genuinely need a server.
- **vs. Firebase / Supabase** — great for shared cloud state, awkward when you need to work offline,
  ship a CLI, or keep data on-device. monlite is local-first; `@monlite/sync` adds the cloud when
  you want it.

---

## Documentation

Full guide at **[qataruts.github.io/monlite](https://qataruts.github.io/monlite)**:

- **Getting started** · **Core** — [documents](https://qataruts.github.io/monlite/core/documents) · [queries](https://qataruts.github.io/monlite/core/queries) · [aggregation](https://qataruts.github.io/monlite/core/aggregation) · [realtime](https://qataruts.github.io/monlite/core/realtime) · [transactions](https://qataruts.github.io/monlite/core/transactions)
- **Packages** — [postgres](https://qataruts.github.io/monlite/packages/postgres) · [fts](https://qataruts.github.io/monlite/packages/fts) · [vector](https://qataruts.github.io/monlite/packages/vector) · [kv](https://qataruts.github.io/monlite/packages/kv) · [queue](https://qataruts.github.io/monlite/packages/queue) · [cron](https://qataruts.github.io/monlite/packages/cron) · [sync](https://qataruts.github.io/monlite/packages/sync)
- **Guides** — [AI-agent backend](https://qataruts.github.io/monlite/guides/ai-agent-backend) · [production](https://qataruts.github.io/monlite/guides/production) · [migrations](https://qataruts.github.io/monlite/guides/migrations)
- **Reference** — [file format](https://qataruts.github.io/monlite/reference/file-format) · [Python](https://qataruts.github.io/monlite/reference/python) · [benchmarks](https://qataruts.github.io/monlite/reference/benchmarks)

Runnable demos in [`examples/`](examples/). The [live demo](https://qataruts.github.io/monlite/demo)
runs every package — documents, FTS5, vector search, cache, queue, cron — 100% in the browser on
SQLite-WASM, with embeddings computed on-device via Transformers.js.

## Status

Production-ready and published; the 2.x core API is frozen. The **Postgres engine**
([`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)) runs the entire surface —
documents, queries, aggregation, realtime, full-text, vector, queue, kv, and cron — verified
against live Postgres. See each package on npm for its current version and changelog.

## License

MIT
