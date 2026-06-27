# 🌙 monlite Roadmap

Where monlite is heading. monlite is a local-first database for TypeScript:
one query API, document **and** native-column storage, optional sync. The goal
is to be the **batteries-included local-first layer** for desktop, CLI, and
AI-native TS apps — keeping `@monlite/core` lean and zero-dependency, with
heavier capabilities as opt-in packages.

## Vision — the local backend for AI agents

Collapse the whole local data layer into **one embedded `.db` file, one install**:
documents (replacing Mongo), vectors (Qdrant), and Redis's local roles — cache,
queue, and cron — then sync to the cloud when you want. Each is just structured
tables + access patterns over SQLite, which is fast, durable, and transactional.

| Cloud service | monlite |
|---|---|
| MongoDB | `@monlite/core` (documents) ✅ |
| Qdrant | `@monlite/vector` ✅ |
| Redis (cache) | `@monlite/kv` ✅ |
| Redis / BullMQ (queue) | `@monlite/queue` ✅ |
| Redis / cron (scheduling) | `@monlite/cron` ✅ |
| cloud sync | `@monlite/sync` ✅ |

Boundary: this targets **local / edge / desktop / single-machine** runtimes, not
distributed cloud-scale Redis/Mongo/Qdrant. For scale, keep the real services and
sync to them.

## Shipped

- **`@monlite/core`** — document + structured (native-column) collections, one
  Mongo/Prisma-style query API, aggregation (`groupBy`/`having`/`distinct`),
  auto-indexing, raw-SQL escape hatch, dual driver (`better-sqlite3` +
  zero-dep built-in `node:sqlite`), typed errors, prepared-statement cache.
- **`@monlite/sync`** — local-first replication (pull / push / two-way / live),
  LWW + custom conflict resolution, change feed + tombstones, and adapters for
  **MongoDB** (live replica set, incl. change streams), **PostgreSQL** and
  **MySQL/MariaDB** (json tables, live-tested), monlite-to-monlite, and
  in-memory. Document **and** structured collections sync. **Resilient rounds**:
  per-operation retry with backoff + no partial-failure data loss (1.3.0).
- **Wave 1** — `collection.watch()` reactivity (row-level), auto-additive
  migrations, `collection.explain()`, and `db.backup()`.
- **Plugin system** — `createDb({ plugins })` with `init`/`afterWrite`/
  `collectionMethods` hooks.
- **`@monlite/fts`** — full-text search (SQLite FTS5) via `collection.search()`.
- **`@monlite/vector`** — local vector / semantic search (sqlite-vec) via
  `collection.findSimilar()`, plus **`hybridSearch()`** (FTS + vector fused with
  Reciprocal Rank Fusion) for RAG and AI-agent memory.
- **Semver-stable** — `@monlite/core` (now `2.x`) and `@monlite/sync` follow
  semantic versioning; companion packages depend on `@monlite/core ^2.0.0`.
- **Production hardening (2.1–2.4)** — `transactionAsync` (atomic async
  unit-of-work, serialized), `findOneAndUpdate` (incl. CAS) · `bulkWrite` ·
  `$addToSet`, durability (`checkIntegrity`/`vacuum`/`analyze`/`checkpoint`/
  `synchronous`), persisted auto-index, observability (`db.stats`/`onQuery`),
  compound unique indexes, collection TTL (`purgeExpired`), and a systems test
  program (property-based + large-dataset). See
  [`docs/guides/production.md`](./guides/production.md).
- **Agent-backend primitives** — `@monlite/kv` `setNX` (locks), `@monlite/queue`
  dedupe-by-jobId, and **cross-process index freshness** (`collection.catchUp()`
  on `@monlite/fts`/`@monlite/vector`) for multi-process ingest → search.
- **Examples, benchmarks & guides** — runnable demos in [`examples/`](../examples/)
  (CRUD/FTS, vector/hybrid, sync, the kv/queue/cron harness, `$lookup` joins, the
  WASM backend), a benchmark suite ([`docs/BENCHMARKS.md`](./BENCHMARKS.md)), and
  [guides](./guides/) for migrations and custom adapters/drivers.
- **The local AI-agent harness** — Redis's local roles as companion packages:
  **`@monlite/kv`** (cache/KV with TTL), **`@monlite/queue`** (durable job queue —
  retries, backoff, delays, priorities, concurrency, dead-letter, multi-process
  safe), and **`@monlite/cron`** (persisted cron schedules). Both drivers.
- **Encryption at rest** — the `encryption` option (`createDb(path, { encryption:
  { key } })`) backed by `better-sqlite3-multiple-ciphers`, plus `db.rekey()`.
- **Browser / WASM** — `@monlite/wasm` runs monlite in the browser on SQLite-WASM
  (sql.js) via a custom `Driver`; snapshot persistence to IndexedDB/OPFS today.
- **On-disk format spec** — [`docs/FORMAT.md`](./FORMAT.md): monlite files are
  plain SQLite + documented conventions, so any language can read/write them.
- **Electron** — `@monlite/electron`: a main-process database shared with
  renderer windows over IPC, with cross-window reactivity.
- **Studio** — `@monlite/studio`: a local web inspector (`npx @monlite/studio
  app.db`) to browse collections, filter documents, and delete records.
- **Full migration runner** — `collection.$migrate({ rename, drop })` rebuilds a
  structured table to the declared schema (drop/rename/type-change), preserving
  data and indexes, with an unacknowledged-drop guard.
- **Joins** — `lookup` on `findMany` ($lookup / $unwind), two-query left joins
  across collections in both storage modes.
- **Typed queries (2.0)** — typed collections check `where`/`orderBy` fields and
  `select` narrows the return type; untyped collections stay schema-free.

## Planned

### Wave 3 — desktop & browser
- **Incremental OPFS persistence** for `@monlite/wasm` — a driver over the
  official `@sqlite.org/sqlite-wasm` + OPFS VFS (Web Worker, sync access handles),
  so large browser databases persist without full-file snapshots.


### Wave 4 — DX depth
- A **docs site** (the content exists across the READMEs + `docs/`; this is
  packaging + hosting).

### Wave 5 — breadth (demand-driven)
- A **Python** binding (AI/DS workflows), then evaluate Dart/Flutter — thin
  wrappers over the documented [format](./FORMAT.md), not query-engine ports.

---

*Directional, not a commitment of dates. Core stays zero-dependency by default;
native capabilities are opt-in — either as separate packages (e.g. `@monlite/vector`)
or as core options that only load a native module when used (e.g. `encryption`,
which loads `better-sqlite3-multiple-ciphers` lazily).*
