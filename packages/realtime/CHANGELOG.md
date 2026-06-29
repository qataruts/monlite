# @monlite/realtime

## 0.1.0 — initial release

Networked realtime for `@monlite/core` over Server-Sent Events, backed by the change feed.

- **Server** `realtime({ db | authorize, path?, cors?, heartbeatMs? })` → `.listen(port)` or
  `.handler(req, res)` to attach to an existing server. One SSE stream per subscription; auth +
  per-tenant routing via the `authorize` hook.
- **Client** `connectRealtime(url, { token })` → `collection(name).where().orderBy().take().fields().onSnapshot()`
  and `doc(name, id, cb)`. Auto-reconnect with backoff; fresh snapshot on reconnect. Works in the
  browser and Node ≥ 18 (uses `fetch`, no `EventSource` dependency).
- Zero extra dependencies (`node:http` + `fetch`). Streams `LiveEvent`s (init + `added`/`removed`/
  `changed`/`moved`), including cross-process and synced-in changes.
