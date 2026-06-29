---
id: ai-agent-backend
title: The local AI-agent backend
---

# The local AI-agent backend

A coding agent or RAG app needs the same handful of local services: a document
store, vectors, a cache, a durable job queue, and a scheduler. monlite is all of
them in **one `.db` file** — no Docker, no Redis, no Qdrant.

| Need | monlite |
|---|---|
| Documents / state | [`@monlite/core`](/core/documents) |
| Semantic memory / RAG | [`@monlite/vector`](/packages/vector) |
| Keyword search | [`@monlite/fts`](/packages/fts) |
| Cache & locks | [`@monlite/kv`](/packages/kv) |
| Durable jobs | [`@monlite/queue`](/packages/queue) |
| Scheduling | [`@monlite/cron`](/packages/cron) |

## A durable jobs tier

The pattern behind agent task execution: a worker claims a job exactly once
(across processes) with compare-and-swap, runs a step, and records progress.

```ts
// Claim — cross-process safe; a racing worker gets null, not an error
const job = await jobs.findOneAndUpdate({
  where: { _id: id, status: "pending", version: v },
  data: { $set: { status: "active" }, $inc: { version: 1 } },
  returnDocument: "after",
});
```

Pair it with [`@monlite/queue`](/packages/queue) for the work queue,
[`@monlite/kv`](/packages/kv) `setNX` for single-flight locks/nonces, and
compound-unique indexes for idempotency — a durable job/mission/approval engine
on a single file, no Mongo or Redis.

## RAG in one file

```ts
const store = createVectorStore(db);   // @monlite/vector
store.ensureCollection("kb", { dimensions: 384, indexedFields: ["docId"] });
store.upsert("kb", chunks.map((c) => ({ id: c.id, vector: c.embedding, metadata: c.meta })));
store.search("kb", { vector: q, topK: 5, where: { tenantId } }); // scoped, exact
```

Scoped retrieval (`where`) is applied **inside** the KNN, so per-tenant /
per-document queries stay exact even over a large corpus. Add
[`@monlite/fts`](/packages/fts) for hybrid keyword+semantic search.

## Cross-language pipelines

Because everything is one SQLite file, a **Python worker and a Node agent can
share it** — Python ingests and embeds, Node serves; both hit the same cache and
queue. See [Python](/reference/python).
