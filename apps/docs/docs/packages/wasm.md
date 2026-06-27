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

The whole document/query/structured/transaction API works in the browser. Vector
and FTS depend on native SQLite extensions, so they are server-side only;
documents, kv, queue, and cron run anywhere sql.js runs.

Use this for offline-first web apps, local-first PWAs, and in-browser demos.
