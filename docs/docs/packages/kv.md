---
id: kv
title: "@monlite/kv"
---

# @monlite/kv — cache & locks

Redis's local role: a synchronous, persisted key/value store with TTLs and an
atomic set-if-absent (the lock/nonce primitive).

```bash
npm install @monlite/kv
```

```ts
import { createDb } from "@monlite/core";
import { kv } from "@monlite/kv";

const db = createDb("app.db");
const cache = kv(db);

cache.set("session:42", { user: "ali" }, { ttl: 60_000 }); // expires in 60s
cache.get("session:42");        // { user: "ali" } — synchronous, no await
cache.incr("hits");             // 1
cache.ttl("session:42");        // ~60000 (ms remaining)

// SET NX — the lock / nonce primitive
if (cache.setNX("lock:sweeper", 1, { ttl: 5_000 })) {
  // acquired the single-flight lock
}
```

| Method | Description |
|---|---|
| `get` / `set(key, value, { ttl })` | value (undefined if missing/expired) / store any JSON |
| `setNX(key, value, { ttl })` | atomic set-if-absent → `true` if acquired |
| `incr` / `decr(key, by?)` | atomic numeric update |
| `has` / `delete` / `expire` / `ttl` | existence / removal / TTL |
| `mget` / `keys(prefix?)` / `size` / `flush` | bulk / introspection |

`setNX` and `incr` run under `BEGIN IMMEDIATE`, so they're **cross-process safe**:
multiple processes (or workers) sharing the same `.db` can race the same key and
exactly one acquires the lock — the losers cleanly get `false` rather than erroring.

Use a separate `:memory:` db for a purely ephemeral cache, or `{ namespace }` to
isolate multiple caches in one file.
