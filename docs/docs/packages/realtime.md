---
id: realtime
title: "@monlite/realtime"
---

# @monlite/realtime

Networked realtime — stream live queries and documents to remote clients (browser, mobile, other
services) over **Server-Sent Events**, backed by the [change feed](../core/realtime). Your database
stays embedded in your service; this package puts a realtime API in front of it. Zero extra
dependencies (`node:http` + `fetch`).

```bash
npm install @monlite/realtime
```

## Server

```ts
import { createDb } from "@monlite/core";
import { realtime } from "@monlite/realtime";

const db = createDb("./app.db", { changefeed: true }); // change feed required

// Single database:
realtime({ db }).listen(8080);

// Per-tenant + auth — resolve which db from the request (return null to reject):
realtime({
  authorize: (req) => {
    const tenant = verify(req.headers.authorization);
    return tenant ? { db: dbForTenant(tenant) } : null;
  },
}).listen(8080);
```

Attach to an existing server instead of `listen()`:

```ts
const rt = realtime({ db });
http.createServer((req, res) => {
  if (req.url?.startsWith("/realtime")) return rt.handler(req, res);
  // ... your other routes
});
```

| Option | Default | Meaning |
|---|---|---|
| `db` | — | single-database shortcut (no auth) |
| `authorize(req)` | — | resolve `{ db }` per request, or `null`/throw → `401` |
| `path` | `"/realtime"` | base path |
| `cors` | `"*"` | `Access-Control-Allow-Origin`, or `false` |
| `heartbeatMs` | `25000` | keep-alive comment interval |

## Client (browser or Node ≥ 18)

```ts
import { connectRealtime } from "@monlite/realtime/client";

const live = connectRealtime("https://api.example.com", { token });

const stop = live
  .collection("orders")
  .where({ status: "open" })
  .orderBy({ createdAt: "desc" })
  .onSnapshot(({ results, added, removed, changed, moved }) => render(results));

const stopDoc = live.doc("orders", "o-123", (doc) => render(doc)); // null on delete

live.collection("orders").fields(["status"]).onSnapshot(onChange); // only when `status` changes

stop();        // unsubscribe one
live.close();  // unsubscribe everything
```

## How it works

- One SSE stream per subscription; the query travels in the URL.
- The server runs `watch()` / `watchDoc()` on the authorized database and pushes each `LiveEvent`
  (init snapshot, then `added`/`removed`/`changed`/`moved`) down the stream.
- The client auto-reconnects with backoff and gets a fresh snapshot on reconnect (no missed state).
- Because writes flow through the change feed, **cross-process** writes and **`@monlite/sync`**
  changes are delivered too.

Auth, multi-tenancy and CORS are yours to configure — a natural fit for the embedded,
one-`.db`-file-per-tenant model.
