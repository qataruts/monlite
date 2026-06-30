---
id: wasm
title: "@monlite/wasm"
---

# @monlite/wasm — monlite in the browser

Run monlite in the browser on **SQLite-WASM** (sql.js) through a custom
[`Driver`](../core/documents). The whole document / query / structured /
transaction API is identical to the server — only the driver changes. The same
`.db` bytes move between the browser and Node.

```bash
npm install @monlite/wasm sql.js
```

```ts
import initSqlJs from "sql.js";
import { createDb } from "@monlite/core";
import { wasmDriver, exportDatabase } from "@monlite/wasm";

// 1. Initialise sql.js yourself (async), then build the driver (sync).
const SQL = await initSqlJs({ locateFile: (f) => `/sql-wasm/${f}` });
const db = createDb(":memory:", { driver: wasmDriver(SQL) });

// 2. Use monlite exactly as on the server.
await db.collection("notes").create({ data: { text: "hello from the browser" } });
const notes = await db.collection("notes").findMany({ where: { text: { contains: "hello" } } });

// 3. Persist a snapshot and reopen it later.
const bytes = exportDatabase(db);                                  // Uint8Array
const db2 = createDb(":memory:", { driver: wasmDriver(SQL, { data: bytes }) });
```

`createDb` always takes `":memory:"` here — sql.js itself is in-memory, so the
file path is unused; the driver holds the database. Persistence is explicit (see
below).

## API

```ts
wasmDriver(SQL, options?)        // build a Driver from an initialised sql.js module
exportDatabase(db)               // Uint8Array — serialize the whole database
new WasmDriver(SQL, options?)    // the class behind wasmDriver()
```

### `WasmDriverOptions`

| Option | Meaning |
|---|---|
| `data` | existing database bytes to open (e.g. restored from IndexedDB / OPFS) |
| `onQuery` | `({ sql, durationMs }) => void` — called after every statement; mirrors `createDb`'s `onQuery`, which doesn't reach a user-supplied driver. Useful for an in-browser query log. |

The driver also exposes a better-sqlite3-compatible escape hatch as `db.sqlite`
(`prepare` / `exec` / `run` / `export` / `create_function`, plus `raw` for the
underlying sql.js handle) so the FTS, vector, and kv plugins work unchanged.

## Persistence (IndexedDB / OPFS)

sql.js keeps the database in memory; nothing is saved until you serialize it with
`exportDatabase(db)` and write the bytes somewhere durable. On startup, read them
back and pass them as `{ data }`.

```ts
// Save — call after writes (debounce in a real app), e.g. to IndexedDB via idb-keyval:
import { set, get } from "idb-keyval";
await set("app.db", exportDatabase(db));

// Restore on next load:
const saved = (await get("app.db")) as Uint8Array | undefined;
const db = createDb(":memory:", { driver: wasmDriver(SQL, { data: saved ?? null }) });
```

OPFS works the same way — write the `Uint8Array` to an OPFS file with a
`FileSystemWritableFileStream`, and read it back on load. Either way the unit of
persistence is the **whole database snapshot**, so debounce saves on bursty
write workloads.

## Bundling for the browser

`@monlite/core` loads the native Node drivers via `node:module`, which only runs
on the Node path — but a bundler still needs it stubbed for a browser build.
Alias these in your bundler (see the demo's `vite.config.ts`):

```ts
// vite.config.ts → resolve.alias
"node:module": "/path/to/empty-stub.js",   // @monlite/core native-driver loader
"sqlite-vec":  "/path/to/empty-stub.js",   // @monlite/vector (uses its JS fallback)
"events":      "/path/to/events-shim.js",  // @monlite/queue & cron (Node EventEmitter)
```

## What works in the browser

`@monlite/core` (documents, queries, structured collections, transactions,
`watch()`), plus `@monlite/kv`, `@monlite/queue`, and `@monlite/cron`, all run on
the WASM driver unchanged. Two plugins need attention:

### Full-text search (FTS5)

`@monlite/fts` works in the browser — **but the default `sql.js` build ships
without the FTS5 extension** (`CREATE VIRTUAL TABLE … USING fts5` fails with
"no such module: fts5"). Use a SQLite-WASM build compiled with FTS5, such as
[`fts5-sql-bundle`](https://www.npmjs.com/package/fts5-sql-bundle) — a drop-in
for `sql.js` with the same `initSqlJs` API:

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

### Vector search

`@monlite/vector` (0.5.0+) works in the browser too. When the native `vec0`
extension (sqlite-vec) can't be loaded — as in SQLite-WASM — `findSimilar()`
transparently falls back to an exact brute-force JS implementation (cosine / L2
over a plain table). No config; same API:

```ts
import { vector } from "@monlite/vector";

const db = createDb(":memory:", {
  driver: wasmDriver(SQL),
  plugins: [vector({ docs: { field: "embedding", dimensions: 384, distance: "cosine" } })],
});
await db.collection("docs").findSimilar({ vector: queryEmbedding, topK: 5 });
```

The fallback is O(n) per query (exact, not approximate) — right for the
thousands-of-vectors scale a local / edge store holds. Alias the native
`sqlite-vec` module to a stub in your bundle (it's only used on the Node path).

## Limits

- **In-memory.** No automatic persistence — you serialize and store snapshots
  yourself (above). Reads and writes are fast, but a large database lives entirely
  in browser memory.
- **One writer.** A single sql.js instance per tab; there's no cross-tab shared
  connection. Use a `SharedWorker`, or serialize through one tab, if multiple
  tabs must write.
- **Extensions** (FTS5, sqlite-vec) depend on the WASM build — FTS5 needs a
  bundle that includes it; vector uses the JS fallback.

The live [demo](https://qataruts.github.io/monlite/demo) runs exactly this — an
in-browser document store with FTS5 search and on-device embeddings (via
Transformers.js), no server. Use this for offline-first web apps, local-first
PWAs, and in-browser demos.
