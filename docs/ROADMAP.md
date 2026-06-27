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
| Redis (cache) | `@monlite/kv` 🔲 |
| Redis / BullMQ (queue) | `@monlite/queue` 🔲 |
| Redis / cron (scheduling) | `@monlite/cron` 🔲 |
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
  **MongoDB** (verified against a live replica set, incl. change streams),
  monlite-to-monlite, and in-memory. Document **and** structured collections sync.
- **Wave 1** — `collection.watch()` reactivity (row-level), auto-additive
  migrations, `collection.explain()`, and `db.backup()`.
- **Plugin system** — `createDb({ plugins })` with `init`/`afterWrite`/
  `collectionMethods` hooks.
- **`@monlite/fts`** — full-text search (SQLite FTS5) via `collection.search()`.
- **`@monlite/vector`** — local vector / semantic search (sqlite-vec) via
  `collection.findSimilar()`, plus **`hybridSearch()`** (FTS + vector fused with
  Reciprocal Rank Fusion) for RAG and AI-agent memory.
- **Stable 1.0** — `@monlite/core` and `@monlite/sync` are at `1.0.0` (semver-stable).
- **Examples + benchmarks** — runnable demos in [`examples/`](../examples/) and a
  benchmark suite ([`docs/BENCHMARKS.md`](./BENCHMARKS.md)).

## Planned

### Wave A — the local AI-agent harness (Redis's local roles)
- **`@monlite/kv`** — Redis-like cache/KV: `get/set/del/incr/expire/ttl/mget`,
  TTL with lazy expiry + sweep. Persistent or `:memory:`.
- **`@monlite/queue`** — durable job queue: atomic claim (`UPDATE … RETURNING`
  under WAL + busy_timeout), retries/backoff, delayed jobs, dead-letter,
  concurrency, events. Multi-process safe.
- **`@monlite/cron`** — cron-scheduled jobs that enqueue via `@monlite/queue`.

### Wave 3 — desktop production
- **`@monlite/cipher`** / `encryption` option — encryption at rest (SQLCipher via
  better-sqlite3-multiple-ciphers). *(In progress.)*
- **Full migration runner** (rename/drop/rebuild) for structured collections.
- **Electron/multi-window** helper (main-process DB + IPC bridge).
- **`@monlite/devtools`** — inspector / query explorer ("Studio").

### Wave 4 — DX depth
- **Stronger TypeScript inference** — typed `where`/`orderBy`/`select` and
  `select`-narrowed return types.
- **`$lookup` / `$unwind`** aggregation.
- A **docs site** and migration/custom-adapter **guides**.

### Wave 5 — breadth (demand-driven)
- A **monlite file-format spec** so other languages can read/write the same `.db`.
- A **Python** binding (AI/DS workflows), then evaluate Dart/Flutter.

---

*Directional, not a commitment of dates. Core stays zero-dependency; native
capabilities (vector, cipher) are always opt-in packages.*
