/**
 * monlite — the whole stack in one install.
 *
 * `import { createDb } from "monlite"` gives you the database; the cache, queue,
 * cron, full-text + vector search, sync and realtime APIs are re-exported here
 * too, and each is also a subpath (`monlite/kv`, `monlite/vector`, …) for the full
 * type surface and selective imports. The browser driver is an optional peer at
 * `monlite/wasm`.
 *
 * Every export is the SAME object as the standalone `@monlite/*` package — this is
 * a thin re-export barrel with no logic of its own. `@monlite/core` stays the
 * minimal zero-dependency install; this package is the batteries-included one.
 */

// The database — full surface (createDb, Collection, types, …).
export * from "@monlite/core";

// Cache + atomic locks + TTLs + pub/sub + sorted sets.
export { kv, type KV, type KVOptions } from "@monlite/kv";

// Durable job queue.
export {
  createQueue,
  Queue,
  type Job,
  type JobStatus,
  type Worker,
  type Handler,
  type QueueOptions,
  type AddOptions,
  type ProcessOptions,
} from "@monlite/queue";

// Persisted cron scheduler (time zones, jitter).
export {
  createCron,
  Cron,
  parseCron,
  nextCronRun,
  type CronOptions,
  type ScheduleOptions,
  type CronHandler,
  type ParsedCron,
} from "@monlite/cron";

// Full-text search (FTS5). The `catchUp`/`reindex` maintenance helpers live on the
// `monlite/fts` subpath — they share names with the vector ones, so only one set
// can sit at the top level.
export {
  fts,
  createSearchIndex,
  type SearchResult,
  type SearchOptions,
  type SearchIndex,
  type SearchIndexOptions,
  type FtsSpec,
} from "@monlite/fts";

// Vector / semantic search (sqlite-vec, with a brute-force JS fallback) — the
// memory layer for AI agents and RAG.
export {
  vector,
  createVectorStore,
  hybridSearch,
  type SimilarResult,
  type HybridResult,
  type HybridOptions,
  type VectorStore,
  type VectorField,
  type VectorSpec,
  type FindSimilarOptions,
  type VectorSearchOptions,
} from "@monlite/vector";

// Local-first replication to MongoDB / PostgreSQL / MySQL.
export {
  sync,
  SyncEngine,
  MongoAdapter,
  PostgresAdapter,
  MySqlAdapter,
  MemoryAdapter,
  MonliteAdapter,
  type SyncOptions,
  type SyncStatus,
  type SyncMode,
  type SyncAdapter,
} from "@monlite/sync";

// Networked realtime (server). The browser client is at `monlite/realtime/client`.
export {
  realtime,
  type RealtimeOptions,
  type RealtimeServer,
  type RealtimeContext,
} from "@monlite/realtime";
