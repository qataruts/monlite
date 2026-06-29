---
id: monlite
title: "monlite (all-in-one)"
---

# monlite — the whole stack in one install

`monlite` is the batteries-included bundle: an embedded SQLite document database plus cache,
queue, cron, full-text + vector search, sync, and realtime — one `.db` file that replaces MongoDB,
Redis, Qdrant, BullMQ, a cron server, and a realtime gateway.

```bash
npm install monlite
# Node ≥ 22.5 runs zero-dependency on the built-in node:sqlite.
# Node 18/20 (or to skip the experimental flag): npm install monlite better-sqlite3
```

```ts
import { createDb, kv, createQueue, createCron, fts, vector } from "monlite";

const db = createDb("app.db");

const cache = kv(db); // cache, locks, pub/sub, sorted sets
const queue = createQueue(db); // durable jobs
const cron = createCron(db); // scheduled jobs
const search = fts(db, "notes", { fields: ["title", "body"] }); // full-text
const vec = vector(db, "notes", { dims: 1536 }); // semantic / RAG memory
```

Every export is the **same object** as the standalone `@monlite/*` package — a thin re-export
barrel with no logic of its own. `@monlite/core` stays the minimal **zero-dependency** install when
you want only the database; `monlite` is the convenience "install one thing, get the whole stack."

## What's included

| Top-level + subpath | What |
|---|---|
| `monlite` (core) | documents, typed queries, aggregation, transactions, reactive `watch()` |
| [`monlite/kv`](/packages/kv) | cache, atomic locks, TTLs, pub/sub, sorted sets |
| [`monlite/queue`](/packages/queue) | durable job queue — retries, backoff, delays, dedupe |
| [`monlite/cron`](/packages/cron) | persisted scheduled jobs — time zones, jitter |
| [`monlite/fts`](/packages/fts) | full-text search (SQLite FTS5) |
| [`monlite/vector`](/packages/vector) | vector / semantic search (sqlite-vec, with a JS fallback) |
| [`monlite/sync`](/packages/sync) | local-first replication to MongoDB / PostgreSQL / MySQL |
| [`monlite/realtime`](/packages/realtime) | stream live queries over SSE (`monlite/realtime/client` for the browser) |

Each subpath exposes that package's full type surface and is independently tree-shakeable.

## Optional / separate

- **`monlite/wasm`** — run in the browser on SQLite-WASM. Optional peer: `npm install @monlite/wasm`.
- **Electron** — [`@monlite/electron`](/packages/electron) is a separate install; not bundled here.
- **Studio** — the inspector is a zero-install CLI: `npx @monlite/studio app.db`
  ([docs](/packages/studio)).
