---
id: vector
title: "@monlite/vector"
---

# @monlite/vector — vector / semantic search

Nearest-neighbour search over embeddings. The `vector()` plugin adds a single method —
`collection.findSimilar({ vector, topK, where })` — and runs the **same API on either engine**:

- **SQLite** ([`@monlite/core`](/packages/postgres), opened with `{ allowExtensions: true }`):
  a `sqlite-vec` (`vec0`) index, with a **brute-force JS fallback** when the extension can't
  load (e.g. the SQLite-WASM build in the browser). Kept current on writes.
- **Postgres** ([`@monlite/postgres`](/packages/postgres)): a native generated **`vector(dim)`**
  column + HNSW index (**pgvector**), maintained by Postgres itself — no indexer, no catch-up.

```bash
npm install @monlite/vector
```

## Plugin (document collections)

Pass `vector()` to `createDb` with a map of `collection → { field, dimensions, distance }`.
On SQLite the database must be opened with `allowExtensions: true` so `sqlite-vec` can load.

```ts
import { createDb } from "@monlite/core";
import { vector } from "@monlite/vector";

const db = createDb("app.db", {
  allowExtensions: true,
  plugins: [vector({ docs: { field: "embedding", dimensions: 384, distance: "cosine" } })],
});

await db.collection("docs").create({
  data: { text: "the cat sat", embedding: [/* 384 floats */], status: "live" },
});

const hits = await db.collection("docs").findSimilar({
  vector: queryEmbedding,   // length must equal `dimensions`
  topK: 5,
  where: { status: "live" },
});
// hits: Array<Doc & { _id: string; _distance: number }>  (smaller _distance = closer)
```

Each result is the full document plus a `_distance` (raw metric distance — smaller is closer).

### `VectorField` — per-collection config

```ts
interface VectorField {
  /** Document field holding the embedding (a number[]). Dot-notation allowed. */
  field: string;
  /** Embedding dimensionality (must match your model). */
  dimensions: number;
  /** Distance metric. Default "l2". */
  distance?: "l2" | "cosine";
}
```

Documents without a valid embedding on `field` (wrong length, non-numeric, or missing) are
simply not indexed — you can write the embedding later and it gets picked up on the next write.

### `findSimilar(opts)`

```ts
interface FindSimilarOptions<T> {
  /** Query embedding (length must equal the configured `dimensions`). */
  vector: number[];
  /** Number of nearest neighbours to return. Default 10. */
  topK?: number;
  /** Additionally constrain matches with a normal monlite where clause. */
  where?: WhereInput<T>;
  /**
   * When `where` is set, how many neighbours to pull before filtering
   * (then trimmed to `topK`). Default `max(topK * 10, 200)`.
   */
  candidates?: number;
}

type SimilarResult<T> = T & { _id: string; _distance: number };
```

```ts
// Plain KNN.
await db.collection("docs").findSimilar({ vector: q, topK: 10 });

// KNN + structured filter.
await db.collection("docs").findSimilar({
  vector: q,
  topK: 10,
  where: { status: "live", lang: "en" },
});

// Widen the candidate pool for a very selective filter.
await db.collection("docs").findSimilar({
  vector: q,
  topK: 5,
  where: { tenantId: "rare" },
  candidates: 2000,
});
```

`findSimilar` rejects if `vector.length` isn't exactly the configured `dimensions`. With a
`where`, it over-fetches neighbours then filters and trims to `topK`. The neighbour count is
**capped at 4096** (`sqlite-vec`'s hard `k` limit), so a `topK`/`candidates` above that returns
at most 4096 — for exact recall over a larger pre-filtered set, use the
[dynamic store](#dynamic-store--createvectorstoredb) below (the filter runs **inside** the KNN).
Indexing is linear at scale (the `vec0` table is keyed on `doc_id`).

### Brute-force fallback

When `sqlite-vec` can't load (browser / SQLite-WASM), embeddings are stored as JSON and the
nearest neighbours are computed in JS — **exact** (not approximate), `O(n)` per query, which is
fine for the thousands-of-vectors scale a local/edge store typically holds. The `findSimilar()`
API and results are identical; only the engine underneath changes.

### `catchUp()` — cross-process freshness

If another process writes documents, call `catchUp()` on a reader to incrementally index
new/changed documents and drop entries for cross-process deletes:

```ts
const { indexed, removed } = db.collection("docs").catchUp();
```

On the Postgres engine this is a no-op — Postgres maintains the column itself.

## On Postgres — same API, native pgvector

Swap `@monlite/core` for [`@monlite/postgres`](/packages/postgres) and the **same** `vector()`
plugin and `findSimilar()` call run on a native, generated `vector(dim)` column with an HNSW
index. The first `findSimilar()` lazily and idempotently runs:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "docs" ADD COLUMN IF NOT EXISTS _vec vector(384)
  GENERATED ALWAYS AS ((data->>'embedding')::vector(384)) STORED;
CREATE INDEX IF NOT EXISTS "docs_vec_idx" ON "docs" USING hnsw (_vec vector_cosine_ops);
```

The distance operator follows `distance`: **`<->`** for L2 (`vector_l2_ops`) and **`<=>`** for
cosine (`vector_cosine_ops`), surfaced as the same `_distance` field. Postgres keeps the column
current on every write from any connection, so there is no indexer and no `catchUp`. (HNSW caps
dimensions at ~2000; above that the index is skipped and KNN falls back to an exact scan — still
correct.) The only change to move from SQLite to Postgres is the engine import.

## Dynamic store — `createVectorStore(db)`

The `vector()` plugin indexes an embedding **field** of an existing document collection with a
**static** spec. When you instead need a programmatic store over collections created at
**runtime** — RAG corpora, per-tenant indexes, "give me a vector table for this id" — use
`createVectorStore(db)`. Each collection is its own `vec0` table; `indexedFields` become
filterable metadata columns so a `where` on one is pushed **inside** the KNN (exact pre-filtered
recall, e.g. scoped to one case/tenant even over a large corpus), with full metadata kept in an
auxiliary payload column. **Synchronous**; requires `{ allowExtensions: true }`.

```ts
import { createDb } from "@monlite/core";
import { createVectorStore } from "@monlite/vector";

const db = createDb("rag.db", { allowExtensions: true });
const store = createVectorStore(db);

store.ensureCollection("docs", {
  dimensions: 384,
  metric: "cosine",            // default "cosine"
  indexedFields: ["docId"],    // pushed into the KNN as a pre-filter
});

store.upsert("docs", [
  { id: "c1", vector: emb1, metadata: { docId: "d1", text: "...", page: 1 } },
  { id: "c2", vector: emb2, metadata: { docId: "d1", text: "...", page: 2 } },
]);

const hits = store.search("docs", { vector: q, topK: 5, where: { docId: "d1" } });
// hits: Array<{ id: string; distance: number; metadata: Record<string, unknown> }>

store.delete("docs", { id: "c1" });             // delete one point
store.delete("docs", { where: { docId: "d1" } }); // delete a whole scope
```

### Surface

```ts
interface VectorStoreCollectionOptions {
  /** Embedding dimensionality (must match your model). */
  dimensions: number;
  /** Distance metric. Default "cosine". */
  metric?: "cosine" | "l2";
  /** Metadata fields indexed as filterable columns (exact pre-filtered KNN). Default []. */
  indexedFields?: string[];
}

interface VectorStorePoint {
  id: string;
  vector: number[];
  /** Arbitrary JSON metadata, stored alongside the vector and returned on search. */
  metadata?: Record<string, unknown>;
}

interface VectorStoreHit {
  id: string;
  /** Raw metric distance (smaller = closer): cosine-distance or L2. */
  distance: number;
  metadata: Record<string, unknown>;
}

interface VectorSearchOptions {
  vector: number[];
  /** Nearest neighbours to return. Default 10. */
  topK?: number;
  /**
   * Exact metadata filter ({ field: value }). Fields in `indexedFields` are pushed
   * into the KNN (pre-filtered); others are matched after the KNN (post-filtered).
   */
  where?: Record<string, unknown>;
}

interface VectorStore {
  ensureCollection(name: string, opts: VectorStoreCollectionOptions): void;
  upsert(name: string, points: VectorStorePoint[]): void;
  search(name: string, opts: VectorSearchOptions): VectorStoreHit[];
  delete(name: string, opts: { id?: string; where?: Record<string, unknown> }): void;
}
```

Notes:

- A `where` on a declared `indexedField` runs **inside** the KNN (exact, fast). A `where` on a
  non-indexed metadata key is applied **after** the KNN over an over-fetched candidate pool, so
  declare the fields you filter on as `indexedFields` for exact recall at scale.
- Indexed metadata is stored as text, so filter values are compared as text
  (`{ year: 2021 }` matches the stored `"2021"`).
- Cosine search with an all-zero query vector throws — its distance is undefined (`0/0`).
- `upsert` is delete-then-insert by `id`, batched in a transaction. `search` returns `[]` for
  unknown collections or unparseable queries; the `k` is clamped to `sqlite-vec`'s 4096 limit.
- A reopened store recovers its real schema (indexed columns + metric) from the `vec0` table
  definition, so `ensureCollection` is optional after the first run.

Great to ~1M vectors locally; beyond that keep a dedicated vector DB (e.g. Qdrant) behind the
same interface for scale.

## Hybrid search — `hybridSearch()`

Run keyword (FTS) and semantic (vector) retrieval and fuse the two rankings with **Reciprocal
Rank Fusion**. The collection should have both [`@monlite/fts`](/packages/fts) and
`@monlite/vector` configured; if FTS isn't active it falls back to vector-only.

```ts
import { hybridSearch } from "@monlite/vector";

const hits = await hybridSearch(db.collection("docs"), {
  text: "black holes",
  vector: queryEmbedding,
  topK: 10,
  where: { status: "live" },
});
// hits: Array<Doc & { _id: string; _rrf: number }>  (higher _rrf = better)
```

```ts
interface HybridOptions<T> {
  /** Keyword query (uses @monlite/fts's collection.search, if active). */
  text: string;
  /** Semantic query embedding. */
  vector: number[];
  /** Final number of results. Default 10. */
  topK?: number;
  /** Constrain both arms with a normal monlite where clause. */
  where?: WhereInput<T>;
  /** Candidates pulled from each arm before fusing. Default topK * 4. */
  candidates?: number;
  /** Reciprocal-rank-fusion constant. Default 60. */
  k?: number;
}

type HybridResult<T> = T & { _id: string; _rrf: number };
```

Both arms run in parallel over the same `where`, each contributing `1 / (k + rank)` to a
document's fused score; the top `topK` by fused score are returned with their `_rrf` weight.
