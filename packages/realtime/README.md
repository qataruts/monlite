# @monlite/realtime

Networked realtime for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) — stream
live queries and documents to remote clients (browser, mobile, other services) over **Server-Sent
Events**, backed by the change feed. Zero extra dependencies (built on `node:http` + `fetch`).

```bash
npm install @monlite/realtime
```

The database stays embedded in **your** service; this package puts a realtime API in front of it.

## Server

```ts
import { createDb } from "@monlite/core";
import { realtime } from "@monlite/realtime";

const db = createDb("./app.db", { changefeed: true }); // change feed required

// Single database:
realtime({ db }).listen(8080);

// Or per-tenant + auth (resolve which db from the request):
realtime({
  authorize: (req) => {
    const tenant = verify(req.headers.authorization); // your auth
    return tenant ? { db: dbForTenant(tenant) } : null; // null → 401
  },
}).listen(8080);
```

Attach to an existing server/framework instead of `listen()`:

```ts
const rt = realtime({ db });
http.createServer((req, res) => {
  if (req.url?.startsWith("/realtime")) return rt.handler(req, res);
  // ... your other routes
});
```

## Client (browser or Node ≥ 18)

```ts
import { connectRealtime } from "@monlite/realtime/client";

const live = connectRealtime("https://api.example.com", { token });

// Live query — fires with the snapshot, then on every change
const stop = live
  .collection("orders")
  .where({ status: "open" })
  .orderBy({ createdAt: "desc" })
  .onSnapshot(({ results, added, removed, changed, moved }) => render(results));

// Single document (null on delete)
const stopDoc = live.doc("orders", "o-123", (doc) => render(doc));

// Only re-emit when a specific field changes
live.collection("orders").fields(["status"]).onSnapshot(onChange);

stop(); // unsubscribe
live.close(); // unsubscribe everything
```

Client options: `{ token, path, reconnectMs, fetch, onError }`. `onError` (default `console.error`)
receives any server-sent `{ error }` frame — e.g. a watch that failed server-side — so it is never
mis-delivered as a snapshot or a `null` document.

## How it works

- One SSE stream per subscription; the query travels in the URL.
- The server runs `collection.watch()` / `watchDoc()` on the authorized database and pushes each
  `LiveEvent` (init snapshot, then `added`/`removed`/`changed`/`moved` deltas) down the stream.
- The client auto-reconnects with backoff; on reconnect it receives a fresh snapshot (no missed
  state). Because writes flow through the [change feed](https://qataruts.github.io/monlite/core/realtime),
  changes from other processes and from `@monlite/sync` are delivered too.

## Notes

- **Auth & multi-tenancy** are your `authorize` hook's job — it maps a request to a `{ db }`.
- **CORS** is `*` by default; set `cors` to a specific origin (or `false`) in production.
- Pairs naturally with the embedded, one-`.db`-file-per-tenant model.
