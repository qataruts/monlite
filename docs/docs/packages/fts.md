---
id: fts
title: "@monlite/fts"
---

# @monlite/fts — full-text search

Keyword search over your documents. The `fts()` plugin adds a single method —
`collection.search(query, opts)` — and runs the **same API on either engine**:

- **SQLite** ([`@monlite/core`](/packages/postgres)): an **FTS5** virtual table kept in sync
  on every write and backfilled on open.
- **Postgres** ([`@monlite/postgres`](/packages/postgres)): a native generated **`tsvector`**
  column + GIN index, maintained by Postgres itself — no separate index table, no indexer,
  no catch-up. Same `collection.search()` call, nothing else to change.

```bash
npm install @monlite/fts
```

## Plugin (document collections)

Pass `fts()` to `createDb` with a map of `collection → searchable fields`. Field paths
support dot-notation, and array/number/boolean fields are coerced to text. Once
configured, `collection.search()` is typed and available wherever `@monlite/fts` is imported.

```ts
import { createDb } from "@monlite/core";
import { fts } from "@monlite/fts";

const db = createDb("app.db", {
  plugins: [fts({ posts: ["title", "body", "tags"] })],
});

await db.collection("posts").create({
  data: { title: "Hello world", body: "first post", tags: ["intro"], status: "published" },
});

const hits = await db.collection("posts").search("hello world");
// hits: Array<Post & { _id: string; _score: number }>  (higher _score = better)
```

Each result is the full document plus a `_score` (higher is more relevant; derived from
the BM25 rank).

### `search(query, opts)`

```ts
interface SearchOptions<T> {
  /** Max results. Default 50. */
  limit?: number;
  /** Additionally constrain matches with a normal monlite where clause. */
  where?: WhereInput<T>;
  /**
   * When `where` is set, how many ranked matches to pull before filtering
   * (then trimmed to `limit`). Larger = better recall for selective filters.
   * Default `max(limit * 10, 200)`, capped at 10,000.
   */
  candidates?: number;
}

type SearchResult<T> = T & { _id: string; _score: number };
```

```ts
// Cap the result count.
await db.collection("posts").search("postgres", { limit: 20 });

// Combine relevance ranking with a structured filter.
await db.collection("posts").search("postgres", {
  where: { status: "published", views: { gte: 100 } },
  limit: 20,
});

// Widen the candidate pool for a very selective filter.
await db.collection("posts").search("postgres", {
  where: { authorId: "u_rare" },
  candidates: 2000,
  limit: 10,
});
```

When a `where` is present, `search()` over-fetches ranked matches, applies the filter, then
trims to `limit` — so a selective filter doesn't drop hits that exist further down the
ranking. The pool defaults to `max(limit * 10, 200)` and is **capped at 10,000** to stay
under SQLite's bound-variable limit. For **exact** pre-filtered recall over a large corpus,
use the [dynamic index](#dynamic-index--createsearchindexdb) below, where the `where` scopes
the MATCH itself.

### Robust against untrusted input

`search()` never throws on malformed or untrusted query text. FTS5 syntax in user input — a
stray `"`, a bare `AND`/`*`, a column filter — would normally throw `fts5: syntax error`; on
error the query is retried with the text quoted as literal phrase tokens, and if that still
fails it returns `[]`.

### How indexing works

- **On open** (`init`): the FTS5 virtual table is created for each configured collection. If
  the index is empty it is backfilled from existing documents (so you can enable FTS on an
  existing database), then `catchUp()` runs to pick up anything other processes wrote.
- **On every write** (`afterWrite`): each created/updated/deleted document id is re-indexed
  incrementally. A `doc_id → rowid` map keeps the per-document re-index `O(log n)`, so bulk
  ingestion stays linear.

### `catchUp()` — cross-process freshness

If a separate process writes documents (e.g. a dedicated ingest worker), a reader's in-memory
high-water mark won't have seen them. Call `catchUp()` on the reader to incrementally index
new/changed documents and drop entries for cross-process deletes:

```ts
const { indexed, removed } = db.collection("posts").catchUp();
```

It indexes anything written since the last high-water mark **and** anything missing from the
index entirely (so past-dated/synced writes don't go unsearchable), and removes index rows
whose document was deleted. On the Postgres engine this is a no-op (`{ indexed: 0, removed: 0 }`)
because Postgres maintains the column itself.

## On Postgres — same API, native `tsvector`

Swap `@monlite/core` for [`@monlite/postgres`](/packages/postgres) and the **same** `fts()`
plugin and `collection.search()` call run on a native, generated `tsvector` column with a GIN
index. The first `search()` lazily and idempotently runs:

```sql
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS _fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(data->>'title','') || ' ' || ...)) STORED;
CREATE INDEX IF NOT EXISTS "posts_fts_idx" ON "posts" USING GIN (_fts);
```

Postgres keeps the column current on every write from any connection, so there is no indexer,
no `afterWrite` hook and no `catchUp`. Queries use **`websearch_to_tsquery`**, so end-user
query operators work out of the box and parse safely (never throw):

- `"exact phrase"` — quoted phrases
- `-word` — negation / exclusion
- `or` — alternation

Ranking uses `ts_rank`, surfaced as the same `_score` field. The only change to move from
SQLite to Postgres is the engine import — the plugin and call site are identical.

## Dynamic index — `createSearchIndex(db)`

The `fts()` plugin attaches `search()` to a **document collection** with a **static** spec.
When you instead need a programmatic full-text index over collections created at **runtime** —
RAG corpora, per-tenant indexes, "give me a searchable index for this id" — use
`createSearchIndex(db)`. Each collection is its own FTS5 table; `fields` are indexed for
search and `filterFields` are stored **UNINDEXED** so a `where` **scopes the MATCH** (exact
keyword search within one case/tenant). It is **synchronous** (raw SQLite, `@monlite/core` only).

```ts
import { createSearchIndex } from "@monlite/fts";

const idx = createSearchIndex(db);

idx.ensureCollection("docs", {
  fields: ["title", "body"],      // indexed for full-text search
  filterFields: ["docId"],        // stored UNINDEXED, for exact `where` scoping
});

idx.upsert("docs", [
  { id: "c1", fields: { title: "Black holes", body: "..." }, filters: { docId: "d1" } },
  { id: "c2", fields: { title: "Neutron stars", body: "..." }, filters: { docId: "d1" } },
]);

// Scoped to one document/tenant — the filter runs inside the MATCH.
const hits = idx.search("docs", "black holes", { where: { docId: "d1" }, limit: 10 });
// hits: Array<{ id: string; score: number }>

idx.delete("docs", { id: "c1" });            // delete one point
idx.delete("docs", { where: { docId: "d1" } }); // delete a whole scope
```

### Surface

```ts
interface SearchIndexOptions {
  /** Text fields indexed for full-text search. */
  fields: string[];
  /** Fields stored UNINDEXED, for exact `where` filtering. Default []. */
  filterFields?: string[];
}

interface SearchIndexPoint {
  id: string;
  /** Indexed text, keyed by configured `fields`. */
  fields: Record<string, string>;
  /** Filter values, keyed by configured `filterFields`. */
  filters?: Record<string, string>;
}

interface SearchIndexHit {
  id: string;
  /** Relevance (higher = better; derived from BM25 rank). */
  score: number;
}

interface SearchIndex {
  ensureCollection(name: string, opts: SearchIndexOptions): void;
  upsert(name: string, points: SearchIndexPoint[]): void;
  search(
    name: string,
    query: string,
    opts?: { limit?: number; where?: Record<string, string> },
  ): SearchIndexHit[];
  delete(name: string, opts: { id?: string; where?: Record<string, string> }): void;
}
```

Notes:

- `upsert` is delete-then-insert by `id`, batched in a single transaction; missing field/filter
  values default to `""`.
- `search` returns `[]` for unknown collections or unparseable queries (never throws);
  `limit` defaults to 50, and `where` entries with `null`/`undefined` values are ignored.
- Collection and field names are validated against `^[A-Za-z_][A-Za-z0-9_]*$`. A reopened index
  recovers its real schema (which columns are searchable vs. filter) from the FTS5 table
  definition, so `ensureCollection` is optional after the first run.

## Hybrid search

Pair with [`@monlite/vector`](/packages/vector) to fuse keyword (FTS) and semantic (vector)
retrieval with Reciprocal Rank Fusion via `hybridSearch()`. A collection with both plugins
configured can be searched both ways and the two rankings merged into one.
