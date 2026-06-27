# @monlite/sync

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
