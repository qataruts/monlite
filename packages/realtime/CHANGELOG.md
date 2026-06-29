# @monlite/realtime

## 0.2.0 — hardening + `onError` (audit fixes)

Additive + bug fixes from an internal audit. Backward-compatible.

- **Fixes an unauthenticated subscription leak (DoS).** If a client disconnected _while_ an async
  `authorize()` was still pending, the watch handle + heartbeat were never torn down. Cleanup is
  now attached before authorize runs, and the stream re-checks for a disconnect before opening.
- **Validates request params before opening the stream.** A `/doc` request missing `id` (or a
  `/query` with un-parseable `q`) now returns a clean `400` instead of an in-band error written
  onto an already-opened SSE stream.
- **Liveness guards now also check `res.destroyed`**, so sends and the heartbeat stop promptly on
  an abrupt socket drop (not only a graceful end).
- **Client: `onError` option** — a server-sent `{ error }` frame is routed to `onError`
  (default `console.error`) instead of being mis-delivered as a `null` document or a malformed
  snapshot event. Defaults preserve existing behavior.
- **Client: SSE parser tolerates `LF`, `CRLF` and `CR`** frame/line separators (some proxies
  rewrite line endings), and skips malformed frames without tearing down the stream.

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
