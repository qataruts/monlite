# @monlite/wasm

## 0.1.0

- Initial release. Run `@monlite/core` in the browser (or Node) on SQLite-WASM
  via sql.js, exposed as a custom `Driver` (`wasmDriver(SQL)`). Full document +
  structured query API, aggregation, and transactions. `exportDatabase()` plus
  `wasmDriver(SQL, { data })` provide snapshot persistence (IndexedDB/OPFS);
  incremental OPFS persistence via the official sqlite-wasm is planned.
