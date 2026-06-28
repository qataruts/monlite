<!--
  monlite — Project Assessment
  Generated 2026-06-28 by an 8-agent evaluation swarm (7 dimension evaluators reading the
  real source/tests/docs in parallel + 1 lead synthesizer). Evidence-based; cites files.
-->

# monlite — Project Assessment

## Executive Summary

monlite is an unusually well-engineered, zero-dependency embedded database that layers a Mongo/Prisma-style document API, full-text + vector search, and Redis-style ops primitives (kv/queue/cron) over SQLite, with a credible sync engine and a browser/WASM story. Across seven independent evaluations the project scores consistently in the 6–7 range: the hard correctness primitives that most projects skip are genuinely right (cross-process CAS, SIGKILL crash-consistency, atomic job-claims, race-safe push), the test suite (~231 tests, property-based, dual-driver, multi-OS CI) is a cut above, and the injection surface is small and deliberately defended. What holds it back from production-grade at its own stated 10K–100K-doc RAG target is a cluster of recurring themes that surface independently across dimensions: **transaction-isolation footguns** (plain writes interleaving with in-flight async transactions; DEFERRED-mode setNX deadlocks), **a silent multi-collection sync data-loss bug**, **recall-correctness bugs in the search plugins** (post-filtering the top-K), **un-batched N+1 indexing and full-collection materialization at ingest/scale**, **a browser bundle that statically imports `node:module`**, and **scale/durability claims that no test or benchmark actually verifies**. Overall maturity: **6.3 / 10** — a strong, honest, single-tenant local/edge store that is one focused hardening cycle away from backing the multi-collection, high-throughput, untrusted-input workloads its README promises.

## Update — fixes shipped (2026-06-28)

All **8 P0s** and **4 P1s** below have been fixed, tested, and published. Each has a
regression test that fails without the fix.

**P0 (published):** multi-collection sync data loss → per-collection cursors · browser-clean
core bundle (no static `node:module`) · `kv` `setNX`/`incr` cross-process deadlock → BEGIN
IMMEDIATE · `fts`/`vector` `where` recall (over-fetch then filter) · batched plugin
`afterWrite` (N+1) · 100K-doc/50K-vector scale tests · opt-in resource limits
(`maxDocumentBytes`, `maxRows`) · reject foreign writes during `transactionAsync`.

**P1 (published):** `fts.search()` never throws on malformed input · `sync` version counter
resumes across restarts · `createVectorStore` re-validates metadata keys at query time ·
`queue` opt-in `visibilityTimeout` (reaper + heartbeat for crashed workers).

Versions: `@monlite/core` 2.6.5, `@monlite/kv` 0.2.1, `@monlite/fts` 0.5.2,
`@monlite/vector` 0.5.3, `@monlite/queue` 0.3.1, `@monlite/sync` 1.3.1. The remaining P1/P2/P3
items below are the open backlog.

## Scorecard

| Dimension | Score /10 | One-line take |
|---|---|---|
| Core engine | 7 | Solid dual-mode document layer with correct atomic primitives; transaction isolation and "aggregation pipeline" are oversold. |
| Search / RAG | 6 | Well-architected FTS5 + sqlite-vec with correct RRF fusion, but a real post-filter recall bug and clock-based freshness. |
| Ops primitives (kv/queue/cron) | 6 | Atomic claims are right; cross-process setNX deadlocks and at-least-once execution contradict the parity claims. |
| Sync / replication | 6 | Thoughtful append-only change feed, but a critical multi-collection cursor data-loss bug and unbounded growth. |
| Cross-runtime (WASM/Electron) | 6 | Excellent sql.js facade undermined by a `node:module` import that breaks browser bundling; vector can't run in-browser. |
| Quality / DX | 7 | Genuinely hard correctness tests + strong CI and types; headline scale claims are untested and there's no API reference. |
| Perf / scale / security | 6 | Fast core with honest benchmarks; un-batched ingest N+1, full-collection materialization, and no resource limits. |

## Top strengths

1. **The hardest correctness primitives are actually right and actually tested.** Cross-process compare-and-swap via `findOneAndUpdate` + `BEGIN IMMEDIATE` (proven by an 8-process race asserting exactly-one-winner, zero `SQLITE_BUSY`), a SIGKILL-mid-transaction crash test asserting fund conservation and `checkIntegrity()`, and property-based query equivalence against an independent JS oracle. (`tests/cas-cross-process.test.ts`, `tests/crash.test.ts`, `tests/property.test.ts`)
2. **The O(n²) bulk-index trap is genuinely fixed at the storage layer.** The `_monlite_fts_ids` rowid IDMAP and vec0 `doc_id text primary key` make per-doc re-index DELETEs O(log n), keeping ingestion linear. (`packages/fts/src/index.ts:34-46`, `packages/vector/src/index.ts:382-387`)
3. **Atomic claim semantics for the ops layer.** Queue job-claim is a single `UPDATE ... RETURNING` and cron occurrence-firing is a single conditional `UPDATE ... WHERE next_run<=? ... changes>0` — the multi-process exactly-once-per-claim parts are correct. (`packages/queue/src/index.ts:318-332`, `packages/cron/src/index.ts:181-191`)
4. **Race-safe, echo-free sync design.** `markPushed` only clears `seq <= acked.seq` so concurrent local writes aren't lost; remote-applied changes carry `source='remote'` so they never re-enter the push queue; conflict resolution is atomic inside one transaction. (`src/sync/store.ts:234-243,256-314`)
5. **Injection surface is small and deliberately closed.** Identifiers validated by regex (`validateName`/`NAME_RE`/`vecIdent`/`ftsIdent`), values always parameterized via `bindable()`, JSON paths through `pathLiteral`, `$queryRaw` is a parameterizing tagged template. (`query/sql.ts`, `db.ts:18,27`)
6. **A clean, correct cross-runtime facade.** The `db.sqlite` facade normalizes sql.js column-array results into row objects so fts/vector/kv plugins run unchanged in the browser, and it correctly clears the statement cache after `export()` to dodge sql.js's finalize-on-serialize footgun. (`packages/wasm/src/index.ts:98-108,207-214`)
7. **Honesty and engineering rigor in the harness.** Zero-dependency core (`dependencies: {}`), dual-driver + macOS/Windows CI that builds before testing, an honest ~2x-overhead in-memory benchmark with explicit caveats, and a typed, actionable error hierarchy. (`.github/workflows`, `bench/bench.mjs`, `src/errors.ts`)

## Critical & high-severity gaps

| Severity | Gap | Where | Impact |
|---|---|---|---|
| **Critical** | Multi-collection version-cursor pagination advances one global cursor, permanently skipping un-returned rows in other collections under `batchSize`/LIMIT | `packages/sync/src/adapters/{postgres,mysql,mongo}.ts`; `engine.ts:210-241` | Silent, unrecoverable data loss the moment >1 collection syncs with a backlog; entirely untested (all integration tests sync one collection). |
| **Critical** | `@monlite/core` ESM bundle statically imports `node:module` at module top (`createRequire` at `dist/index.js:1`) | `src/db.ts:12`, `src/driver/index.ts:1`; `package.json` (no browser export condition) | Any browser bundle of core errors unless `node:module` is externalized — directly breaks the headline "browser is just another backend." |
| **High** | `transactionAsync` only serializes against itself; plain writes from the same instance during an `await` window fold into the async tx (better-sqlite3) or corrupt the savepoint depth counter (node:sqlite) | `src/db.ts:242-259`; `src/driver/node-sqlite.ts:21,84-141`; `src/collection.ts:632-1150` | Correctness footgun for the marketed "atomic ledger posting" use case; an unrelated write can silently commit/rollback with the transaction. |
| **High** | KV `setNX`/`incr` use DEFERRED (`BEGIN`) transactions; two processes racing the same key deadlock on lock upgrade and throw `SQLITE_BUSY` instead of one returning `false` | `packages/kv/src/index.ts:104-136` | The advertised "Redis SET NX" cross-process lock/nonce primitive is unreliable; losing caller throws rather than failing cleanly. |
| **High** | `vector()`/`fts()` plugin `where` is a POST-filter on the top-K, silently dropping recall (a selective filter can return zero hits when matches exist further out) | `packages/vector/src/index.ts:166-192`; `packages/fts/src/index.ts:168-191` | Recall/correctness bug that undermines the headline `where:{published:true}` RAG filter; opposite of the correctly-over-fetching `createVectorStore`. |
| **High** | `catchUp` cross-process freshness uses wall-clock `Date.now()` high-water marks, not row `updated_at` | `packages/vector/src/index.ts:115-142,400`; `packages/fts/src/index.ts:66-93,238` | Clock skew / same-ms races between ingest and search processes can permanently skip documents from the index. |
| **High** | Queue is at-least-once, not exactly-once: handler runs, then a separate completion write; mid-job crash + `recover()` re-runs side effects | `packages/queue/src/index.ts:131-147,303-310,335-345` | Non-idempotent handlers (charge card, send email) double-fire; README's "claimed exactly once" misleads BullMQ migrators. |
| **High** | `afterWrite` indexing is an un-batched N+1: per-row `getRaw()` SELECT + per-row index INSERT outside any transaction | `packages/fts/src/index.ts:113-142,234-239`; `packages/vector/src/index.ts:65-80,396-401` | Dominant cost of bulk RAG ingestion even after the O(n²) fix: N single-row re-reads + N auto-committing index writes per `createMany`. |
| **High** | Full-collection / full-embedding materialization with no streaming: `reindex()` and `findSimilarBrute()` `.all()` the entire corpus into JS | `packages/fts/src/index.ts:145-152`; `packages/vector/src/index.ts:83-88,251-271` | Caps practical corpus size below the advertised 100K on memory grounds, not just speed; every read path is `.all()`. |
| **High** | No resource limits: no max document/payload size, no query timeout, no result-row cap | `src/collection.ts:688-693,875-901`; `src/query/where.ts:231-250` | A single unbounded `findMany`/`distinct`/pathological regex over a large or untrusted collection is a DoS surface; blocks multi-tenant use. |
| **High** | Unbounded growth: append-only change feed and remote soft-delete tombstones are never compacted/GC'd | `src/sync/store.ts:105-134,189-213`; `packages/sync/src/adapters/{postgres,mysql,mongo}.ts` | Every sync round degrades forever on a continuously-syncing 100K-doc DB — directly undermines the headline use case. |
| **High** | Pure wall-clock LWW with no HLC and no clock-skew warning | `src/sync/version.ts:1-29`; `src/sync/store.ts:264-274`; `packages/sync/README.md:6-7,85` | A fast-clocked node wins every conflict over real-later writes — silent, permanent data loss in any multi-writer setup, undocumented. |
| **High** | Persistence is whole-file export/import only (no incremental OPFS/IndexedDB VFS) | `packages/wasm/src/index.ts:207-243`; `packages/wasm/README.md:37-69` | O(db size) rewrite per save caps browser DB at tens of MB — a real ceiling for browser RAG. |
| **High** | `@monlite/vector` cannot run on the wasm driver (facade lacks `loadExtension`; sql.js can't load native extensions) | `packages/vector/src/index.ts:367,476`; `packages/wasm/src/index.ts:98-108` | A headline differentiator (browser RAG via the dynamic store) silently does not work, with no clear error or doc caveat. |
| **High** | Headline RAG-scale and vector-scaling claims are untested | `README.md:266-267`; `tests/large-dataset.test.ts:18`; `packages/vector/tests/vector.test.ts` | The product's reason to exist (10K–100K RAG) has zero test/benchmark evidence at scale or realistic embedding dimensions. |

## Per-dimension findings

### Core engine — 7/10

The core engine is a genuinely well-engineered document layer over SQLite: document/structured dual-mode storage, a Prisma-style where translator, read-modify-write update operators, and CAS-capable `findOneAndUpdate` are correct, carefully written, and backed by a broad, serious test suite (crash/SIGKILL, cross-process CAS, property tests, durability). The driver abstraction is clean and the better-sqlite3 / node:sqlite backends are at parity. The two real soft spots for a Mongo replacement are transaction isolation (`transactionAsync` only serializes against itself) and the "aggregation pipeline," which is single-stage groupBy/accumulators plus an in-memory `$lookup`, not a composable `$match/$group/$unwind` pipeline. Solidly above prototype quality, short of "back 100K-doc RAG under concurrency" maturity.

**Strengths**
- Dual-mode collections share one CRUD/query path, splitting declared columns vs a JSON overflow `data` blob cleanly with consistent round-tripping. (`collection.ts:406-535`)
- The where translator is comprehensive and injection-safe — every value parameterized, identifiers quote-doubled, JSON paths through `pathLiteral`, generated aliases for `by` fields; operator coverage near Prisma+Mongo parity. (`where.ts`, `sql.ts:38-56`, `aggregate.ts:157-168`)
- Correct atomic primitives: upsert/`findOneAndUpdate`/bulkWrite/delete/update all run read+write in one `driver.transaction()`; `findOneAndUpdate` uses `BEGIN IMMEDIATE` for true cross-process CAS. (`collection.ts:1009-1061`)
- Runtime-agnostic, index-localized ObjectId-compatible id generation (Web Crypto, no node:crypto/Buffer). (`id.ts`)
- Real, tested durability: WAL default, `busy_timeout` 5000ms, foreign_keys ON, `VACUUM INTO` backup, integrity_check, and a SIGKILL crash test. (`db.ts`, `crash.test.ts`)
- Efficient, correct reactivity: per-microtask write coalescing, row-level relevance probing, probe-limit fallback. (`reactive.ts`)
- Auto-indexer persists query counters and degrades gracefully on read-only DBs. (`auto-index.ts`)

**Gaps**
- **[High]** `transactionAsync` only serializes against itself; concurrent plain writes can corrupt isolation (savepoint folding / depth-counter mutation). (`db.ts:242-259`; `node-sqlite.ts:21,84-141`)
- **[Medium]** No real aggregation pipeline; `$group`/`$unwind`/`$lookup` are not composable, no `$project`/inter-stage `$sort`/`$limit`. (`aggregate.ts`; `collection.ts:738-777`)
- **[Medium]** `$lookup` loads all matched foreign docs into memory with no pagination or projection pushdown; unbounded IN-list; `take`/`skip` applied before `unwind`. (`collection.ts:711-777`)
- **[Medium]** `updateMany`/`bulkWrite` do per-row read-modify-write in JS (SELECT + structuredClone + UPDATE per row), no set-based SQL fast path. (`collection.ts:905-949,1067-1150`; `update.ts:33-122`)
- **[Medium]** Default durability is WAL NORMAL — a committed transaction can be lost on power loss; no per-transaction durable flush. (`better-sqlite3.ts:34-39`; `node-sqlite.ts:40-45`)
- **[Low]** No predicate `$pull`, no positional `$`/`arrayFilters`; `setPath` creates objects (not arrays) for numeric segments. (`update.ts:89-116`; `path.ts:27-36`)
- **[Low]** ORDER BY / comparisons on JSON values rely on SQLite affinity with no COLLATE/collation control; `mode:insensitive` is ASCII-only. (`order.ts`; `where.ts:296-319`; `sql.ts:48-51`)

**Improvements**
- **[P0/M]** Route ALL writes through `txTail` (or a single write mutex) so plain writes can't interleave with an in-flight `transactionAsync`.
- **[P1/M]** Add a SQL-side fast path for simple `updateMany` (`$set`/`$inc` on declared columns or single `json_set` paths).
- **[P1/M]** Bound and stream `$lookup`; push `select`/`take` to the foreign side.
- **[P2/L]** Build a composable aggregation pipeline, or clearly scope the docs to single-stage.
- **[P2/S]** Make power-loss durability explicit (default-or-document `synchronous`, add a durable flush).
- **[P3/M]** Extend update operators: predicate `$pull`, array-aware `setPath`, `arrayFilters`/positional.
- **[P3/M]** Add COLLATE/collation control for ordering and equality on text fields.

### Search / RAG — 6/10

The FTS5 and sqlite-vec integrations are well-architected for a local-first store: BM25 ranking is correct (sign-flipped to higher-is-better `_score`), the IDMAP and vec0 PK genuinely fix the O(n²) bulk-ingest trap, RRF hybrid fusion is textbook-correct, and `createVectorStore`'s in-KNN metadata pre-filtering gives exact scoped recall. The most serious problem is a recall-correctness bug in the document-bound `vector()` and `fts()` plugins: `where` is applied AFTER taking top-K, so a selective filter can silently return far fewer results than exist. `catchUp` freshness relies on wall-clock high-water marks, and the brute-force fallback has unbounded per-query memory/JSON cost with no warning.

**Strengths**
- FTS5 ranking correct: `ORDER BY rank` (BM25), `_score = -rank`, full live docs in rank order. (`fts/src/index.ts:168-191`)
- The `_monlite_fts_ids` IDMAP is a real, documented O(n²) fix (per-doc re-index DELETE by rowid is O(log n)). (`fts/src/index.ts:34-46,113-142`)
- vec0 `doc_id text primary key` keeps per-doc re-index O(log n). (`vector/src/index.ts:382-387`)
- `createVectorStore` pushes indexedField filters INSIDE the KNN for exact pre-filtered recall — proven by a scoped-hit test. (`vector/src/index.ts:601-612`; `tests/vector.test.ts:217-242`)
- RRF implemented correctly (`1/(k+rank+1)`, default k=60, no score normalization) with a clean vector-only fallback. (`vector/src/index.ts:340-355`)
- Exact brute-force JS fallback (correct L2/cosine) that pre-filters via `where` before scoring. (`vector/src/index.ts:201-271`)
- Cross-process freshness with high-water + orphan reconciliation, tested for writes and deletes.
- Dynamic create APIs validate identifiers against a regex to prevent injection. (`fts:260-265`; `vector:470-495`)

**Gaps**
- **[High]** `vector()`/`fts()` `where` is a POST-filter on the top-K, silently dropping recall. (`vector/src/index.ts:166-192`; `fts/src/index.ts:168-191`)
- **[High]** `catchUp` high-water uses wall-clock `Date.now()`, risking missed cross-process writes under skew. (`vector/src/index.ts:115-142,400`; `fts/src/index.ts:66-93,238`)
- **[Medium]** Brute-force fallback is unbounded O(n) memory + `JSON.parse` per query, entered silently in `init`'s catch with no warning. (`vector/src/index.ts:223-271,357-370`)
- **[Medium]** `createVectorStore` has no brute-force fallback — browser RAG via the dynamic store is impossible. (`vector/src/index.ts:473-489,518-519`)
- **[Medium]** `fts()` plugin search throws on malformed FTS5 query; `createSearchIndex` swallows it — inconsistent and a crash vector on untrusted input. (`fts/src/index.ts:168-173` vs `384-404`)
- **[Low]** `createVectorStore` non-indexed-field `where` can under-return without adaptive widening (fixed 8x/64 heuristic). (`vector/src/index.ts:601-624`)
- **[Low]** No scale benchmarks for FTS or vector; the linear-ingest and ~1M-vector claims are unverified. (`bench/bench.mjs`)

**Improvements**
- **[P0/M]** Over-fetch then filter in the `vector()`/`fts()` where-path (mirror `createVectorStore`).
- **[P1/M]** Replace wall-clock high-water with a monotonic write cursor for `catchUp`.
- **[P1/M]** Add a brute-force fallback to `createVectorStore` and warn when any vector path degrades to brute-force.
- **[P1/S]** Wrap the `fts()` plugin MATCH in try/catch (return `[]`) to match `createSearchIndex`.
- **[P2/M]** Add FTS and vector scale benchmarks (10K/100K ingest + query).
- **[P3/S]** Chunk the `_id IN(...)` where-pushdown if candidate sets can exceed `SQLITE_MAX_VARIABLE_NUMBER`.

### Ops primitives (kv/queue/cron) — 6/10

The three ops primitives are clean, well-tested, and genuinely useful as single-process local replacements for Redis cache/BullMQ/cron. The queue's job-claim and cron's occurrence-claim are correctly atomic and exactly-once per claim. The serious weakness is the multi-process correctness gap that contradicts the README parity claims: KV's `setNX`/`incr` use DEFERRED transactions, so two processes racing the same key can deadlock on the lock upgrade and throw `SQLITE_BUSY`. The queue is at-least-once, and stuck-job recovery is manual with no visibility-timeout/heartbeat.

**Strengths**
- Queue claim is a single atomic `UPDATE ... RETURNING *` with covering index `_jobs_claim` — correct exactly-once claim across processes. (`queue/src/index.ts:318-332`)
- Cron occurrence firing atomically claimed via conditional UPDATE (`changes>0`), `next_run` persisted across restarts. (`cron/src/index.ts:181-191`)
- `parseCron`/`nextCronRun` correctly implement POSIX dom/dow OR-semantics plus ranges/steps/lists with field-range validation. (`cron/src/index.ts:73-79`)
- Correct, tested retry/backoff/dead-letter: attempts at claim time, exponential backoff capped at 30s, reschedule vs `status='failed'`. (`queue/src/index.ts:80-81,348-363`)
- `jobId` dedupe (pending/active) for idempotent enqueue; `removeOnComplete` supported. (`queue/src/index.ts:229-235,336-337`)
- KV TTL semantics follow Redis conventions (-1/-2), lazy expiry + optional `unref()` sweep, LIKE-prefix escaping. (`kv/src/index.ts:166-170,143-157`)
- Correct worker drain/stop: waits for `inFlight` to reach 0, `close()` awaits all workers. (`queue/src/index.ts:155-169`)

**Gaps**
- **[High]** KV `setNX`/`incr` use DEFERRED transactions — cross-process lock primitive deadlocks and throws instead of returning `false`. (`kv/src/index.ts:104-136`)
- **[High]** Queue is at-least-once — handler side effects double-run on mid-job crash + `recover()`. (`queue/src/index.ts:131-147,303-310,335-345`)
- **[Medium]** Stuck-job recovery is manual with no visibility timeout or heartbeat; `updated_at` never refreshed during execution, so long jobs can be wrongly requeued. (`queue/src/index.ts:303-310`)
- **[Medium]** Cron skips missed occurrences after downtime (no catch-up) and uses local time with no TZ/DST handling. (`cron/src/index.ts:73-99,172-193`)
- **[Low]** Queue uses a single shared synchronous connection — no true parallelism, head-of-line cost on each poll's claim. (`queue/src/index.ts:121-153`)
- **[Low]** Expired KV keys accumulate unless read or swept; `size()`/`keys()` filter but never delete. (`kv/src/index.ts:143-199`)

**Improvements**
- **[P0/S]** Make `setNX`/`incr` use `BEGIN IMMEDIATE` so cross-process contention serializes instead of deadlocking.
- **[P1/M]** Document at-least-once semantics; add an idempotency/transactional-completion path.
- **[P1/M]** Add an optional automatic reaper and per-job heartbeat (visibility timeout).
- **[P1/M]** Add a multi-real-process concurrency stress test for kv/queue/cron (current tests use one `:memory:` connection).
- **[P2/M]** Add cron timezone support and document missed-run (no catch-up) behavior.
- **[P3/S]** Enable active KV expiry by default or document the lazy-only leak.

### Sync / replication — 6/10

The sync engine is unusually well-architected for a zero-dependency project: a single in-file append-only change feed drives push/pull, echo prevention is correct, the push read-modify-mark cycle is race-safe, and conflict resolution is atomic. Retry/backoff, partial-ack handling, and tombstone-via-soft-delete are all real and tested. However, the production story has concrete holes: a silent data-loss bug in multi-collection cursor pagination, unbounded growth of both the local feed and remote tombstones, pure wall-clock LWW with no clock-skew warning, and a per-process `versionSeq` that resets on restart. Real-backend tests run in CI but only ever sync a single collection.

**Strengths**
- Correct, clean echo prevention: `source='remote', pushed=1` for remote-applied changes; same-version pulls detected as echoes. (`store.ts:296-307,262-263`)
- Push is race-safe: `pending()` selects MAX(seq) unpushed, `markPushed()` only sets `pushed=1` for `seq <= acked`. (`store.ts:234-243`)
- Conflict decision is atomic inside one `db.transaction`. (`store.ts:256-314`)
- Local-wins convergence: a doc that beats an incoming remote change is re-enqueued so the winning value propagates. (`store.ts:289-291`)
- Real, tested retry/partial-failure: `withRetry` backoff+jitter; Mongo `bulkWrite` `ordered:false` routing failed indices to `rejected`. (`engine.ts:188-208`; `mongo.ts:113-130`)
- Tombstones round-trip via `_monlite_deleted` + a delete row that prevents `seed()` resurrection. (`store.ts:417`)
- Structured collections sync through the same `applyRemoteWrite` path, preserving column/overflow split. (`collection.ts:557-621`)

**Gaps**
- **[Critical]** Version-cursor pagination skips changes across multiple collections under `batchSize`/limit — silent data loss, untested. (`adapters/postgres.ts:115-151`, `mysql.ts:108-146`, `mongo.ts:135-171`; `engine.ts:210-241`)
- **[High]** Change feed and remote tombstones are never compacted/GC'd — unbounded growth degrading every sync round. (`store.ts:105-134,189-213`)
- **[High]** Pure wall-clock LWW with no clock-skew protection or warning. (`version.ts:1-29`; `store.ts:264-274`)
- **[Medium]** `versionSeq` resets to 0 on every restart, breaking the same-ms uniqueness the cursor relies on. (`store.ts:94,165`; `version.ts:15-25`)
- **[Medium]** MySQL/Postgres `_monlite_v` column has no pinned binary collation; SQL `>` may disagree with JS string compare for uppercase nodeIds. (`mysql.ts:69-76,116`; `postgres.ts:74-80,123`)
- **[Low]** Postgres/MySQL push is non-transactional per change and has no live `watch()` (polling only; only Mongo gets change streams). (`postgres.ts:88-113`; `mysql.ts:81-106`)

**Improvements**
- **[P0/M]** Fix multi-collection cursor pagination (per-collection cursors or single ordered merge).
- **[P0/S]** Add a multi-collection + small-batchSize + interleaved-versions integration test on all three backends.
- **[P1/S]** Persist `versionSeq` (or derive from max stored version) on startup.
- **[P1/M]** Document the LWW clock-skew caveat and offer an HLC version mode.
- **[P1/L]** Add tombstone/change-feed compaction with a configurable horizon.
- **[P2/S]** Pin a binary/C collation on the `_monlite_v` column in the PG and MySQL adapters.
- **[P3/L]** Implement `watch()` for Postgres (LISTEN/NOTIFY) and MySQL (binlog).

### Cross-runtime (WASM/Electron) — 6/10

The WASM driver is a genuinely well-crafted adapter: the `db.sqlite` facade normalizes sql.js results so plugins work unchanged in the browser, prepared-statement caching is sound, the `export()` cache-clear is correct, and savepoint-based nested transactions mirror the native drivers. The browser-safety refactors in core are correct and didn't compromise the native path. But the central "browser is just another backend" claim is undermined by one hard defect: core's ESM bundle unconditionally emits `import { createRequire } from 'module'` at the top. Persistence is whole-file export/import only, and the electron cross-window watch refetches on every change without debounce.

**Strengths**
- The `db.sqlite` facade routes `prepare()` through normalized statements returning row objects via `getAsObject()`, so plugins assuming better-sqlite3 semantics work in-browser. (`wasm/src/index.ts:98-108`)
- `export()` clears the statement cache after sql.js finalizes cached statements on serialize, preventing "Statement closed" errors. (`wasm/src/index.ts:207-214`)
- `id.ts` is runtime-agnostic (Web Crypto + Math.random fallback); `isBuffer` guards keep the native fast-path untouched. (`id.ts:18-47`)
- Nested transaction handling (savepoints by depth, defensive full-rollback fallback) faithfully mirrors node:sqlite. (`wasm/src/index.ts:150-204`)
- The electron bridge is minimal and security-gated: explicit method allow-list rejecting `backup()`; renderer Proxy guards against thenable/symbol access. (`electron/src/index.ts:81-87,204`)
- Custom drivers short-circuit driver auto-selection so passing `wasmDriver` never triggers native `require()` at runtime. (`driver/index.ts:69`)

**Gaps**
- **[Critical]** Core ESM bundle hard-imports `node:module` at module top — breaks browser bundling of the wasm path. (`db.ts:12`; `driver/index.ts:1,15`; `dist/index.js:1`; `package.json`)
- **[High]** Persistence is whole-file export/import only — no incremental OPFS/IndexedDB VFS; caps browser DB size at tens of MB. (`wasm/src/index.ts:207-243`)
- **[High]** `@monlite/vector` cannot run on the wasm driver (facade lacks `loadExtension`; sql.js can't load native extensions), silently, with no guard. (`vector/src/index.ts:367,476`; `wasm/src/index.ts:98-108`)
- **[Medium]** Per-write `last_insert_rowid()` round-trip in the wasm driver; rowid narrowed to JS `number` (diverges from native bigint). (`wasm/src/index.ts:110-113,127`)
- **[Medium]** Shared cached sql.js Statement is not re-entrancy safe; undocumented "never interleave the same SQL" invariant. (`wasm/src/index.ts:115-148`)
- **[Medium]** Electron cross-window `watch` refetches the full query on every change, no debounce or diffing — O(watchers) IPC fan-out per write. (`electron/src/index.ts:165-189`)
- **[Medium]** No CI/test coverage for the browser/bundler integration the dimension hinges on. (`wasm/tests/wasm.test.ts:5-21`)

**Improvements**
- **[P0/M]** Make core's ESM bundle browser-clean (dynamic-import native loaders, add a `browser`/`worker` export condition).
- **[P0/M]** Add a Vite/esbuild browser smoke test running in a headless browser.
- **[P1/L]** Ship the `@sqlite.org/sqlite-wasm` OPFS-VFS driver for incremental persistence.
- **[P1/S]** Make `@monlite/vector` fail fast on the wasm driver and document the browser feature matrix.
- **[P2/M]** Debounce and ideally diff electron cross-window watch refetches.
- **[P2/S]** Document the wasm facade's single-statement-per-SQL re-entrancy invariant or add `iterate()`/per-call statements.
- **[P3/S]** Cache `last_insert_rowid` and preserve bigint for large rowids in the wasm facade.

### Quality / DX — 7/10

monlite has notably strong quality-DX fundamentals: ~231 tests across core + 9 packages, including genuinely hard-to-write tests most projects skip — a cross-process SIGKILL crash-consistency test, a cross-process CAS race, property-based query equivalence against an independent oracle, and type-level tests enforced by tsc via `@ts-expect-error`. CI runs both SQLite drivers and macOS/Windows, building first so the crash/CAS tests don't silently skip. The type system is thoughtfully designed and error handling is typed and actionable. The main weaknesses are honesty gaps between docs and tests: headline RAG-scale claims are untested, there's no generated API reference, and self-documented type-inference limitations will surface as DX papercuts.

**Strengths**
- Crash-recovery and concurrency are actually tested: SIGKILL mid-transfer then assert `checkIntegrity()` + fund conservation; 8-process CAS race asserting exactly one winner. (`tests/crash.test.ts`, `tests/cas-cross-process.test.ts`)
- Property-based testing: 25 seeded datasets × 12 random filters against an independent oracle, deterministic mulberry32 PRNG. (`tests/property.test.ts`)
- Type-level inference is real and tsc-enforced: `Projected<T,S>` narrowing, unknown where/orderBy fields error. (`src/types.ts:241-248`; `tests/types.test.ts`)
- Typed error hierarchy with `normalizeDriverError()` reconciling driver shapes and actionable messages. (`src/errors.ts`)
- CI runs the full suite against both drivers on macOS + Windows, building before tests. (`.github/workflows`)
- Zero-dependency core is real; fast (~8s) and currently green.
- Docs are broad and API-accurate; spot-checked README calls match exported signatures.

**Gaps**
- **[High]** Headline RAG-scale and vector-scaling claims are untested (largest test is 20K plain docs; vector tests use a handful of 3-dim vectors). (`README.md:266-267`; `tests/large-dataset.test.ts:18`)
- **[Medium]** Crash/CAS/durability tests silently `it.skip` when `dist` is absent — false-green on the most important guarantees if `pnpm test` runs before a build. (`tests/crash.test.ts:18`)
- **[Medium]** Type inference for operator values and select keys is loose (self-documented): `{ age: { gte: 'x' } }` compiles; typo'd select keys project to nothing. (`tests/types.test.ts:26-30`)
- **[Medium]** No generated/published API reference; ~24 `Collection` methods are discoverable only via source/hovers. (`docs/docs/`)
- **[Low]** Uneven sub-package error-path coverage (cron/electron/studio thinner) and no in-process concurrency stress for core. (`packages/{cron,electron,studio}/tests/`; `src/errors.ts:89-101`)

**Improvements**
- **[P0/M]** Add a 100K-doc and 100K-vector scale test, or soften the README claim to what's proven.
- **[P1/S]** Make crash/CAS tests run from src so they can't silently skip.
- **[P1/M]** Tighten select-key excess checks and operator value types.
- **[P2/M]** Generate and publish an API reference from JSDoc.
- **[P2/M]** Add in-process concurrency stress + fill sub-package error-path tests.

### Perf / scale / security — 6/10

The core CRUD/query engine is genuinely well-engineered for performance: statement caching in both drivers, a cached insert SQL string, batched transactions for bulk writes, parameterized values everywhere, and an honest ~2x raw-SQLite benchmark. The injection surface is small and largely closed. The big gaps are at scale and in the satellite packages: fts/vector `afterWrite` does per-row `getRaw()` + per-row index INSERT outside any transaction; reindex/brute-force paths materialize entire collections into JS; and there are essentially no resource limits, making it unsafe for untrusted multi-tenant input. Encryption-at-rest is correctly wired but undocumented and single-key.

**Strengths**
- Statement caching in both drivers (`STMT_CACHE_MAX=256`) plus a cached `insertSqlCache`.
- `createMany`/`bulkWrite`/`runUpdate`/`runDelete`/`purgeExpired` wrap per-row loops in one `db.transaction()` — one fsync, not N.
- Small, deliberately-defended injection surface: `validateName`, `NAME_RE`/`FIELD_RE`, `bindable()`, `quoteIdent`/`pathLiteral`, parameterizing `$queryRaw`. (`db.ts:18,27`; `query/sql.ts:39,54`)
- The O(n²) bulk-index bug is fixed at the storage layer (IDMAP + vec0 PK). (`fts/index.ts:37`; `vector/index.ts:384`)
- Encryption-at-rest correct: key applied before access and verified, node:sqlite rejects encryption, `rekey()` handles WAL. (`better-sqlite3.ts:112,128`)
- Honest, reproducible benchmark with explicit materialization caveats. (`bench/bench.mjs`)
- Atomic multi-process-safe queue claim with covering index + `recover()`. (`queue/index.ts:318`)
- `explain()` + persisting AutoIndexer for keeping scans off the hot path.

**Gaps**
- **[High]** fts/vector `afterWrite` is an un-batched N+1: per-row `getRaw()` SELECT + per-row index INSERT outside any transaction. (`fts/src/index.ts:113-142,234-239`; `vector/src/index.ts:65-80,396-401`)
- **[High]** No resource limits: no max document/payload size, no query timeout, no result-row cap — a DoS surface. (`collection.ts:688-693,875-901`; `query/where.ts:231-250`)
- **[High]** Full-collection / full-embedding-set materialization with no streaming; every read path is `.all()`. (`fts/index.ts:145-152`; `vector/index.ts:83-88,251-271`)
- **[Medium]** Single shared connection is the whole concurrency model; no pool, writes serialize process-wide. (`db.ts:48-62,225-259`)
- **[Medium]** Dynamic vector store interpolates where/metadata keys validated only at create time, not per query (inconsistent with `@monlite/fts`). (`vector/index.ts:596-655` vs `fts/index.ts:384-419`)
- **[Medium]** Encryption is single-key, undocumented, and not tenant isolation. (`better-sqlite3.ts:111-136`; `db.ts:378-386`)
- **[Low]** `backup()` interpolates the destination path into `VACUUM INTO` (quote-doubled but otherwise unconstrained). (`db.ts:295-299`)
- **[Low]** `createMany`/`bulkWrite` accumulate a whole-batch `ids[]` array in memory. (`collection.ts:645-662,1067-1150`)

**Improvements**
- **[P0/M]** Pass the just-written document into plugin `afterWrite` and batch index writes in one transaction.
- **[P0/M]** Add resource limits: configurable max document size, forced LIMIT / max result rows, query timeout.
- **[P1/M]** Provide a streaming/cursor read API and use it for reindex and brute-force vector search.
- **[P1/S]** Re-validate dynamic vector-store field/where keys at query time (match `@monlite/fts`).
- **[P1/S]** Document encryption-at-rest (multiple-ciphers requirement, rekey, WAL caveat) and add a memory/scale sizing note.
- **[P2/L]** Offer per-process read replicas / a read-only WAL connection for concurrent reads.
- **[P2/S]** Add a bulk-ingest + memory benchmark (100K docs with fts/vector enabled, measure RSS).

## Prioritized roadmap

### P0 — must-fix before claiming production / multi-collection / multi-tenant / browser

| Item | Effort | Why |
|---|---|---|
| Fix multi-collection sync cursor pagination (per-collection cursors or ordered merge) | M | Silent, unrecoverable data loss the moment >1 collection syncs with a backlog. |
| Add a multi-collection + small-batchSize + interleaved-versions integration test on all three backends | S | The highest-severity sync bug is invisible to CI today; cheap, high signal. |
| Make core's ESM bundle browser-clean (dynamic-import native loaders + `browser`/`worker` export condition) | M | The one hard blocker for the entire wasm/"browser is just another backend" story. |
| Add a Vite/esbuild headless-browser smoke test | M | Only thing that would catch the `node:module` defect and OPFS/IndexedDB behavior. |
| Route ALL writes through `txTail`/a write mutex so plain writes can't interleave with `transactionAsync` | M | Closes the isolation hole behind the marketed "atomic ledger posting" guarantee. |
| Make KV `setNX`/`incr` use `BEGIN IMMEDIATE` | S | Makes the advertised cross-process lock/nonce primitive deterministic instead of deadlocking. |
| Over-fetch then filter in the `vector()`/`fts()` where-path | M | Fixes a real recall/correctness bug that returns zero hits when matches exist. |
| Pass the written doc into plugin `afterWrite` and batch index writes in one transaction | M | Removes the N+1 re-read + per-row fsync dominating bulk RAG ingestion. |
| Add resource limits (max document/payload size, forced LIMIT / max rows, query timeout) | M | Blocker for untrusted/multi-tenant input; current DoS surface. |
| Add a 100K-doc + 100K-vector scale test, or soften the README claim | M | The product's reason to exist has zero test evidence at scale. |

### P1 — high-value hardening

| Item | Effort | Why |
|---|---|---|
| Replace wall-clock high-water with a monotonic write cursor for `catchUp` | M | Cross-process freshness can't silently skip writes under clock skew. |
| Add a brute-force fallback to `createVectorStore` and warn on any native→JS downgrade | M | Browser parity for the RAG store; stops a silent 100x latency/memory cliff. |
| Wrap the `fts()` plugin MATCH in try/catch | S | Removes a crash vector on untrusted search input; consistent contract. |
| Persist `versionSeq` (or derive from max stored version) on startup | S | Restores same-ms uniqueness the cursor design depends on. |
| Document the LWW clock-skew caveat and offer an HLC version mode | M | Users replacing Mongo across devices hit silent loss with no warning. |
| Add tombstone/change-feed compaction with a configurable horizon | L | Without GC, every sync round degrades forever on the headline 100K-doc use case. |
| Document at-least-once queue semantics; add idempotency/transactional-completion | M | Prevents silent double-charges/double-sends for BullMQ migrators. |
| Add an optional automatic reaper + per-job heartbeat (visibility timeout) | M | Crashed-worker jobs hang indefinitely; long jobs get wrongly requeued. |
| Add a multi-real-process kv/queue/cron concurrency stress test | M | All current tests use one `:memory:` connection; multi-process claims are unverified. |
| Provide a streaming/cursor read API; use it for reindex and brute-force vector search | M | Caps real corpus size below 100K on memory grounds today. |
| Add a SQL-side fast path for simple `updateMany` (`$set`/`$inc`) | M | The per-row clone+UPDATE loop is the throughput bottleneck at scale. |
| Bound and stream `$lookup`; push `select`/`take` to the foreign side | M | Prevents the memory cliff on large RAG joins. |
| Re-validate dynamic vector-store field/where keys at query time | S | Defense-in-depth matching the stronger `@monlite/fts` pattern. |
| Document encryption-at-rest + add a memory/scale sizing note | S | The feature is hidden; users discover the multiple-ciphers requirement at runtime. |
| Make `@monlite/vector` fail fast on the wasm driver + document the browser feature matrix | S | Prevents architecting a browser RAG app around an absent capability. |
| Ship the `@sqlite.org/sqlite-wasm` OPFS-VFS driver | L | Lifts the tens-of-MB browser ceiling; makes the browser a credible primary store. |
| Make crash/CAS tests run from src so they can't silently skip | S | Removes a false-green on the most important correctness guarantees. |
| Tighten select-key excess checks and operator value types | M | Real Prisma-like-DX papercuts: typo'd select keys silently project to nothing. |

### P2 — quality, latency, and documentation

| Item | Effort | Why |
|---|---|---|
| Build a composable aggregation pipeline, or scope the docs to single-stage | L | Mongo-replacement positioning implies pipeline portability that doesn't exist. |
| Make power-loss durability explicit (default-or-document `synchronous`, durable flush) | S | A committed write can be lost on power loss under WAL NORMAL. |
| Add FTS/vector scale benchmarks (10K/100K ingest + query) | M | Core scaling promises are currently unverified by any benchmark. |
| Add cron timezone support and document missed-run (no catch-up) behavior | M | Local-time-only silently mishandles DST and downtime backfill. |
| Pin a binary/C collation on `_monlite_v` in PG/MySQL adapters | S | Guarantees SQL `>` agrees with JS comparison regardless of DB collation/nodeId casing. |
| Debounce and ideally diff electron cross-window watch refetches | M | Bounds the O(watchers) IPC fan-out per write for multi-window apps. |
| Document the wasm facade re-entrancy invariant or add `iterate()` | S | Prevents a hard-to-debug cursor-corruption bug for plugin authors. |
| Generate and publish an API reference from JSDoc | M | Closes the discoverability gap for the ~24 Collection methods. |
| Add in-process concurrency stress + fill sub-package error-path tests | M | Rounds out the otherwise strong correctness story. |
| Offer per-process read replicas / a read-only WAL connection | L | Single synchronous connection serializes all in-process work, including long scans. |
| Add a bulk-ingest + memory (RSS) benchmark with fts/vector enabled | S | Surfaces the afterWrite N+1 and materialization costs quantitatively. |

### P3 — nice-to-have / future

| Item | Effort | Why |
|---|---|---|
| Implement `watch()` for Postgres (LISTEN/NOTIFY) and MySQL (binlog) | L | Closes the latency gap vs the Mongo adapter for the live-sync story. |
| Extend update operators: predicate `$pull`, array-aware `setPath`, `arrayFilters`/positional | M | Closes common Mongo migration gaps for nested-array edits. |
| Add COLLATE/collation control for ordering/equality on text fields | M | Case/locale-aware sort and equality aren't Mongo-equivalent today. |
| Chunk the `_id IN(...)` where-pushdown for large candidate sets | S | Removes a latent `SQLITE_MAX_VARIABLE_NUMBER` cap. |
| Enable active KV expiry by default or document the lazy-only leak | S | Unread expired keys grow `_kv` unbounded. |
| Cache `last_insert_rowid` and preserve bigint for large rowids in the wasm facade | S | Avoids a second SELECT per mutation and a number-vs-bigint divergence. |

## What would block enterprise / large-scale adoption

- **Multi-collection sync is unsafe today.** The critical cursor-pagination bug means any real deployment syncing more than one collection silently loses data, and it is entirely untested. This alone blocks any production replication claim.
- **No multi-tenancy / untrusted-input story.** No resource limits (document size, query timeout, row cap), single-key file-level encryption (no per-tenant isolation), and full-collection materialization make the engine unsafe behind untrusted input or shared tenants.
- **Transaction-isolation and lock footguns.** Plain writes interleaving with async transactions, and DEFERRED-mode `setNX` deadlocks, contradict the "atomic ledger" / "Redis lock" marketing under real concurrency.
- **Scale claims are unverified.** The headline 10K–100K-doc RAG and "~1M vectors" promises have no test or benchmark evidence; the un-batched ingest N+1 and `.all()`-everywhere reads suggest real memory/throughput ceilings well below the advertised target.
- **Browser story is partially broken.** The `node:module` bundle defect, whole-file-only persistence (tens-of-MB ceiling), and vector search not working in-browser undercut the cross-runtime positioning.
- **Durability defaults and conflict resolution.** WAL NORMAL can lose a committed write on power loss, and pure wall-clock LWW silently loses data under clock skew — both undocumented.
- **Single synchronous connection.** No pool / read replica means all in-process work (including long scans) serializes — a throughput ceiling for server-side deployments.

## Conclusion

monlite is a serious, honest, and unusually well-tested piece of engineering for a zero-dependency embedded database. It gets the genuinely hard parts right where most projects hand-wave: cross-process CAS, crash-consistency under SIGKILL, atomic job/occurrence claims, race-safe sync push, property-based query verification, and a small, deliberately-closed injection surface. The dual-mode document model, RRF hybrid search, and the cross-runtime facade are thoughtful and largely correct. As a single-tenant local/edge store up to roughly tens of thousands of documents, it is already trustworthy and pleasant to use.

What separates it from production-grade at its own stated target is a coherent and addressable cluster of issues rather than architectural rot: a small number of high-leverage correctness bugs (multi-collection sync, search post-filter recall, transaction interleaving, setNX deadlock, the browser bundle), un-batched/un-streamed ingest at scale, missing resource limits for untrusted input, and a gap between marketing claims and test evidence. Notably, the project's own tests and docs already document several of these honestly. None of the P0 items are research problems; they are focused, mostly small-to-medium fixes. Land the P0 roadmap — and verify the scale claims with real benchmarks — and monlite moves from "impressive, honest, single-tenant local store" to a credible Mongo/Redis/BullMQ replacement for the multi-collection, high-throughput RAG workloads it set out to serve. Overall maturity today: **6.3 / 10**.

---

<sub>**Method:** 7 independent evaluators (core-engine, search-rag, ops-primitives, sync-replication, cross-runtime, quality-dx, perf-scale-security) each read the actual source, tests, and docs and returned a structured scorecard; a lead synthesizer merged them. Raw scores: `core-engine`: **7/10** · `search-rag`: **6/10** · `ops-primitives`: **6/10** · `sync-replication`: **6/10** · `cross-runtime`: **6/10** · `quality-dx`: **7/10** · `perf-scale-security`: **6/10**.</sub>
