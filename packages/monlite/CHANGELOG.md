# monlite

## 0.3.2 — dependency bump

Pulls the Postgres concurrency-hardening fixes from @monlite/core and the operational packages.

## 0.3.1 — dependency bump

Pulls the Postgres-engine review fixes from @monlite/core, @monlite/kv, @monlite/queue,
@monlite/cron, @monlite/fts and @monlite/vector.

## 0.3.0 — Postgres engine helpers in the barrel

Re-exports the Postgres-engine helpers from the operational packages so they're available from the
all-in-one bundle: `createPgQueue` / `PgQueue` (`@monlite/queue`), `createPgCron` / `PgCron`
(`@monlite/cron`), and `pgKv` / `PgKV` (`@monlite/kv`) — alongside their synchronous SQLite
counterparts. Bundles the updated `@monlite/cron` (0.3.0) and `@monlite/kv` (0.5.0).

## 0.2.0 — Postgres engine awareness

- Re-exports `createPgQueue` and `PgQueue` from [`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue)
  alongside `createQueue` / `Queue`, so the Postgres job queue (`SKIP LOCKED`) is available from the
  all-in-one barrel.
- Bundles the updated `@monlite/fts` (0.6.0) and `@monlite/vector` (0.6.0), which now also run on the
  [`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres) engine — same
  `search()` / `findSimilar()` API. To use the Postgres engine itself, install `@monlite/postgres`.

## 0.1.0 — initial all-in-one barrel
