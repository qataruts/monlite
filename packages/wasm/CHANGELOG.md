# @monlite/wasm

## 0.2.2 — query hook

- **`onQuery` hook** — the wasm driver surfaces executed SQL + duration (parity with
  the native drivers), so a browser app can show a live query log.

## 0.2.1 — browser-safe

- Pairs with `@monlite/core` 2.6.2: the core bundle and the wasm driver are fully
  browser-safe (Web Crypto id generation, guarded `Buffer`, statement-cache clear on
  `export`). Run monlite entirely in the browser with no Node polyfills beyond the
  bundler aliases.

## 0.2.0

- Register the `monlite_regexp` SQL function via sql.js `create_function`, so the
  new core **`regex` where operator** works in the browser too. Requires
  `@monlite/core` ^2.6.0.

## 0.1.2

- Implement `transactionAsync` so `db.transactionAsync` works on the WASM driver.

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release. Run `@monlite/core` in the browser (or Node) on SQLite-WASM
  via sql.js, exposed as a custom `Driver` (`wasmDriver(SQL)`). Full document +
  structured query API, aggregation, and transactions. `exportDatabase()` plus
  `wasmDriver(SQL, { data })` provide snapshot persistence (IndexedDB/OPFS);
  incremental OPFS persistence via the official sqlite-wasm is planned.
