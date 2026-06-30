---
id: intro
title: monlite
slug: /
sidebar_label: What is monlite
---

# monlite

**The local-first backend for TypeScript** — documents, full-text + vector search, cache, queue,
and cron in **one `.db` file**, with a **zero-dependency core** — and the *same API* on a networked
**Postgres** when you scale.

monlite is SQLite with a Mongo/Prisma-style API and an opt-in family of packages that cover the
rest of a backend. It runs in Node, the browser (WASM), the desktop (Electron), the edge, and
Python — anywhere SQLite runs — and the identical collection code runs on Postgres when you outgrow
one file.

```ts
import { createDb } from "@monlite/core";

const db = createDb("app.db");
const users = db.collection<{ name: string; age: number }>("users");

await users.create({ data: { name: "Ali", age: 30 } });
const adults = await users.findMany({ where: { age: { gte: 18 } }, orderBy: { age: "asc" } });
```

## The package family

The core is lean and dependency-free. Each additional capability is an **opt-in package** —
install only what you need. Or grab them all at once with the
[all-in-one **`monlite`**](/packages/monlite) bundle (`npm install monlite`).

| Package | Replaces | What it gives you |
|---|---|---|
| [`@monlite/core`](/core/documents) | MongoDB (documents) | Document + structured collections, one query API, aggregation, transactions, reactive `watch()` |
| [`@monlite/postgres`](/packages/postgres) | A managed Postgres | **The same API on a networked Postgres** (JSONB) — swap the engine, not your code |
| [`@monlite/fts`](/packages/fts) | Search engines | Full-text search (SQLite FTS5 / Postgres tsvector) — plugin + `createSearchIndex(db)` |
| [`@monlite/vector`](/packages/vector) | Qdrant / Pinecone | Vector / semantic search (sqlite-vec / pgvector) — plugin + `createVectorStore(db)` |
| [`@monlite/kv`](/packages/kv) | Redis | Cache, atomic locks, TTLs, pub/sub, sorted sets |
| [`@monlite/queue`](/packages/queue) | BullMQ / Redis | Durable job queue — retries, backoff, delays, priorities, dedupe |
| [`@monlite/cron`](/packages/cron) | Cron servers | Persisted scheduled jobs — 5-field syntax, time zones, jitter |
| [`@monlite/realtime`](/packages/realtime) | Firebase / Pusher | Stream live queries & documents to remote clients over SSE |
| [`@monlite/sync`](/packages/sync) | Cloud sync | Local-first replication to MongoDB / PostgreSQL / MySQL |
| [`@monlite/wasm`](/packages/wasm) | — | Run monlite in the **browser** on SQLite-WASM |
| [`@monlite/electron`](/packages/electron) | — | Share one database across Electron windows over IPC |
| [`@monlite/studio`](/packages/studio) | — | Local web inspector — `npx @monlite/studio app.db` |

## Two engines, one API

monlite has a **swappable engine** behind a single collection API:

- **SQLite** (`@monlite/core`) — local-first, zero-dependency, one file. Perfect for CLIs, desktop
  apps, edge, AI agents, and embedding in another product.
- **Postgres** ([`@monlite/postgres`](/packages/postgres)) — a networked, multi-writer backend for
  when you scale. Documents become JSONB; everything else is identical, down to `findSimilar()` and
  `search()`.

```ts
import { createDb } from "@monlite/core";        const db = createDb("app.db");      // local
import { createDb } from "@monlite/postgres";     const db = createDb("postgres://…"); // server
```

You develop against a file and deploy to Postgres without rewriting a line — see the
[Postgres engine guide](/packages/postgres).

## Why monlite

- **One file.** Documents, search, vectors, cache, queue, cron — all in a single SQLite file.
  Backup = copy the file.
- **Zero-dependency core.** `@monlite/core` uses Node's built-in `node:sqlite` (Node ≥ 22.5) with
  no native build, or `better-sqlite3` when you install it.
- **The local backend for AI agents.** Documents + vectors + cache + queue + cron is the complete
  local stack a coding agent or RAG app needs — see the
  [AI-agent backend guide](/guides/ai-agent-backend).
- **Production-hardened.** Atomic async transactions, cross-process compare-and-swap, crash-tested
  durability, observability, and cross-platform CI. See the [production guide](/guides/production).
- **Scales when you need it.** Start on a file; move to Postgres with the same code, or
  [sync](/packages/sync) the file to a cloud database — without rewriting your app.

Next: [Getting started →](/getting-started)
