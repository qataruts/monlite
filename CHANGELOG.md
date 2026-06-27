# @monlite/core

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
