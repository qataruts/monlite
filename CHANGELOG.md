# @monlite/core

## 2.4.0 — AI-agent harness primitives

Unblocks the local-agent-backend track (`plan/PLATFORM-AI-ADOPTION.md`). All
SQLite-native; pairs with `@monlite/kv` `setNX` and `@monlite/queue` dedupe.

- **Compound unique indexes** — `collection(name, { uniqueIndexes: [["tenantId",
  "jobId", "key"]] })`. A duplicate throws `MonliteUniqueConstraintError` (the
  idempotency/dedupe primitive). Fields may be columns or JSON paths.
- **Collection TTL** — `collection(name, { ttl: { field, seconds } })` +
  `collection.purgeExpired()` to cap unbounded-growth tables (job logs, sessions).
- **Atomic CAS** — note: `findOneAndUpdate` (2.2.0) already does compare-and-swap:
  match on `version`+`status` in `where`, `$set`+`$inc` in `data`, returns the new
  row or `null` (lost CAS). Now covered by a dedicated test.

## 2.3.0 — observability

Closes P1-3 from `plan/PRODUCTION-READINESS.md`.

- **`db.stats()`** — `{ sizeBytes, pageSize, pageCount, collections, indexes }`
  for monitoring/diagnostics.
- **`onQuery` option** on `createDb` — a hook called after each statement with
  `{ sql, durationMs }`. Wire a slow-query log or metrics; zero overhead when
  unset. Implemented on `better-sqlite3` and `node:sqlite`.
- New [production guide](docs/guides/production.md) — durability, transactions,
  backup/recovery, concurrency, money-precision, and the error reference.

## 2.2.0 — async transactions & Mongo-API completeness

Closes P0-1 and a chunk of P1-1 from `plan/PRODUCTION-READINESS.md`.

- **`db.transactionAsync(async (tx) => …)`** — an atomic unit of work whose
  callback **may `await`** (read → compute → write), all inside one
  `BEGIN IMMEDIATE … COMMIT`; a throw rolls the whole thing back. Unlike
  `$transaction` (sync-callback only), it supports interleaved async reads/compute.
  **Serialized** so concurrent units can't interleave on the shared connection —
  prevents lost updates (a double-entry posting is atomic under concurrent
  callers); read-your-writes holds within a unit. Implemented on `better-sqlite3`,
  `node:sqlite`, and `@monlite/wasm`.
- **`collection.findOneAndUpdate({ where, data, returnDocument? })`** — atomic
  read-modify-return; returns the `"after"` (default) or `"before"` document.
- **`collection.bulkWrite([...])`** — mixed `insertOne`/`updateOne`/`updateMany`/
  `deleteOne`/`deleteMany` in **one transaction** (all-or-nothing).
- **`$addToSet`** update operator — append to an array only if absent (supports
  `$each`).

## 2.1.0 — durability & maintenance

Hardening toward system-of-record use (see `plan/PRODUCTION-READINESS.md`).

- **`db.checkIntegrity(quick?)`** — verify on-disk integrity
  (`PRAGMA integrity_check` / `quick_check`); returns `true` or the problems.
- **`db.vacuum()` / `db.analyze()` / `db.checkpoint(mode?)`** — reclaim space,
  refresh the query planner's stats, and checkpoint the WAL.
- **`synchronous` option** on `createDb` (`OFF` | `NORMAL` | `FULL` | `EXTRA`) —
  tune durability vs. speed (WAL defaults to `NORMAL`; `FULL` for max power-loss
  safety).
- **Auto-index counters now persist** in `_monlite_autoindex` and re-hydrate on
  open, so a restarted app resumes learning where it left off and already-indexed
  paths aren't re-tracked — predictable cold start.

## 2.0.0 — typed queries & select-narrowed results

Stronger TypeScript inference. **Untyped collections (`db.collection(name)`,
i.e. `Doc`) are unchanged and fully schema-free** — the breaking changes apply
only when you type a collection (`db.collection<User>(name)`).

**Breaking (typed collections only):**

- **`where` and `orderBy` reject unknown fields.** Keys are checked against your
  type; a typo or a field not on `T` is a compile error. Dot-notation nested
  paths (`"address.city"`) are still allowed.
- **`select` narrows the return type.** `findMany`/`findFirst`/`findUnique`/
  `findFirstOrThrow` now return only the selected fields, so code that read an
  un-selected field off the result will no longer type-check.

**Migration** — see [docs/guides/v2-migration.md](docs/guides/v2-migration.md).
In short: add the field to your `<T>`, use a dot-path string, or use an untyped
collection. Runtime behavior is **identical** to 1.x; only types changed.

**Notes / limits:** per-field operator *value* types are hinted but not strictly
enforced (operator objects are all-optional, so TS structurally accepts
primitives); `select` keys narrow the result but aren't excess-checked. Write
payloads (`create`/`update` data) remain open, preserving schema-free writes.

## 1.4.0 — joins ($lookup / $unwind)

- **`lookup` on `findMany`** — left-join related documents from another
  collection: `{ from, localField, foreignField, as }` attaches matches as an
  array ($lookup); `unwind: true` flattens to one row per match ($unwind), and
  `unwind: "preserve"` keeps unmatched rows. Pass an array to join several at
  once. Runs as two queries (no N+1) in both document and structured modes.

## 1.3.0 — custom drivers (browser/WASM)

- **`createDb(path, { driver })` now accepts a custom `Driver` instance**, not
  just `"auto"`/`"better-sqlite3"`/`"node:sqlite"`. This is the seam that lets
  [`@monlite/wasm`](https://www.npmjs.com/package/@monlite/wasm) run monlite in
  the browser on SQLite-WASM. Exported `RunResult`/`DriverOpenOptions` types.

## 1.2.0 — full migrations

- **`collection.$migrate({ rename?, drop? })`** — destructive structured-collection
  migrations the auto-additive path can't do: **drop** columns, **rename** them,
  and **change a column's type/constraints**. Implemented as a safe, transactional
  table rebuild that preserves data and recreates indexes. An unacknowledged
  column drop throws, so data is never lost by accident.

## 1.1.0 — encryption at rest

- **`encryption` option** — encrypt the database file at rest:
  `createDb(path, { encryption: { key, cipher? } })`. Backed by the
  `better-sqlite3-multiple-ciphers` drop-in (optional peer dependency); not
  available on `node:sqlite`. A wrong/missing key throws the new
  **`MonliteEncryptionError`** on open.
- **`db.rekey(key, cipher?)`** — rotate the encryption key (handles WAL mode).

## 1.0.0 — stable

First stable release. The CRUD/query, aggregation, structured-collection,
reactivity, sync, and plugin APIs are now under semantic versioning. No code
changes from 0.10.0 — this marks API stability. (The `@monlite/*` packages now
depend on `^1.0.0`, so core minor releases no longer require lockstep republishes.)

## 0.10.0 — extension loading

- **`allowExtensions` option** — open the database with SQLite extension loading
  enabled (`createDb(path, { allowExtensions: true })`), required by
  [`@monlite/vector`](https://www.npmjs.com/package/@monlite/vector) (sqlite-vec).
  Wired through both drivers.

## 0.9.0 — plugin system

- **Plugin system** — `createDb({ plugins: [...] })` with a `MonlitePlugin`
  interface (`init` / `afterWrite` / `collectionMethods` hooks). Keeps core lean
  while opt-in packages add capabilities. First consumer:
  [`@monlite/fts`](https://www.npmjs.com/package/@monlite/fts) (full-text search).
- `afterWrite` fires synchronously post-commit for both local and synced writes,
  so plugin-maintained indexes stay current.

## 0.8.0 — Wave 1: reactivity, migrations, explain, backup

- **Reactivity** — `collection.watch(args, cb)` live queries with **row-level**
  change matching (only relevant changes trigger a recompute). Fires `init` then
  `change` events with `results`/`added`/`removed`/`changed`. Also fires for
  changes applied by `@monlite/sync`.
- **Auto-additive migrations** — declaring a structured collection now ensures
  and migrates its table immediately; new declared columns are added via
  `ALTER TABLE ADD COLUMN` (clear error if a `NOT NULL` column needs a default).
- **`collection.explain(args)`** — EXPLAIN QUERY PLAN plus a `usesIndex` flag.
- **`db.backup(path)`** — consistent on-disk snapshot via `VACUUM INTO`.

## 0.7.0 — structured sync + convergence

- **Structured collections now sync.** Remote changes are applied through the
  mode-aware collection, so native columns (not just JSON overflow) round-trip.
  Open a structured collection with its `schema` on each node before syncing.
- **LWW convergence fix**: when a local document wins a conflict, its winning
  version is re-enqueued so it propagates back to the remote (the two ends no
  longer diverge).
- `seed` skips collections whose local table doesn't exist yet.
- Tooling: ESLint (flat config) + Prettier with `lint`/`format` scripts, wired
  into CI.

## 0.6.0 — production hardening

### Security
- **Fix SQL injection** via `groupBy` field aliases — group keys now use generated
  aliases, never the raw field name.
- Escape SQL identifiers in `fieldExpr` (defense-in-depth) and validate column
  `references` grammar in structured schemas.
- **Prevent prototype pollution** — update paths (`$set`/`$unset`/`$inc`/…) reject
  `__proto__`, `prototype`, and `constructor` segments.

### Correctness
- `upsert` is now **atomic** (find + create/update run in one transaction).
- `$inc` rejects a non-finite operand instead of silently nulling the field.
- Structured collections: reject objects/arrays in non-JSON columns; an explicit
  `null` in a native column now round-trips.
- `node:sqlite` driver recovers cleanly from a failed commit/rollback instead of
  poisoning the connection.

### Reliability & performance
- **Typed errors**: `MonliteUniqueConstraintError`, `MonliteNotNullError`,
  `MonliteForeignKeyError`, `MonliteConstraintError`; driver errors are normalized
  across both backends (plus `normalizeDriverError`).
- **Prepared-statement caching** in both drivers.
- `PRAGMA busy_timeout` (default 5000ms, configurable via `busyTimeout`) and
  `foreign_keys = ON`.

### API
- New methods: `findUnique`, `findFirstOrThrow`, `exists`.
- `db.collection(name, { schema })` throws on a conflicting re-declaration
  (mode/columns are fixed on first access).
- Sync version tokens include a per-node monotonic counter, so versions are unique
  even within the same millisecond (fixes cursor-tie edge cases).

## 0.5.0
- **Structured collections**: `db.collection(name, { schema })` backs declared
  fields with native SQL columns (typed, indexed, joinable); other fields overflow
  to JSON. Same CRUD/query API. Introspection via `collection.mode` / `db.$schema`.

## 0.4.0
- **Sync primitives** behind `{ sync: true }`: change feed, tombstones, per-doc
  LWW versioning, per-remote cursors, conflict log (`db.$sync`). Foundation for
  `@monlite/sync`.

## 0.3.0
- `distinct`, `groupBy` having-filters.

## 0.2.0
- Driver adapter: `node:sqlite` zero-dependency backend; `better-sqlite3` becomes
  an optional peer dependency.

## 0.1.0
- Initial release: embedded document database over SQLite with a Mongo/Prisma-style
  API, aggregation, auto-indexing, and a raw-SQL escape hatch.
