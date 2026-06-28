# @monlite/fts

Full-text search for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core), powered by
SQLite's built-in **FTS5**. Adds `collection.search()`.

A monlite plugin — pass it to `createDb`, point it at the fields you want indexed, and it
maintains an FTS5 index automatically on every write, including changes applied by
`@monlite/sync`.

```ts
import { createDb } from "@monlite/core";
import { fts } from "@monlite/fts";

const db = createDb("./app.db", {
  plugins: [fts({ posts: ["title", "body"], users: ["name", "profile.bio"] })],
});

await db.collection("posts").create({
  data: { title: "Hello world", body: "the quick brown fox" },
});

const results = await db.collection("posts").search("quick");
// [ { _id, title, body, _score, … } ]  — ranked, full documents returned
```

## Install

```bash
npm install @monlite/core @monlite/fts
```

No native dependency — FTS5 is built into SQLite, so this works on both monlite backends
(`better-sqlite3` and the built-in `node:sqlite`).

## API

### Plugin

```ts
fts(spec: Record<string, string[]>): MonlitePlugin
```

`spec` maps a collection name to the field paths to index. Dot-notation is supported for nested
fields (e.g. `"profile.bio"`).

### `search`

```ts
collection.search(query: string, {
  limit?: number,           // default 50
  where?: WhereInput<T>,    // combine with a normal monlite filter
}): Promise<Array<WithId<T> & { _score: number }>>
```

- `query` uses FTS5 [MATCH syntax](https://www.sqlite.org/fts5.html#full_text_query_syntax):
  bare terms are AND-ed, `"a phrase"`, `term*` prefix, `a OR b`.
- Results are ordered by relevance; `_score` is higher = better.
- `where` is applied after matching, so you can combine FTS with structured filters.

### Reindex

```ts
import { reindex } from "@monlite/fts";
reindex(db, "posts", ["title", "body"]); // rebuild a collection's index
```

## Dynamic index — `createSearchIndex(db)`

The `fts()` plugin attaches `collection.search()` with a static spec. For a programmatic index
over collections created at runtime — RAG, per-tenant search — use `createSearchIndex(db)`:

```ts
import { createSearchIndex } from "@monlite/fts";

const idx = createSearchIndex(db);
idx.ensureCollection("docs", { fields: ["title", "body"], filterFields: ["docId"] });
idx.upsert("docs", [{ id: "c1", fields: { title, body }, filters: { docId: "d1" } }]);
idx.search("docs", "hello world", { where: { docId: "d1" } }); // scoped to one case/tenant
```

Each collection is its own FTS5 table; `filterFields` are UNINDEXED columns so a `where` scopes
the MATCH without affecting ranking. Synchronous.

## How it works

For each configured collection, the plugin creates an FTS5 virtual table (`<collection>_fts`)
keyed by the document `_id`. It backfills existing documents on `init` (when the index is empty)
and keeps it current via the plugin `afterWrite` hook. Search runs `MATCH` against that table
and returns the live documents in rank order.

## Multi-process freshness

The `afterWrite` hook only sees writes made through its own connection. If a separate process
writes documents (e.g. an ingest worker), call `collection.catchUp()` in the searching process
to incrementally index what changed and reconcile cross-process deletes — no full reindex:

```ts
db.collection("posts").catchUp(); // → { indexed, removed }; call periodically
await db.collection("posts").search("hello");
```

`catchUp` tracks an `updated_at` high-water-mark, so each call only processes new work.

## License

MIT
