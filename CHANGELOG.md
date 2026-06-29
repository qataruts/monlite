# @monlite/core

## 2.6.13 — sync enumeration + watch isolation (bug hunt, cont.)

- **`$collections()` returns only real collections** (tables with an `_id` column), excluding
  plugin/auxiliary tables — queue `_jobs`, fts `*_fts*`, vector `*_vec*`, dynamic index tables.
  Previously `sync({ collections: "*" })` swept those internals and treated them as user data.
- **A throwing `watch()` callback no longer breaks sibling watchers** or wedges the reactor (or
  crashes the host). The error is reported and the remaining watchers are still notified.

## 2.6.12 — correctness sweep (repo-wide bug hunt)

A concentrated multi-agent bug hunt + differential fuzzing surfaced a batch of real,
reproduced correctness bugs across the query, write, transaction, structured-column and
aggregation layers. Each fix ships with a regression test.

**Query operators**
- `{ OR: [] }` matched ALL rows → now matches none (empty `AND` still matches all).
- `in`/`notIn` with a `null` in the list no longer drops legitimate non-null rows.
- `endsWith: ""` matched only the empty string → now matches every string.
- `has`/`contains` on a declared JSON-array column now do array membership (were scalar/substring).
- Dotted paths whose root is a declared JSON column now read that column (were reading `data`).
- Field names containing `"` or `\` are now queryable (JSON-string path escaping).
- `_id` queries accept numbers (`findById(123)` matches `create({ _id: 123 })`).

**Writes / updates**
- `upsert` seeds the created doc with the `where` equality fields (idempotent; was duplicating).
- `$inc`/`$push`/`$addToSet` on a non-conforming target now throw (were silently overwriting);
  `$set` on `_id` now throws.

**Transactions**
- Concurrent `findOneAndUpdate` (multi-worker CAS) no longer throws "no such savepoint" —
  it routes through the serialized async-transaction queue.
- Nested `transactionAsync` no longer deadlocks/bricks the connection — it is now re-entrant.

**Structured columns**
- Column `default`s are applied for omitted fields (incl. `notNull` + default); a unique index
  over pre-existing duplicates surfaces a typed `MonliteError`.

**Aggregation**
- `distinct`/`groupBy`/`_min`/`_max` decode JSON columns to objects (matching `findMany`).

## 2.6.11 — `NOT` matches null/missing-field documents

- **`{ NOT: { field: value } }` now matches documents where `field` is missing or
  null** — consistent with the `{ field: { not: value } }` operator and document-DB
  semantics (a missing `field` IS "not value"). Previously the SQL `NOT (field = value)`
  evaluated to NULL for such rows (three-valued logic) and silently dropped them, so the
  `NOT` combinator and the `not` operator disagreed. Found by a differential fuzz audit
  of the query layer (24,000 random queries — this was the only divergence; the
  aggregation layer was clean over 15,000 ops). **Behavior note:** `NOT` queries now also
  return documents that lack the field.

## 2.6.10 — groupBy ordering by an accumulator

- **`groupBy({ orderBy })` now sorts by an accumulator** — e.g.
  `orderBy: { _sum: { total: "desc" } }` (also `_avg`/`_min`/`_max`). Previously only
  `_count` and `by`-fields were honoured; an accumulator `orderBy` was silently ignored
  (the `{ total: "desc" }` object stringified to `"[object Object]"`, defaulted to ASC,
  and ordered by a non-existent column). The docs already documented this syntax — found
  during a functional-accuracy audit. `_count` and `by`-field ordering are unchanged.

## 2.6.9 — atomic sync ingest

- **`applyRemoteWrite` (the `@monlite/sync` ingest path) now indexes inside a
  transaction**, completing the "every write indexes atomically" invariant from 2.6.8.
  Real sync was already atomic — the sync round wraps the apply in a transaction — so
  this is defense-in-depth that also covers a direct call and makes the guarantee
  unconditional (it nests as a cheap SAVEPOINT under the sync round). Found by a focused
  re-verification swarm; no behavior change for normal sync.

## 2.6.8 — atomic indexing across the full write surface + sync-ingest guard

- **Every mutation and delete now indexes inside its write transaction.** 2.6.7 made
  `create`/`createMany` atomic with plugin indexing; this extends it to `update` /
  `updateMany` / `upsert` / `findOneAndUpdate` / `bulkWrite` / `delete` / `deleteMany` /
  `purgeExpired`, so a failing plugin index (e.g. a wrong-dimension vector) rolls the
  mutation back instead of leaving a committed-but-unindexed row.
- **The sync ingest path (`applyRemoteWrite`) honours the write guard.** A remote change
  can no longer silently fold into — and be lost by — an unrelated in-flight
  `transactionAsync`; it is rejected and retried on the next pull.

## 2.6.7 — atomic indexing

- **Plugin index writes now share the triggering write's transaction.** A failing
  `afterWrite` (e.g. `@monlite/vector` rejecting a wrong-dimension vector partway
  through a `createMany`) previously left the base rows committed but unindexed; the
  write now rolls back as a unit, so a row is never left out of its index. The call
  throws — fix the data and retry. (Drivers nest via `SAVEPOINT`.)

## 2.6.6 — verification follow-up: correctness fixes

A second adversarial verification pass found real holes in the 2.6.3–2.6.5 hardening;
this release closes them.

- **Foreign-write rejection now covers every mutating path.** `findOneAndUpdate` (the
  cross-process CAS!), `bulkWrite`, and `purgeExpired` were missing the in-flight
  `transactionAsync` guard, so a foreign call during an async transaction's await window
  could still silently fold into it (data loss on rollback). All three now throw.
- **`$lookup` no longer throws under `maxRows`.** Joins used the public `findMany`, so a
  large join inherited the row cap; they now use the internal uncapped read (already
  bounded by the join keys).
- **Native driver loads on all Node versions again.** The 2.6.3 lazy `require`
  (`getBuiltinModule` + probe) broke native-driver loading on Node 18.x / 20.0–20.15 /
  22.0–22.2 ESM. Reverted to a static `createRequire` (correct on all Node, ESM + CJS).
  For a **browser** bundle, alias/stub `node:module` (the demo's `vite.config` does).
- **Sync version-counter resume is clock-jump safe.** It ordered by the version *string*
  (timestamp-led), so a backward clock jump could resume below an already-used `seq`; it
  now orders by the change-log insertion `seq` and drops an unescaped `LIKE`.

## 2.6.5 — sync version-counter recovery

- **The per-node sync version counter resumes across restarts.** It reset to 0 on
  startup, so a write within the same millisecond as a pre-restart write could reuse
  a `seq` — colliding or mis-ordering under last-write-wins. The counter now resumes
  past the highest version recorded for this node.

## 2.6.4 — write isolation + resource limits

- **Foreign writes during an in-flight `transactionAsync` are now rejected.** A plain write
  issued from outside the transaction's callback during its await window used to silently
  fold into the transaction on the shared connection (committing/rolling back with it). It
  now throws a clear error — tracked via an `AsyncLocalStorage` write-context loaded lazily
  (so the browser bundle stays clean); writes inside the callback are unaffected.
- **Opt-in resource limits for untrusted/multi-tenant input.** `maxDocumentBytes` rejects a
  write whose serialized document exceeds the limit; `maxRows` caps an unbounded `findMany`
  (no `take`) — it throws past the cap instead of materializing a huge result set. Both off
  by default; internal queries (indexing/reactivity) and `count()` are never capped.

## 2.6.3 — browser-clean bundle + batched plugin indexing

- **The ESM bundle no longer statically imports `node:module`.** That single line broke
  browser bundlers (Vite / esbuild / webpack) even though native-driver loading never
  runs in the browser (a driver like `@monlite/wasm`'s `wasmDriver` is passed explicitly).
  A CommonJS `require` is now resolved lazily — `process.getBuiltinModule` (Node 20.16+ /
  22.3+, ESM and CJS) then a probed global `require`. Added a `browser` export condition.
  **Superseded in 2.6.6:** this lazy approach broke native loading on older Node ESM and
  was reverted to a static `createRequire`; browser bundles now alias `node:module`.
- **Plugin `afterWrite` indexing is batched into one transaction.** `fts`/`vector` indexing
  ran one INSERT per row with no enclosing transaction, so a bulk write did one commit/fsync
  *per indexed row* (the N+1 dominating RAG ingestion on a file DB). All plugin `afterWrite`
  calls for a write now run in a single transaction (nests as a SAVEPOINT). File-DB ingest:
  5K FTS docs in ~0.47s; 100K plain docs in ~0.8s.
- **`Driver.transaction` gained an `immediate` flag** (BEGIN IMMEDIATE). Powers
  `@monlite/kv`'s cross-process-safe `setNX`/`incr`.

## 2.6.1 — cross-process CAS

- **`findOneAndUpdate` CAS hardened to `BEGIN IMMEDIATE`.** The read-modify-write now
  takes the write lock up front (via the driver's `transactionAsync`), so a
  `version`/`status` guard is a true compare-and-swap **across processes** too: a
  racing writer (e.g. a separate jobs worker on the same `.db`) blocks, re-reads the
  already-bumped row, and cleanly returns `null` (lost CAS) instead of erroring on a
  stale WAL snapshot. Single-connection callers are unaffected (they serialize
  anyway). This is the load-bearing primitive for durable cross-process job
  workloads. Proven by a cross-process test: 8 separate
  worker processes race to claim one job — exactly one wins, the rest return `null`,
  zero `SQLITE_BUSY` errors, version bumped exactly once.

## 2.6.0 — regex operator

- **`regex` where operator** — JavaScript-`RegExp` matching: `{ name: { regex:
  "^al", mode: "insensitive" } }` or a `RegExp` literal `{ name: { regex: /^al/i } }`
  (its `i`/`m`/`s` flags are honoured). Backed by a `monlite_regexp` SQL function
  registered on every driver — `better-sqlite3`, `node:sqlite`, and
  `@monlite/wasm` (sql.js) — so it works the same everywhere, including the
  browser. Composes with other conditions and dot-path fields.

## 2.5.0 — elemMatch

- **`elemMatch` where operator** (Mongo `$elemMatch`) — match if **any** array
  element satisfies a sub-filter, with same-element semantics. Works on arrays of
  scalars (`{ scores: { elemMatch: { gte: 90 } } }`) and of objects
  (`{ items: { elemMatch: { sku: "A", qty: { gte: 2 } } } }`). Pure SQL via
  `json_each`; both drivers.

## 2.4.0 — AI-agent harness primitives

SQLite-native primitives for a local agent/job backend; pair with `@monlite/kv`
`setNX` and `@monlite/queue` dedupe.

- **Compound unique indexes** — `collection(name, { uniqueIndexes: [["tenantId",
  "jobId", "key"]] })`. A duplicate throws `MonliteUniqueConstraintError` (the
  idempotency/dedupe primitive). Fields may be columns or JSON paths.
- **Collection TTL** — `collection(name, { ttl: { field, seconds } })` +
  `collection.purgeExpired()` to cap unbounded-growth tables (job logs, sessions).
- **Atomic CAS** — note: `findOneAndUpdate` (2.2.0) already does compare-and-swap:
  match on `version`+`status` in `where`, `$set`+`$inc` in `data`, returns the new
  row or `null` (lost CAS). Now covered by a dedicated test.

## 2.3.0 — observability

- **`db.stats()`** — `{ sizeBytes, pageSize, pageCount, collections, indexes }`
  for monitoring/diagnostics.
- **`onQuery` option** on `createDb` — a hook called after each statement with
  `{ sql, durationMs }`. Wire a slow-query log or metrics; zero overhead when
  unset. Implemented on `better-sqlite3` and `node:sqlite`.
- New [production guide](docs/guides/production.md) — durability, transactions,
  backup/recovery, concurrency, money-precision, and the error reference.

## 2.2.0 — async transactions & Mongo-API completeness

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

Hardening toward system-of-record use.

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
