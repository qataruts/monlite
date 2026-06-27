---
id: intro
title: monlite
slug: /
sidebar_label: What is monlite
---

# monlite 🌙

**The local-first database for TypeScript** — documents, vectors, full-text search,
cache, queue, and cron in **one `.db` file**, with a **zero-dependency core**.

monlite is SQLite with a Mongo/Prisma-style API and an opt-in family of packages
that cover the rest of a local backend. It runs in Node, the browser (WASM), the
desktop (Electron), and the edge — anywhere SQLite goes.

```ts
import { createDb } from "@monlite/core";

const db = createDb("app.db");
const users = db.collection<{ name: string; age: number }>("users");

await users.create({ data: { name: "Ali", age: 30 } });
const adults = await users.findMany({ where: { age: { gte: 18 } }, orderBy: { age: "asc" } });
```

## The family

The core is lean and dependency-free. Each capability is an **opt-in package** —
install only what you need. (kv, queue, cron, sync each expose a programmatic
factory; fts and vector ship both a plugin **and** a dynamic store.)

| Package | Replaces | What it gives you |
|---|---|---|
| [`@monlite/core`](/core/documents) | MongoDB (documents) | Document + structured collections, one query API, aggregation, transactions, auto-indexing |
| [`@monlite/sync`](/packages/sync) | cloud sync | Local-first replication to MongoDB / PostgreSQL / MySQL / monlite, LWW + custom conflict resolution |
| [`@monlite/fts`](/packages/fts) | search | Full-text search (SQLite FTS5) — plugin **+** `createSearchIndex(db)` |
| [`@monlite/vector`](/packages/vector) | Qdrant / Pinecone | Vector / semantic search (sqlite-vec) — plugin **+** `createVectorStore(db)` |
| [`@monlite/kv`](/packages/kv) | Redis (cache) | Synchronous cache + locks with TTL |
| [`@monlite/queue`](/packages/queue) | BullMQ / Redis | Durable job queue — retries, backoff, delays, priorities, dedupe |
| [`@monlite/cron`](/packages/cron) | Redis / cron | Persisted scheduled jobs |
| [`@monlite/wasm`](/packages/wasm) | — | Run monlite in the **browser** on SQLite-WASM |

## Why monlite

- **One file.** All of it — documents, vectors, cache, queue, cron — lives in a
  single SQLite file. Backup = copy the file.
- **Zero-dependency core.** `@monlite/core` runs on Node's built-in `node:sqlite`
  (Node ≥ 22.5) with no native build, or on `better-sqlite3` when you install it.
- **The local backend for AI agents.** Documents + vectors + cache + queue + cron
  is the whole local stack a coding agent or RAG app needs — see the
  [AI-agent backend guide](/guides/ai-agent-backend).
- **Production-hardened.** Atomic async transactions, compare-and-swap, crash-tested
  durability, observability, and cross-platform CI (Linux/macOS/Windows). See the
  [production guide](/guides/production).
- **Boundary:** monlite targets **local / edge / desktop / single-machine**. For
  multi-site, high-write-volume, or strict-HA, keep the managed services and
  [sync](/packages/sync) to them.

Next: [Getting started →](/getting-started)
