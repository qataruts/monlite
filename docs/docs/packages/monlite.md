---
id: monlite
title: "monlite (all-in-one)"
---

# monlite — the whole stack in one install

`monlite` is the batteries-included bundle: an embedded SQLite document database
plus cache, queue, cron, full-text + vector search, sync, and realtime — one
`.db` file that replaces MongoDB, Redis, Qdrant, BullMQ, a cron server, and a
realtime gateway. One install instead of eight.

```bash
npm install monlite
# Node ≥ 22.5 runs zero-dependency on the built-in node:sqlite.
# Node 18/20 (or to skip the experimental flag): npm install monlite better-sqlite3
```

```ts
import { createDb, kv, createQueue, createCron, fts, vector } from "monlite";

// Search plugins are registered when the db is opened (they index on write).
const db = createDb("app.db", {
  allowExtensions: true,
  plugins: [
    fts({ docs: ["title", "body"] }),
    vector({ docs: { field: "embedding", dimensions: 384 } }),
  ],
});

const cache = kv(db);          // cache, atomic locks, TTLs, pub/sub, sorted sets
const queue = createQueue(db); // durable job queue
const cron = createCron(db);   // persisted scheduler

await db.collection("docs").create({ data: { title: "Hello", body: "world" } });
await db.collection("docs").search("hello");                    // full-text
await db.collection("docs").findSimilar({ vector: emb, topK: 5 }); // semantic
```

Every export is the **same object** as the standalone `@monlite/*` package — this
is a thin re-export barrel with no logic of its own. `@monlite/core` stays the
minimal **zero-dependency** install when you want only the database; `monlite` is
the convenience "install one thing, get the whole stack."

## What it re-exports

The top-level entry point re-exports the full `@monlite/core` surface (`createDb`,
`Collection`, all types) plus the factories and types from each companion package:

| From | Top-level exports |
|---|---|
| `@monlite/core` | everything — `createDb`, `Monlite`, `Collection`, query/types, … |
| [`@monlite/kv`](/packages/kv) | `kv`, `pgKv`, types `KV` / `PgKV` / `KVOptions` |
| [`@monlite/queue`](/packages/queue) | `createQueue`, `Queue`, `createPgQueue`, `PgQueue`, + types |
| [`@monlite/cron`](/packages/cron) | `createCron`, `Cron`, `createPgCron`, `PgCron`, `parseCron`, `nextCronRun`, + types |
| [`@monlite/fts`](/packages/fts) | `fts`, `createSearchIndex`, + types |
| [`@monlite/vector`](/packages/vector) | `vector`, `createVectorStore`, `hybridSearch`, + types |
| [`@monlite/sync`](/packages/sync) | `sync`, `SyncEngine`, the adapters, + types |
| [`@monlite/realtime`](/packages/realtime) | `realtime` (server) + types |

Note the **Postgres-engine helpers** are re-exported at the top level too —
`pgKv` / `PgKV`, `createPgQueue` / `PgQueue`, and `createPgCron` / `PgCron`. These
are the same cache / queue / cron APIs implemented on the
[`@monlite/postgres`](/packages/postgres) engine, so the operational trio runs on
a networked Postgres with the same calls:

```ts
import { createDb } from "@monlite/postgres";
import { pgKv, createPgQueue, createPgCron } from "monlite";

const db = createDb("postgres://localhost/app");
const cache = pgKv(db);
const queue = createPgQueue(db);
const cron = createPgCron(db);
```

## Subpath imports

Each companion package is also a subpath of `monlite`, so you can import
selectively (and reach a package's **full** type surface — e.g. the `fts` and
`vector` maintenance helpers that share names and so can't both sit at the top
level):

```ts
import { kv } from "monlite/kv";
import { createQueue } from "monlite/queue";
import { createCron } from "monlite/cron";
import { fts, createSearchIndex } from "monlite/fts";
import { vector, hybridSearch } from "monlite/vector";
import { sync, MongoAdapter } from "monlite/sync";
import { realtime } from "monlite/realtime";
import { connectRealtime } from "monlite/realtime/client";
```

| Subpath | Package |
|---|---|
| `monlite` (root) | core + all factories above |
| [`monlite/kv`](/packages/kv) | cache, atomic locks, TTLs, pub/sub, sorted sets |
| [`monlite/queue`](/packages/queue) | durable job queue — retries, backoff, delays, dedupe |
| [`monlite/cron`](/packages/cron) | persisted scheduled jobs — time zones, jitter |
| [`monlite/fts`](/packages/fts) | full-text search (SQLite FTS5) |
| [`monlite/vector`](/packages/vector) | vector / semantic search (sqlite-vec, with a JS fallback) |
| [`monlite/sync`](/packages/sync) | local-first replication to MongoDB / PostgreSQL / MySQL |
| [`monlite/realtime`](/packages/realtime) | realtime server over SSE |
| `monlite/realtime/client` | the browser/Node realtime **client** |
| `monlite/wasm` | browser SQLite-WASM driver (optional peer — see below) |

Each subpath is independently tree-shakeable.

## Optional / separate

- **`monlite/wasm`** — run in the browser on SQLite-WASM. It's an **optional
  peer**: `npm install @monlite/wasm`. See [`@monlite/wasm`](/packages/wasm).
- **Electron** — [`@monlite/electron`](/packages/electron) is a separate install;
  it is **not** bundled in the barrel.
- **Studio** — the inspector is a zero-install CLI, `npx @monlite/studio app.db`;
  not a barrel export. See [`@monlite/studio`](/packages/studio).

## Barrel vs. à la carte

Use **`monlite`** when you want the whole stack with one dependency and don't mind
pulling the companion packages in transitively — apps, prototypes, AI-agent
backends, anything that uses several capabilities.

Use **`@monlite/core` plus individual `@monlite/*` packages** when you want the
**zero-dependency** core and only the pieces you actually use (a library, a CLI,
a size-sensitive build). Because every barrel export is the identical object from
the standalone package, you can move between the two at any time without changing
a single call.
