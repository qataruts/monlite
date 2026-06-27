# 🌙 @monlite/vector

> Local vector / semantic search for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core),
> powered by [`sqlite-vec`](https://github.com/asg017/sqlite-vec). Adds
> `collection.findSimilar()` — RAG and AI-agent memory, all in your local `.db`.

A monlite plugin. Store documents with an embedding field, and search by nearest
neighbour. The index is maintained automatically on every write (including
changes applied by `@monlite/sync`).

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
// [ { _id, title, embedding, _distance, … } ]  — nearest first
```

You bring the embeddings (from any model — OpenAI, local, etc.); monlite stores
and searches them.

## Install

```bash
npm install @monlite/core @monlite/vector
```

`@monlite/vector` depends on `sqlite-vec`, which ships prebuilt native binaries.
It works on **both** monlite backends (`better-sqlite3` and `node:sqlite`), but
the database **must** be opened with `{ allowExtensions: true }`.

## API

```ts
vector(spec: Record<string, {
  field: string;              // document field holding the embedding (number[])
  dimensions: number;         // must match your model
  distance?: "l2" | "cosine"; // default "l2"
}>): MonlitePlugin
```

```ts
collection.findSimilar({
  vector: number[],         // query embedding (length === dimensions)
  topK?: number,            // default 10
  where?: WhereInput<T>,    // also constrain with a normal monlite filter
}): Promise<Array<WithId<T> & { _distance: number }>>
```

Results are ordered nearest-first; `_distance` is the raw metric (smaller = closer).
Documents without a valid embedding are simply not indexed.

```ts
import { reindex } from "@monlite/vector";
reindex(db, "docs", { field: "embedding", dimensions: 384 }); // rebuild
```

## How it works

For each configured collection the plugin creates a `sqlite-vec` `vec0` virtual
table keyed by the document `_id`, indexes on `init` (backfilling existing
documents), and keeps it current via the plugin `afterWrite` hook. `findSimilar`
runs a KNN query, then returns the live documents in distance order.

> **Tip — hybrid search:** combine with [`@monlite/fts`](https://www.npmjs.com/package/@monlite/fts)
> (keyword) and re-rank for the best retrieval quality.

## License

MIT 🌙
