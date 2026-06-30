# @monlite/kv

A Redis-like key-value cache for monlite — `get`/`set`/`incr` with TTLs, atomic locks, sorted
sets, and pub/sub. Part of the local AI-agent harness (cache + queue + cron, replacing Redis).

- **SQLite** ([`@monlite/core`](https://www.npmjs.com/package/@monlite/core)) — `kv(db)`, a
  synchronous API.
- **Postgres** ([`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)) —
  `pgKv(db)`, the same surface with an **async** API (`await cache.get(...)`).

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
cache.get("session:42");   // { user: "ali" }  — synchronous, no await
cache.incr("hits");        // 1
cache.incr("hits", 5);     // 6
cache.ttl("session:42");   // ~60000 (ms remaining)
```

The cache is **synchronous** (local SQLite — no network, no await), **durable** (survives
restarts), and stored in your app's database. Use `:memory:` if you want a purely ephemeral
cache.

## API

| Method | Description |
|---|---|
| `get(key)` | Value, or `undefined` (also if expired). |
| `set(key, value, { ttl? })` | Store any JSON-serializable value; `ttl` in ms (optional). |
| `setNX(key, value, { ttl? })` | Atomic set-if-absent (Redis `SET NX`); returns `true` if acquired. The lock/nonce primitive. |
| `has(key)` / `delete(key)` | Existence check / removal. |
| `incr(key, by?)` / `decr(key, by?)` | Atomic numeric increment/decrement; returns the new value. |
| `mget(keys)` | Array of values (`undefined` per missing/expired key). |
| `keys(prefix?)` | Live keys in the namespace, optionally filtered by prefix. |
| `expire(key, ttl)` | Set or refresh the TTL (ms); returns `false` if the key is absent. |
| `ttl(key)` | Remaining ms; `-1` = no expiry, `-2` = key absent (Redis convention). |
| `size()` / `flush()` | Count / clear all keys in the namespace. |
| `stop()` | Clear the sweep timer (if `sweepIntervalMs` was set). |

## Options

```ts
kv(db, {
  namespace: "sessions",   // isolate multiple caches in one db (default: "default")
  sweepIntervalMs: 60_000, // periodically purge expired keys (default: lazy-only)
});
```

Expired keys are removed lazily on read. Set `sweepIntervalMs` to also purge them on a timer.
Call `cache.stop()` to clear the timer when shutting down.

## License

MIT
