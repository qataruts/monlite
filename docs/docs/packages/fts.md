---
id: fts
title: "@monlite/fts"
---

# @monlite/fts — full-text search

Keyword search over your documents, backed by SQLite FTS5.

```bash
npm install @monlite/fts
```

## Plugin (document collections)

```ts
import { createDb } from "@monlite/core";
import { fts } from "@monlite/fts";

const db = createDb("app.db", { plugins: [fts({ posts: ["title", "body"] })] });
await db.collection("posts").search("hello world", { where: { status: "published" }, limit: 20 });
```

The plugin keeps the index current on every write and backfills on open. For a
separate ingest process, call `collection.catchUp()` to pick up its writes.

`search()` never throws on malformed/untrusted query text — a stray `"`, bare
`AND`/`*`, or column filter falls back to a literal-phrase match. With a `where`,
it over-fetches ranked matches before filtering so a selective filter doesn't drop
hits that exist further down the ranking; tune the pool with `{ candidates }` (default
`max(limit * 10, 200)`, **capped at 10,000** to stay under SQLite's bound-variable limit).
For **exact** pre-filtered recall over a large corpus, use the
dynamic index below (the `where` scopes the MATCH itself).

## Dynamic index — `createSearchIndex(db)`

When collections are created at runtime (RAG, per-tenant), use the programmatic
index — `fields` are indexed, `filterFields` are stored so a `where` **scopes the
MATCH**:

```ts
import { createSearchIndex } from "@monlite/fts";

const idx = createSearchIndex(db);
idx.ensureCollection("docs", { fields: ["title", "body"], filterFields: ["docId"] });
idx.upsert("docs", [{ id: "c1", fields: { title, body }, filters: { docId: "d1" } }]);
idx.search("docs", "hello world", { where: { docId: "d1" } }); // scoped to one case/tenant
idx.delete("docs", { where: { docId: "d1" } });
```

Pair with [`@monlite/vector`](/packages/vector) for hybrid (keyword + semantic)
search via `hybridSearch()`.
