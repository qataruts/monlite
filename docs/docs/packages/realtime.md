---
id: realtime
title: "@monlite/realtime"
---

# @monlite/realtime — networked live queries

Stream live queries and single documents to remote clients — browser, mobile,
other services — over **Server-Sent Events**, backed by `@monlite/core`'s
`watch()` / [change feed](../core/realtime). Your database stays embedded in your
service; this package puts a realtime API in front of it. Zero extra dependencies
— built on `node:http` on the server and `fetch` on the client.

```bash
npm install @monlite/realtime
```

```ts
import { createDb } from "@monlite/core";
import { realtime } from "@monlite/realtime";

const db = createDb("./app.db", { changefeed: true });
realtime({ db }).listen(8080);
```

```ts
import { connectRealtime } from "@monlite/realtime/client";

const live = connectRealtime("http://localhost:8080");
live.collection("orders").where({ status: "open" }).onSnapshot(({ results }) => render(results));
```

## Server

`realtime(options)` returns a `RealtimeServer` you can either run standalone or
mount onto an existing HTTP server. It exposes two endpoints under `path`
(default `/realtime`): `…/query` for live queries and `…/doc` for single-document
listeners.

```ts
import { createDb } from "@monlite/core";
import { realtime } from "@monlite/realtime";

const db = createDb("./app.db", { changefeed: true });

// Single database — serve it for every request (no auth):
realtime({ db }).listen(8080);

// Per-tenant + auth — resolve which db from the request (return null to reject → 401):
realtime({
  authorize: async (req) => {
    const tenant = await verify(req.headers.authorization);  // or the ?token= query param
    return tenant ? { db: dbForTenant(tenant) } : null;
  },
}).listen(8080);
```

Provide exactly one of `db` (single-database shortcut) or `authorize` (resolve a
context per request). With neither, every request is rejected with `401`.

Attach the handler to your own server or framework instead of `listen()`:

```ts
import http from "node:http";

const rt = realtime({ db });
http.createServer((req, res) => {
  if (req.url?.startsWith("/realtime")) return rt.handler(req, res);
  // ... your other routes
}).listen(8080);
```

### `RealtimeOptions`

| Option | Default | Meaning |
|---|---|---|
| `db` | — | single-database shortcut (no auth) |
| `authorize(req)` | — | resolve `{ db }` per request, or return `null`/throw → `401` |
| `path` | `"/realtime"` | base path for the `…/query` and `…/doc` endpoints |
| `cors` | `"*"` | `Access-Control-Allow-Origin` value, or `false` to disable CORS |
| `heartbeatMs` | `25000` | keep-alive comment interval (keeps idle connections open) |

### `RealtimeServer`

```ts
const rt = realtime({ db });
rt.handler;          // (req, res) => void — mount on your own server
rt.listen(8080);     // start a standalone http.Server
rt.subscriptions;    // active subscription count
rt.close();          // stop all subscriptions (does not close the http server)
```

The handler validates request params **before** authorizing or opening the
stream (a bad request is a clean `400`, not an in-band error on an open stream),
and tears every subscription down on disconnect — including a client that drops
mid-authorization — so watch handles and heartbeats never leak.

## Client (browser or Node ≥ 18)

`connectRealtime(baseUrl, opts)` returns a `RealtimeClient`. It uses `fetch` for
the SSE stream, so it runs in the browser and in Node ≥ 18.

```ts
import { connectRealtime } from "@monlite/realtime/client";

const live = connectRealtime("https://api.example.com", { token });

// Live query — chainable builder, then .onSnapshot()
const stop = live
  .collection("orders")
  .where({ status: "open" })
  .orderBy({ createdAt: "desc" })
  .take(50)
  .onSnapshot(({ type, results, added, removed, changed, moved }) => render(results));

// Live single document — null while absent / on delete
const stopDoc = live.doc("orders", "o-123", (doc) => render(doc));

// Only re-emit when one of these fields changes (server-side filter)
live.collection("orders").fields(["status"]).onSnapshot(onChange);

stop();        // unsubscribe one
live.close();  // unsubscribe everything
```

The query-builder methods — `where`, `orderBy`, `take`, `skip`, `fields` — mirror
the [core query API](../core/queries) and serialize into the request URL.
`onSnapshot` delivers the full core [`LiveEvent`](../core/realtime#the-liveevent-deltas) verbatim:
`type` (`"init"` then `"change"`), the full `results`, and the `added` / `removed` / `changed` /
`moved` deltas plus `changedFields` (`moved` is populated only for an ordered query).

### `RealtimeClientOptions`

| Option | Default | Meaning |
|---|---|---|
| `token` | — | bearer token, sent as `Authorization` **and** `?token=` |
| `path` | `"/realtime"` | base path on the server (match the server's `path`) |
| `reconnectMs` | `1000` | reconnect backoff after a dropped stream |
| `fetch` | global `fetch` | custom fetch (proxy, Node polyfill, …) |
| `onError` | `console.error` | called for a server-sent `{ error }` frame |

## How it works

- One SSE stream per subscription; the query travels in the URL.
- The server runs `watch()` / `watchDoc()` on the authorized database and forwards
  each `LiveEvent` whole (init snapshot, then `added` / `removed` / `changed` / `moved`)
  down the stream. A periodic `: ping` comment keeps idle connections alive.
- The client tolerates LF / CRLF / CR frame separators, ignores heartbeat
  comments, and **auto-reconnects** with backoff after a drop — getting a fresh
  snapshot on reconnect, so no state is missed.
- Because `watch()` is fed by the change feed, **cross-process** writes and
  **`@monlite/sync`** changes are delivered too — not just writes from this
  process.

Auth, multi-tenancy, and CORS are yours to configure — a natural fit for the
embedded, one-`.db`-file-per-tenant model. For sharing a database across
**Electron** windows instead of remote clients, see
[`@monlite/electron`](/packages/electron).
