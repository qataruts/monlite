# monlite

## 0.2.0 — Postgres engine awareness

- Re-exports `createPgQueue` and `PgQueue` from [`@monlite/queue`](https://www.npmjs.com/package/@monlite/queue)
  alongside `createQueue` / `Queue`, so the Postgres job queue (`SKIP LOCKED`) is available from the
  all-in-one barrel.
- Bundles the updated `@monlite/fts` (0.6.0) and `@monlite/vector` (0.6.0), which now also run on the
  [`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres) engine — same
  `search()` / `findSimilar()` API. To use the Postgres engine itself, install `@monlite/postgres`.

## 0.1.0 — initial all-in-one barrel
