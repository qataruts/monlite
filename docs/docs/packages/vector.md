---
id: vector
title: "@monlite/vector"
---

# @monlite/vector — vector / semantic search

Local vector search backed by `sqlite-vec`. Open the database with
`{ allowExtensions: true }`.

```bash
npm install @monlite/vector
```

## Plugin (document collections)

```ts
import { createDb } from "@monlite/core";
import { vector } from "@monlite/vector";

const db = createDb("app.db", {
  allowExtensions: true,
  plugins: [vector({ docs: { field: "embedding", dimensions: 384, distance: "cosine" } })],
});
await db.collection("docs").findSimilar({ vector: queryEmbedding, topK: 5, where: { status: "live" } });
```

With a `where`, `findSimilar()` over-fetches nearest neighbours before filtering, so a
selective filter doesn't drop matches that exist further out; tune the pool with
`{ candidates }` (default `max(topK * 10, 200)`). The vec0 neighbour count is **capped at
4096** (sqlite-vec's hard limit), so a `topK` or `candidates` above that silently returns at
most 4096 — for exact recall over a larger pre-filtered set, use the dynamic store (below).
Indexing is linear at scale (vec0 keyed
on `doc_id`) — 50K vectors index in ~8s, KNN in ~14ms. For **exact** pre-filtered recall
over a large corpus, use the dynamic store below (the filter runs **inside** the KNN).

## Dynamic store — `createVectorStore(db)`

For collections created at runtime (RAG corpora, per-tenant indexes) — `where` on
an `indexedField` is applied **inside** the KNN, so a per-case / per-tenant query
stays exact even over a large corpus:

```ts
import { createVectorStore } from "@monlite/vector";

const store = createVectorStore(db);
store.ensureCollection("docs", { dimensions: 384, indexedFields: ["docId"] });
store.upsert("docs", [{ id: "c1", vector: emb, metadata: { docId: "d1", text } }]);
store.search("docs", { vector: q, topK: 5, where: { docId: "d1" } }); // scoped, exact
store.delete("docs", { where: { docId: "d1" } });
```

Great to ~1M vectors locally; beyond that keep a dedicated vector DB (e.g. Qdrant)
behind the same interface for scale.

## Hybrid search

```ts
import { hybridSearch } from "@monlite/vector";
// fuses keyword (FTS) + semantic (vector) with Reciprocal Rank Fusion
await hybridSearch(db.collection("docs"), { text: "quantum", vector: emb, topK: 10 });
```
