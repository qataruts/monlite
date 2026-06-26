# @monlite/sync

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
