---
id: wasm
title: "@monlite/wasm"
---

# @monlite/wasm — monlite in the browser

Run monlite in the browser on SQLite-WASM (sql.js) via a custom driver. Same API
as on the server.

```bash
npm install @monlite/wasm sql.js
```

```ts
import initSqlJs from "sql.js";
import { createDb } from "@monlite/core";
import { wasmDriver, exportDatabase } from "@monlite/wasm";

const SQL = await initSqlJs({ locateFile: (f) => `/sql-wasm/${f}` });
const db = createDb(":memory:", { driver: wasmDriver(SQL) });

await db.collection("notes").create({ data: { text: "hello from the browser" } });

// Persist a snapshot (e.g. to IndexedDB / OPFS) and reload it
const bytes = exportDatabase(db);          // Uint8Array
const db2 = createDb(":memory:", { driver: wasmDriver(SQL, { data: bytes }) });
```

The whole document/query/structured/transaction API works in the browser, as do
`@monlite/kv`, `@monlite/queue`, and `@monlite/cron`.

### Bundling for the browser

`@monlite/core` loads the native drivers via `node:module`, which only runs on the
native (Node) path — but bundlers still need it stubbed for a browser build. Alias
these in your bundler (see the demo's `vite.config.ts`):

```ts
// vite.config.ts → resolve.alias
"node:module": "/path/to/empty-stub.js",   // @monlite/core native-driver loader
"sqlite-vec":  "/path/to/empty-stub.js",   // @monlite/vector (uses its JS fallback)
"events":      "/path/to/events-shim.js",  // @monlite/queue & cron (Node EventEmitter)
```

## Full-text search (FTS5) in the browser

`@monlite/fts` works in the browser too — **but the default `sql.js` build ships
without the FTS5 extension** (`CREATE VIRTUAL TABLE … USING fts5` fails with
"no such module: fts5"). Use a SQLite-WASM build compiled with FTS5, such as
[`fts5-sql-bundle`](https://www.npmjs.com/package/fts5-sql-bundle) (a drop-in for
`sql.js`, same `initSqlJs` API):

```ts
import initSqlJs from "fts5-sql-bundle/dist/sql-wasm.js";
import { createDb } from "@monlite/core";
import { wasmDriver } from "@monlite/wasm";
import { fts } from "@monlite/fts";

const SQL = await initSqlJs();
const db = createDb(":memory:", {
  driver: wasmDriver(SQL),
  plugins: [fts({ docs: ["title", "body"] })],
});
await db.collection("docs").search("hello world"); // FTS5, in the browser
```

The live [demo](https://qataruts.github.io/monlite/demo) runs exactly this — an
in-browser document store with FTS5 search, no server.

## Vector search in the browser

`@monlite/vector` (0.5.0+) also works in the browser. When the native `vec0`
extension (sqlite-vec) can't be loaded — as in SQLite-WASM — `findSimilar()`
transparently falls back to an exact brute-force JS implementation (cosine/L2
over a plain table). No config needed; it's the same API:

```ts
import { vector } from "@monlite/vector";

const db = createDb(":memory:", {
  driver: wasmDriver(SQL),
  plugins: [vector({ docs: { field: "embedding", dimensions: 384, distance: "cosine" } })],
});
await db.collection("docs").findSimilar({ vector: queryEmbedding, topK: 5 });
```

It's O(n) per query (exact, not approximate) — ideal for the thousands-of-vectors
scale a local/edge store holds. The demo computes embeddings on-device with
Transformers.js, so semantic search runs end-to-end with no server.

> In a browser bundle, alias the native `sqlite-vec` module to a stub (it's only
> used on the native path); see the demo's `vite.config.ts`.

Use this for offline-first web apps, local-first PWAs, and in-browser demos.
