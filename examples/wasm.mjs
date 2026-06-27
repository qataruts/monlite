// monlite on SQLite-WASM (the browser backend) — runs in Node too. Run: node wasm.mjs
import initSqlJs from "sql.js";
import { createDb } from "@monlite/core";
import { wasmDriver, exportDatabase } from "@monlite/wasm";

// In a browser you'd pass { locateFile: (f) => `/sqljs/${f}` }.
const SQL = await initSqlJs();
const db = createDb(":memory:", { driver: wasmDriver(SQL) });
console.log("🌐 backend:", db.driver.name);

await db
  .collection("notes")
  .create({ data: { _id: "n1", title: "from wasm" } });
console.log("📝 doc:", (await db.collection("notes").findById("n1")).title);

// Snapshot persistence — these bytes would go to IndexedDB/OPFS in the browser.
const bytes = exportDatabase(db);
const restored = createDb(":memory:", {
  driver: wasmDriver(SQL, { data: bytes }),
});
console.log(
  "💾 restored from",
  bytes.length,
  "bytes:",
  (await restored.collection("notes").findById("n1")).title,
);

await db.$disconnect();
await restored.$disconnect();
