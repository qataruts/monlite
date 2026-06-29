# @monlite/vector

## 0.6.0 — Postgres engine support (native pgvector)

`collection.findSimilar()` now runs on the [`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)
engine — same API. On Postgres the embedding is a STORED generated `vector(dim)` column projecting
the configured jsonb field, with an HNSW index (**pgvector**), maintained by Postgres on every write.
KNN uses `<->` (L2) or `<=>` (cosine) per the configured distance. The `sqlite-vec` path is unchanged.
Requires `@monlite/core` ≥ 2.9.0 for the Postgres path.

## 0.5.6 — correctness fixes (bug hunt)

`createVectorStore` (the dynamic store) fixes:

- **Filtering on a numeric `indexedFields` value now works.** Indexed metadata is stored as
  text, but the filter bound the raw number — so `where: { year: 2021 }` matched nothing.
  The filter value is now compared as text, matching how it is stored.
- **A reopened store recovers its indexed fields + metric** from the table definition
  (it was caching empty metadata fields, silently downgrading every filter to the slow
  post-filter path).
- **An all-zero query vector under cosine throws a clear error** instead of producing
  `NaN` distances that corrupt the ranking (L2 still works — its distance is well-defined).
- **`topK` is clamped to sqlite-vec's hard k-limit (4096)**, matching the plugin path, so a
  very large `topK` (or post-filter over-fetch) can't throw "k value too large".

## 0.5.5 — repackage (dependency fix)

- Republished because 0.5.4 shipped with an unresolved `@monlite/core: "workspace:^"` dependency
  (published via npm instead of pnpm), which cannot install outside the monorepo. No code
  change from 0.5.4; the `@monlite/core` range now correctly resolves to `^2.6.x`.

## 0.5.4 — clamp k to sqlite-vec's limit

- **`findSimilar()` no longer throws on a large `topK`/`candidates`.** The vec0 `k` is
  clamped to sqlite-vec's hard maximum (4096), so a big top-K (or over-fetch under a `where`
  filter) returns up to 4096 neighbours instead of erroring.

## 0.5.2–0.5.3 — vector hardening (assessment P0/P1)

- **`where`-filtered `findSimilar()` over-fetches then filters + trims to `topK`**, so a
  selective filter no longer drops nearby matches (tune with `candidates`).
- **vec0 identifier re-validation** on every dynamic-store call.
- Brute-force JS KNN fallback when the `vec0` extension isn't available.

## 0.4.0 — dynamic vector store

- **`createVectorStore(db)`** — a programmatic, **dynamic** vector store (collections
  created at runtime), alongside the existing static `vector()` plugin. `ensureCollection`/
  `upsert`/`search`/`delete` over `vec0`, with the chosen `indexedFields` as metadata
  columns so a `where` is applied **inside** the KNN — **exact pre-filtered recall** (scope to
  one case/tenant even over a large corpus) — and arbitrary metadata in a `+payload` column.
  This is the API for RAG corpora and per-tenant indexes (the plugin needs a static spec).
  Synchronous; requires `{ allowExtensions: true }`. Both drivers.

## 0.3.0

- `collection.catchUp()` + an `updated_at` high-water-mark: incrementally index vectors written by **another process** (and reconcile cross-process deletes) without a full reindex — multi-process ingest → search now works. Indexes on open too.

## 0.2.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.2.0

- **hybridSearch()** — fuse FTS (keyword) + vector (semantic) results with
  Reciprocal Rank Fusion. Falls back to vector-only when FTS is not configured.
- Track @monlite/core ^1.0.0.


## 0.1.0

- Initial release: local vector / semantic search via sqlite-vec. `vector()`
  plugin + `collection.findSimilar({ vector, topK, where })`, automatic index
  maintenance on writes (incl. synced changes), L2 and cosine metrics, and
  `reindex()`. Requires `createDb({ allowExtensions: true })`. Works on both
  monlite backends.
