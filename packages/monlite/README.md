# monlite

**The whole [monlite](https://github.com/qataruts/monlite) stack in one install.** An embedded
SQLite document database plus cache, queue, cron, full-text + vector search, sync, and realtime —
one `.db` file that replaces MongoDB, Redis, Qdrant, BullMQ, a cron server, and a realtime gateway.

```bash
npm install monlite
# Node ≥ 22.5 runs zero-dependency on the built-in node:sqlite.
# For Node 18/20 (or to skip the experimental flag): npm install monlite better-sqlite3
```

```ts
import { createDb, kv, createQueue, createCron, fts, vector } from "monlite";

const db = createDb("app.db");

await db.collection("notes").create({ data: { title: "hello", body: "world" } });

const cache = kv(db); // cache, locks, pub/sub, sorted sets
const queue = createQueue(db, "emails"); // durable jobs
const cron = createCron(db); // scheduled jobs
const search = fts(db, "notes", { fields: ["title", "body"] }); // full-text
const vec = vector(db, "notes", { dims: 1536 }); // semantic / RAG memory
```

Every export is the **same object** as the standalone `@monlite/*` package — this is a thin
re-export barrel with no logic of its own. Prefer it for a fast "install one thing, get the whole
stack" start; `@monlite/core` remains the minimal **zero-dependency** install when you want only
the database.

## What's included

`npm install monlite` pulls the pure-JS suite:

| Top-level + subpath | Replaces | What |
|---|---|---|
| `monlite` (core) | MongoDB | documents, typed queries, aggregation, transactions, reactive `watch()` |
| `monlite/kv` | Redis | cache, atomic locks, TTLs, pub/sub, sorted sets |
| `monlite/queue` | BullMQ | durable job queue — retries, backoff, delays, dedupe |
| `monlite/cron` | cron server | persisted scheduled jobs — time zones, jitter |
| `monlite/fts` | Elasticsearch | full-text search (SQLite FTS5) |
| `monlite/vector` | Qdrant / Pinecone | vector / semantic search (sqlite-vec, with a JS fallback) |
| `monlite/sync` | MongoDB Atlas sync | local-first replication to MongoDB / PostgreSQL / MySQL |
| `monlite/realtime` | Firebase / Pusher | stream live queries to clients over SSE (`monlite/realtime/client` for the browser) |

Each subpath exposes that package's full type surface and is independently tree-shakeable.

## Optional / separate

- **`monlite/wasm`** — run in the browser on SQLite-WASM. Optional peer: `npm install @monlite/wasm`.
- **Electron** — `@monlite/electron` (main/renderer over IPC) is a separate install; it isn't
  bundled here.
- **Studio** — the local inspector is a zero-install CLI: `npx @monlite/studio app.db`.

## License

MIT
