# @monlite/fts

## 0.6.2 — review fixes (cold-start race)

Cross-session catalog-race tolerance: `CREATE ... IF NOT EXISTS` setup DDL no longer fails
when multiple processes cold-start on a fresh database at once (it tolerates duplicate
pg_type/table/column and rethrows everything else).

## 0.6.1 — review fixes

Safe chained JSONB path for dotted field names (comma/brace/backslash can't corrupt it); a
transient DDL failure on the first `search()` is no longer cached permanently.

## 0.6.0 — Postgres engine support (native tsvector)

`collection.search()` now runs on the [`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)
engine — same API. On Postgres the searchable text is a STORED generated `tsvector` column over the
configured jsonb fields, with a GIN index, maintained by Postgres on every write (no indexer, no
catch-up). Queries use `websearch_to_tsquery`, so user syntax (`-negation`, `"phrases"`) is parsed
safely. The SQLite FTS5 path is unchanged. Requires `@monlite/core` ≥ 2.9.0 for the Postgres path.

## 0.5.5 — correctness fixes (bug hunt)

- **createSearchIndex recovers the real schema on reopen.** A search()/delete() before
  ensureCollection() cached empty fields, making every later upsert insert an unsearchable
  (empty) row — now the schema is read back from the fts5 table definition.
- **catchUp() also indexes documents missing from the index**, so a doc synced in with a
  past (below-high-water) timestamp no longer stays permanently unsearchable.
- **search({ limit: 0 }) returns 0 results** (was an off-by-one returning 1).

## 0.5.4 — repackage (dependency fix)

- Republished because 0.5.3 shipped with an unresolved `@monlite/core: "workspace:^"` dependency
  (published via npm instead of pnpm), which cannot install outside the monorepo. No code
  change from 0.5.3; the `@monlite/core` range now correctly resolves to `^2.6.x`.

## 0.5.3 — bounded candidate pool

- **`search()` no longer throws on a huge `candidates` value.** With a `where` filter the
  candidate pool feeds an `_id IN (…)` filter; it's now capped (≤10,000) so it can't exceed
  SQLite's bound-variable limit.

## 0.5.1–0.5.2 — search hardening (assessment P0/P1)

- **`where`-filtered `search()` over-fetches then filters**, so a selective filter no longer
  drops matches that exist further down the rank (tune with `candidates`).
- **Crash-safe matching** — a malformed FTS5 `MATCH` query is retried as a quoted phrase
  instead of throwing.
- **Linear bulk indexing** — deletes go through a `doc_id → rowid` map (was O(n²)).

## 0.4.0 — dynamic search index

- **`createSearchIndex(db)`** — a programmatic, **dynamic** full-text index (collections
  created at runtime), alongside the static `fts()` plugin. `ensureCollection({ fields,
  filterFields })`/`upsert`/`search`/`delete` over FTS5; `fields` are indexed and
  `filterFields` are stored UNINDEXED so a `where` **scopes the MATCH** (keyword search within
  one case/tenant). The plugin needs a static spec; this is the API for RAG / per-tenant
  corpora. Synchronous; both drivers.

## 0.2.0

- `collection.catchUp()` + an `updated_at` high-water-mark: incrementally index documents written by **another process** (and reconcile cross-process deletes) without a full reindex — so a separate searcher process stays fresh. Indexes on open too.

## 0.1.3

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.2

- Track @monlite/core ^1.0.0.


## 0.1.1

- Track @monlite/core ^0.10.0 (no code change).


## 0.1.0

- Initial release: SQLite FTS5 full-text search plugin. `collection.search()`,
  automatic index maintenance on writes (incl. synced changes), dot-path fields,
  `where` filtering, and `reindex()`. Works on both monlite backends.
