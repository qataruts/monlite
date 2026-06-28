# @monlite/sync

## 1.3.4 — repackage (dependency fix)

- Republished because 1.3.3 shipped with an unresolved `@monlite/core: "workspace:^"` dependency
  (published via npm instead of pnpm), which cannot install outside the monorepo. No code
  change from 1.3.3; the `@monlite/core` range now correctly resolves to `^2.6.x`.

## 1.3.3 — cursor decode hardening

- **A corrupt/truncated per-collection cursor now restarts cleanly.** A `{`-led cursor that
  failed to parse previously fell through to the legacy branch and became a high scalar floor
  (`"{…"` sorts above any digit-led version) that silently stalled the sync forever. It now
  starts fresh — re-pulling is safe under last-write-wins.

## 1.3.1–1.3.2 — multi-collection correctness (assessment P0/P2)

- **Per-collection cursors** for the version-cursor adapters (Postgres/MySQL/Mongo): a single
  global cursor could permanently skip a lagging collection's rows. Each collection now only
  advances past what it returned (legacy scalar cursors upgrade transparently).
- **Byte-order collation** pinned on `_monlite_v` comparisons so version paging is consistent
  regardless of the column's default collation.

## 1.3.0 — resilient rounds (retry + partial-failure safety)

- **Per-operation retries** — a failed `pull`/`push` now retries with exponential
  backoff + jitter (`retries`, default 4; `retryBaseMs`, default 200) before the
  round fails, instead of waiting a full poll interval. Also makes one-shot
  `engine.sync()` resilient. Safe because `pull` is read-only and `push` is
  idempotent (LWW). Each attempt emits a **`retry`** event
  (`{ label, attempt, delayMs, error }`).
- **Partial-failure guarantee (now tested)** — a change is marked pushed only on
  remote ack; unacked changes (including after exhausted retries) stay queued and
  re-send next round. Re-sends are idempotent (a remote-applied-but-unacked push
  reconciles, not duplicates); the pull cursor advances only after a batch fully
  applies. New robustness suite covers transient pull/push recovery, exhausted
  retries (no data loss), retry events, and partial acks.

## 1.2.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 1.2.0 — MySQL adapter

- **`MySqlAdapter`** — replicate against MySQL (and MariaDB). Each collection
  maps to a `json` table; push upserts via `INSERT … ON DUPLICATE KEY UPDATE`
  with soft-deletes, pull reads rows past a `_monlite_v` cursor. `mysql2` is an
  optional peer dependency. Covered by live integration tests (gated on
  `MYSQL_URL`, run in CI).

## 1.1.0 — Postgres adapter

- **`PostgresAdapter`** — replicate against PostgreSQL. Each collection maps to a
  `jsonb` table; push upserts via `INSERT … ON CONFLICT (_id) DO UPDATE` with
  soft-deletes, pull reads rows past a `_monlite_v` cursor. Local monlite stays
  the embedded runtime; Postgres is the cloud of record. `pg` is an optional peer
  dependency. Covered by live integration tests (gated on `PG_URL`).

## 1.0.0 — stable

First stable release; tracks @monlite/core ^1.0.0. No code changes from 0.3.x.


## 0.3.3

- Track @monlite/core ^0.10.0 (no code change).


## 0.3.2

- Track `@monlite/core` ^0.9.0 (plugin system; no sync changes).

## 0.3.1

- Track `@monlite/core` ^0.8.0 (reactivity also fires for synced-in changes).

## 0.3.0 — structured sync + live MongoDB tests

- **Structured collections sync** end to end (native columns preserved). Open
  the collection with its `schema` on each node before syncing.
- **Live MongoDB integration tests** against a real replica set: push, pull,
  two-way convergence, soft-delete propagation, and **change streams**. Run in
  CI's `mongo` job and locally via `MONGO_URL`.
- `collections: "*"` now resolves to the concrete local collection list before
  pulling, so it works with the Mongo adapter (which can't enumerate "all").
- Requires `@monlite/core` ^0.7.0.

## 0.2.0 — robustness

- **Backoff**: the poll loop now retries with exponential backoff + jitter (up to
  ~60s) on failure instead of a fixed cadence, and surfaces `failures` in `status()`.
- **Crash-safe**: an `error` emit with no listener no longer crashes the host
  process (a default no-op listener is always attached).
- **Batching**: `batchSize` option (default 500) bounds how many changes move per
  pull/push round; large backlogs drain over multiple rounds.
- **Validation**: unknown `conflict` strategies throw instead of silently
  defaulting.
- **Mongo adapter**: honors the pull `limit`; on a partial `bulkWrite` failure it
  acks only the survivors and routes failed ops to `rejected` (no silent data loss).
- Requires `@monlite/core` ^0.6.0 (atomic `applyRemote`, unique versions).

## 0.1.0
- Initial release: `SyncEngine` (pull / push / two-way / live, LWW + pluggable
  conflict resolution, events, `status()`) with `MongoAdapter`, `MonliteAdapter`,
  and `MemoryAdapter`.
