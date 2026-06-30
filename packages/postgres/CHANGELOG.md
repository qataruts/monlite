# @monlite/postgres

## 0.1.1 — driver hardening (review fixes)

- `listen()` registers an `error` handler (a dropped LISTEN connection no longer crashes the
  process) and auto-reconnects; closes the client if LISTEN setup fails.
- `runTxn` decrements its savepoint depth exactly once — a throwing COMMIT/RELEASE can no longer
  corrupt the driver — and discards a poisoned client instead of returning it to the pool.
- The `?`→`$N` rewrite is string-literal aware (a `?` inside a JSONB key isn't renumbered).

## 0.1.0 — the Postgres engine for monlite

The same monlite API on a networked **Postgres** (documents as JSONB) instead of a local SQLite
file — swap the engine, not your code. Requires `@monlite/core` ≥ 2.9.0.

- `createDb("postgres://…")`, or `postgres(url)` passed as core's `driver`.
- `PgDriver`: pooled, rewrites `?`→`$1,$2,…`, transactions on a checked-out client with
  `SAVEPOINT`s, top-level transactions serialized, post-commit hooks, and `LISTEN` (dedicated
  connection) for realtime `watch()`.
- Runs the whole data surface: CRUD, the full query language, `aggregate`/`groupBy`/`distinct`,
  realtime `watch()` via `LISTEN/NOTIFY` (cross-process), full-text search (`tsvector`) and vector
  search (pgvector) via `@monlite/fts` / `@monlite/vector`, and the job queue via `@monlite/queue`'s
  `createPgQueue` (`SKIP LOCKED`). Only `explain()` is unsupported.
- A ready-to-use `monlite/postgres` Docker image bundles Postgres 16 + pgvector, preconfigured.
