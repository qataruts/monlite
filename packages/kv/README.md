# @monlite/kv

A **Redis-like key-value cache** for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core), backed by SQLite. Synchronous `get/set/incr` with TTLs — part of the [local AI-agent harness](https://github.com/qataruts/monlite#readme) (cache + queue + cron, replacing Redis locally).

```bash
npm install @monlite/core @monlite/kv
```

## Quick start

```ts
import { createDb } from "@monlite/core";
import { kv } from "@monlite/kv";

const db = createDb("app.db");
const cache = kv(db);

cache.set("session:42", { user: "ali" }, { ttl: 60_000 }); // expires in 60s
cache.get("session:42"); // { user: "ali" }  — synchronous, no await
cache.incr("hits"); // 1
cache.incr("hits", 5); // 6
cache.ttl("session:42"); // ~60000 (ms remaining)
```

It's **synchronous** (local SQLite — no network, no await), **durable** (survives
restarts), and persisted in your app's database. Use a separate `:memory:` db if
you want a purely ephemeral cache.

## API

| Method | Description |
| --- | --- |
| `get(key)` | Value, or `undefined` (also if expired). |
| `set(key, value, { ttl })` | Store any JSON value; `ttl` in ms (optional). |
| `setNX(key, value, { ttl })` | Atomic set-if-absent (Redis `SET NX`); `true` if acquired. The lock/nonce primitive. |
| `has(key)` / `delete(key)` | Existence / removal. |
| `incr(key, by?)` / `decr(key, by?)` | Atomic numeric update; returns the new value. |
| `mget(keys)` | Array of values (`undefined` per missing key). |
| `keys(prefix?)` | Live keys in the namespace, optionally by prefix. |
| `expire(key, ttl)` | Set/refresh TTL (ms); `false` if absent. |
| `ttl(key)` | Remaining ms; `-1` no expiry, `-2` absent (Redis convention). |
| `size()` / `flush()` | Count / clear the namespace. |

## Options

```ts
kv(db, {
  namespace: "sessions", // isolate multiple caches in one db (default "default")
  sweepIntervalMs: 60_000, // periodically purge expired keys (default: lazy-only)
});
```

Expired keys are removed lazily on read; set `sweepIntervalMs` to also purge them
on a timer. Call `cache.stop()` to clear the sweep timer.

MIT
