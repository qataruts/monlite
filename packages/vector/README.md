# @monlite/vector

Vector / semantic search for monlite — RAG and AI-agent memory. Adds `collection.findSimilar()`,
the **same API on either engine**:

- **SQLite** ([`@monlite/core`](https://www.npmjs.com/package/@monlite/core)) — powered by
  [`sqlite-vec`](https://github.com/asg017/sqlite-vec) (with a brute-force JS fallback), all in
  your local `.db`. Index maintained on every write, including `@monlite/sync` changes.
- **Postgres** ([`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)) — a native
  generated `vector(dim)` column + **HNSW** index (**pgvector**), maintained by Postgres itself.

A monlite plugin. Store documents with an embedding field, search by nearest neighbour.

```ts
import { createDb } from "@monlite/core";
import { vector } from "@monlite/vector";

const db = createDb("./app.db", {
  allowExtensions: true, // required: loads the sqlite-vec extension
  plugins: [vector({ docs: { field: "embedding", dimensions: 384 } })],
});

await db.collection("docs").create({
  data: { title: "Black holes", embedding: await embed("Black holes …") },
});

const hits = await db.collection("docs").findSimilar({
  vector: await embed("astrophysics"),
  topK: 5,
  where: { published: true }, // optional structured filter
});
// [ { _id, title, _distance, … } ]  — nearest first
```

You bring the embeddings (from any model — OpenAI, local, etc.); monlite stores and searches them.

## Install

```bash
npm install @monlite/core @monlite/vector
```

`@monlite/vector` depends on `sqlite-vec`, which ships prebuilt native binaries. It works on
both monlite backends (`better-sqlite3` and `node:sqlite`), but the database must be opened with
`{ allowExtensions: true }`.

## API

### Plugin

```ts
vector(spec: Record<string, {
  field: string;               // document field holding the embedding (number[])
  dimensions: number;          // must match your embedding model's output size
  distance?: "l2" | "cosine"; // default "l2"
}>): MonlitePlugin
```

### `findSimilar`

```ts
collection.findSimilar({
  vector: number[],         // query embedding (length must equal dimensions)
  topK?: number,            // number of results (default 10)
  where?: WhereInput<T>,    // combine with a normal monlite filter
}): Promise<Array<WithId<T> & { _distance: number }>>
```

Results are ordered nearest-first; `_distance` is the raw metric (smaller = closer). Documents
without a valid embedding field are not indexed.

### Reindex

```ts
import { reindex } from "@monlite/vector";
reindex(db, "docs", { field: "embedding", dimensions: 384 });
```

## Dynamic store — `createVectorStore(db)`

The `vector()` plugin attaches semantic search to a collection with a static spec. For a
programmatic store over collections created at runtime — RAG corpora, per-tenant indexes,
"give me a vector table for this id" — use `createVectorStore(db)`:

```ts
import { createDb } from "@monlite/core";
import { createVectorStore } from "@monlite/vector";

const db = createDb("./rag.db", { allowExtensions: true });
const store = createVectorStore(db);

store.ensureCollection("docs", { dimensions: 384, indexedFields: ["docId"] });
store.upsert("docs", [{ id: "c1", vector: emb, metadata: { docId: "d1", text } }]);

// where on an indexed field is applied inside the KNN — exact pre-filtered recall
store.search("docs", { vector: q, topK: 5, where: { docId: "d1" } });
store.delete("docs", { where: { docId: "d1" } });
```

Synchronous (raw SQLite). Each collection maps to its own `vec0` table; `indexedFields` become
filterable metadata columns, and the rest of `metadata` rides in a `+payload` column. Scales
well to ~1M vectors locally; beyond that use a dedicated vector database.

## How it works

For each configured collection, the plugin creates a `sqlite-vec` `vec0` virtual table keyed by
the document `_id`, backfills existing documents on `init`, and keeps the index current via the
plugin `afterWrite` hook. `findSimilar` runs a KNN query and returns the live documents in
distance order.

## Multi-process ingest

`afterWrite` only sees writes from its own connection. If a separate process ingests vectors
(the common agent pattern), call `collection.catchUp()` in the searching process to
incrementally index new vectors and reconcile cross-process deletes before querying — no full
reindex needed:

```ts
db.collection("memories").catchUp(); // → { indexed, removed }; call periodically
await db.collection("memories").findSimilar({ vector, topK: 5 });
```

## Hybrid search

Combine keyword (FTS) and semantic (vector) results for the best retrieval quality.
`hybridSearch` runs both and fuses the rankings with Reciprocal Rank Fusion — no score
normalization needed.

```ts
import { createDb } from "@monlite/core";
import { fts } from "@monlite/fts";
import { vector, hybridSearch } from "@monlite/vector";

const db = createDb("./app.db", {
  allowExtensions: true,
  plugins: [
    fts({ docs: ["title", "body"] }),
    vector({ docs: { field: "embedding", dimensions: 384 } }),
  ],
});

const hits = await hybridSearch(db.collection("docs"), {
  text: "black holes",              // keyword arm (FTS)
  vector: await embed("black holes"), // semantic arm (vector)
  topK: 10,
  where: { published: true },       // applied to both arms
});
// [ { _id, title, …, _rrf } ]  — fused, best first
```

If `@monlite/fts` is not configured on the collection, it falls back to vector-only.

## License

MIT
