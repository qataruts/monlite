# @monlite/electron

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release. Share a main-process `@monlite/core` database with renderer
  windows over IPC: `exposeMonlite(db, { ipcMain, broadcast })` in the main
  process and `createRemoteDb(transport)` in the renderer. Forwards an allow-list
  of CRUD/query methods, and `watch()` re-runs across windows on change
  (query-level). `handle.notify(collection)` propagates main-process/sync writes.
