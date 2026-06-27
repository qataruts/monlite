# @monlite/wasm

Run [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) **in the browser** (or anywhere) on SQLite compiled to WebAssembly, via [sql.js](https://sql.js.org). monlite's driver-adapter seam means the browser is just another backend — the document/structured query API, reactivity, and the kv/queue/cron harness all run unchanged.

```bash
npm install @monlite/core @monlite/wasm sql.js
```

## Quick start

`initSqlJs` is async (it loads the `.wasm`), so initialise it first, then hand the
module to `wasmDriver` — `createDb` itself stays synchronous:

```ts
import initSqlJs from "sql.js";
import { createDb } from "@monlite/core";
import { wasmDriver } from "@monlite/wasm";

const SQL = await initSqlJs({
  // point at where your bundler serves sql-wasm.wasm
  locateFile: (file) => `/sqljs/${file}`,
});

const db = createDb(":memory:", { driver: wasmDriver(SQL) });

await db.collection("notes").create({ data: { title: "hello", body: "from the browser" } });
const notes = await db.collection("notes").findMany({ where: { title: "hello" } });
```

> Bundlers: copy `node_modules/sql.js/dist/sql-wasm.wasm` to a served path and
> return it from `locateFile`. (Vite: put it in `public/sqljs/`.)

## Persistence

sql.js holds the database in memory. Persist it by **snapshotting the bytes** to
IndexedDB (or OPFS) and reopening from them — `exportDatabase()` gives you the
bytes, and `wasmDriver(SQL, { data })` restores them:

```ts
import { wasmDriver, exportDatabase } from "@monlite/wasm";

// On startup: restore previous bytes (your IndexedDB getter), if any.
const saved = await idbGet("monlite-db"); // Uint8Array | undefined
const db = createDb(":memory:", { driver: wasmDriver(SQL, { data: saved }) });

// After writes (debounced) or on `beforeunload`: snapshot back.
async function persist() {
  await idbSet("monlite-db", exportDatabase(db));
}
```

A small reactive debounce works well: persist after a quiet period following any
write (e.g. subscribe with `collection.watch(...)` and call `persist()` on a
trailing debounce).

### Roadmap: incremental OPFS persistence

Snapshotting rewrites the whole file, which is fine up to tens of MB. For larger,
write-heavy databases the planned next step is a driver over the **official
`@sqlite.org/sqlite-wasm` with the OPFS VFS** (running in a Web Worker with
synchronous access handles), which persists **incrementally** — no full-file
re-export. Same `Driver` seam, drop-in. (Tracked on the roadmap.)

## Notes

- sql.js runs in Node as well, so this driver is covered by the normal test suite.
- A monlite WASM database is the same SQLite format as the Node backends, so it
  syncs with a server (or another device) through [`@monlite/sync`](https://www.npmjs.com/package/@monlite/sync) like any other monlite database.

MIT
