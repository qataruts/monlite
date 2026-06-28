# @monlite/wasm

Run [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) **in the browser** on SQLite
compiled to WebAssembly, via [sql.js](https://sql.js.org).

monlite's driver-adapter seam means the browser is just another backend — the document and
structured collection API, reactive `watch()`, and the kv/queue/cron harness all run unchanged,
in-browser, no server required.

```bash
npm install @monlite/core @monlite/wasm sql.js
```

## Quick start

`initSqlJs` is async (it loads the `.wasm` binary), so initialise it first, then hand the
module to `wasmDriver`. `createDb` itself stays synchronous.

```ts
import initSqlJs from "sql.js";
import { createDb } from "@monlite/core";
import { wasmDriver } from "@monlite/wasm";

const SQL = await initSqlJs({
  locateFile: (file) => `/sqljs/${file}`, // point at where your bundler serves sql-wasm.wasm
});

const db = createDb(":memory:", { driver: wasmDriver(SQL) });

await db.collection("notes").create({ data: { title: "hello", body: "from the browser" } });
const notes = await db.collection("notes").findMany({ where: { title: "hello" } });
```

> **Bundler note:** copy `node_modules/sql.js/dist/sql-wasm.wasm` to a served path and return
> it from `locateFile`. For Vite, put it in `public/sqljs/`.

## Persistence

sql.js holds the database in memory. To persist it across page loads, snapshot the bytes to
IndexedDB (or OPFS) and restore them on startup:

```ts
import { wasmDriver, exportDatabase } from "@monlite/wasm";

// On startup: restore from IndexedDB if a previous snapshot exists
const saved = await idbGet("monlite-db"); // Uint8Array | undefined
const db = createDb(":memory:", { driver: wasmDriver(SQL, { data: saved }) });

// After writes (debounced) or on beforeunload: persist
async function persist() {
  await idbSet("monlite-db", exportDatabase(db));
}
```

A reactive debounce works well here: subscribe with `collection.watch()` and call `persist()` on
a trailing debounce after each change.

## Sync with the server

A monlite WASM database uses the same SQLite format as the Node backends, so it syncs with a
server or another device through [`@monlite/sync`](https://www.npmjs.com/package/@monlite/sync)
like any other monlite database.

## Notes

- sql.js runs in Node as well, so `@monlite/wasm` is covered by the normal test suite.
- Snapshotting rewrites the whole file, which is fine up to tens of MB. For larger, write-heavy
  databases the planned next step is a driver over `@sqlite.org/sqlite-wasm` with the OPFS VFS
  (incremental persistence via a Web Worker). Same `Driver` interface, drop-in.

## License

MIT
