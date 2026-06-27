# 🌙 monlite Roadmap

Where monlite is heading. monlite is a local-first database for TypeScript:
one query API, document **and** native-column storage, optional sync. The goal
is to be the **batteries-included local-first layer** for desktop, CLI, and
AI-native TS apps — keeping `@monlite/core` lean and zero-dependency, with
heavier capabilities as opt-in packages.

## Shipped

- **`@monlite/core`** — document + structured (native-column) collections, one
  Mongo/Prisma-style query API, aggregation (`groupBy`/`having`/`distinct`),
  auto-indexing, raw-SQL escape hatch, dual driver (`better-sqlite3` +
  zero-dep built-in `node:sqlite`), typed errors, prepared-statement cache.
- **`@monlite/sync`** — local-first replication (pull / push / two-way / live),
  LWW + custom conflict resolution, change feed + tombstones, and adapters for
  **MongoDB** (verified against a live replica set, incl. change streams),
  monlite-to-monlite, and in-memory. Document **and** structured collections sync.

## In progress — Wave 1: foundations & quick wins

- **Reactivity** — `collection.watch()` / live queries with **row-level** change
  matching (only recompute when a changed row actually affects the query).
- **Auto-additive migrations** for structured collections (`ADD COLUMN` on schema diff).
- **`collection.explain()`** — query plan + whether an index was used.
- **`db.backup(path)`** — consistent on-disk snapshots.

## Planned

### Wave 2 — search & the AI wedge
- **Plugin system** (lifecycle hooks; keeps core lean) — landed with its first consumer.
- **`@monlite/fts`** — FTS5 full-text search (`collection.search(...)`).
- **`@monlite/vector`** — local vector / semantic search (sqlite-vec) + **hybrid
  search** (keyword + vector) for RAG and AI-agent memory.

### Wave 3 — desktop production
- **`@monlite/cipher`** — encryption at rest (SQLCipher).
- **Full migration runner** (rename/drop/rebuild) for structured collections.
- **Electron/multi-window** helper (main-process DB + IPC bridge).
- **`@monlite/devtools`** — inspector / query explorer ("Studio").

### Wave 4 — DX depth & adoption
- **Stronger TypeScript inference** — typed `where`/`orderBy`/`select` and
  `select`-narrowed return types.
- **`$lookup` / `$unwind`** aggregation.
- Real-world **examples** (Electron notes, POS/inventory, agent memory),
  **benchmarks**, a **docs site**, and migration/custom-adapter **guides**.

### Wave 5 — breadth (demand-driven)
- A **monlite file-format spec** so other languages can read/write the same `.db`.
- A **Python** binding (AI/DS workflows), then evaluate Dart/Flutter.

---

*Directional, not a commitment of dates. Core stays zero-dependency; native
capabilities (vector, cipher) are always opt-in packages.*
