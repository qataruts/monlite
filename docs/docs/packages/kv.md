---
id: kv
title: "@monlite/kv"
---

# @monlite/kv — cache, locks, sorted sets & pub/sub

Redis's local role in a file: a synchronous, persisted key/value store with TTLs,
an atomic set-if-absent (the lock/nonce primitive), Redis-style sorted sets, and
cross-process pub/sub. Values are any JSON-serializable data; TTLs are in
milliseconds.

```bash
npm install @monlite/kv
```

```ts
import { createDb } from "@monlite/core";
import { kv } from "@monlite/kv";

const db = createDb("app.db");
const cache = kv(db);

cache.set("session:42", { user: "ali" }, { ttl: 60_000 }); // expires in 60s
cache.get("session:42"); // { user: "ali" } — synchronous, no await
cache.incr("hits"); // 1
cache.ttl("session:42"); // ~60000 (ms remaining)

// SET NX — the lock / nonce primitive
if (cache.setNX("lock:sweeper", 1, { ttl: 5_000 })) {
  // acquired the single-flight lock
}
```

On the SQLite engine (`kv(db)`) every method is **synchronous** — no `await`. On
the Postgres engine you use [`pgKv(db)`](#postgres-engine-pgkv) instead, which has
the identical surface but returns Promises. Calling `kv()` on a Postgres database
throws with a pointer to `pgKv`.

## Strings, counters & keys

```ts
cache.set("name", "ada"); // store any JSON value
cache.set("token", "abc", { ttl: 30_000 }); // with a TTL (ms)
cache.get<string>("name"); // "ada"  (or undefined if missing/expired)
cache.has("name"); // true
cache.delete("name"); // true if a key was removed

cache.incr("views"); // 1   — atomically add 1 (default)
cache.incr("views", 10); // 11
cache.decr("stock", 3); // atomically subtract

cache.mget(["a", "b", "c"]); // [valA, undefined, valC] — bulk get
cache.keys(); // every live key in the namespace
cache.keys("session:"); // keys with this prefix (expired ones excluded)
cache.size(); // count of live keys
cache.flush(); // delete every key in this namespace
```

| Method | Description |
|---|---|
| `get<T>(key)` | the value, or `undefined` if missing/expired |
| `set(key, value, { ttl? })` | store any JSON value; optional TTL in ms |
| `setNX(key, value, { ttl? })` | atomic set-if-absent → `true` if acquired, `false` if a live key exists |
| `has(key)` | `true` if a live key exists |
| `delete(key)` | `true` if a key was removed |
| `incr(key, by?)` / `decr(key, by?)` | atomically add/subtract (`by` default 1); returns the new value |
| `mget<T>(keys)` | values in order, `undefined` for absent/expired |
| `keys(prefix?)` | live keys in the namespace, optionally by prefix |
| `expire(key, ttl)` | set/refresh a key's TTL (ms); `false` if the key is absent |
| `ttl(key)` | remaining TTL in ms; `-1` if no expiry, `-2` if absent (Redis convention) |
| `size()` | number of live keys in the namespace |
| `flush()` | delete every key in the namespace |

`incr`/`decr` throw if the stored value isn't a number. `ttl` follows the Redis
convention exactly: a positive number of ms remaining, `-1` for a key with no
expiry, `-2` for a key that doesn't exist (or has expired).

## Atomic locks with `setNX`

`setNX` (`SET … NX`) is the building block for single-instance schedulers, nonces,
distributed mutexes, and once-only work. It returns `true` only if the key wasn't
already present (and live), `false` otherwise:

```ts
// Only one process/worker may run the nightly sweep
if (cache.setNX("lock:sweep", process.pid, { ttl: 30_000 })) {
  try {
    await runSweep();
  } finally {
    cache.delete("lock:sweep"); // release early; the TTL is the safety net
  }
}
```

`setNX` and `incr`/`decr` run under `BEGIN IMMEDIATE`, taking the write lock up
front, so they're **cross-process safe**: multiple processes (or workers) sharing
the same `.db` can race the same key and exactly one acquires the lock — the losers
cleanly get `false` rather than deadlocking or erroring.

Use a separate `:memory:` db for a purely ephemeral cache, or `{ namespace }` to
isolate multiple caches in one file.

## Sorted sets (ZSET)

Redis-style sorted sets — leaderboards, rate-limiters, priority indexes, time
series. Each member has a numeric score; members are ordered by score, ties broken
lexicographically by member.

```ts
cache.zadd("board", 100, "alice");
cache.zadd("board", 60, "bob");
cache.zincrby("board", 5, "bob"); // → 65 (new score)

cache.zscore("board", "alice"); // 100
cache.zcard("board"); // 2  (number of members)
cache.zrank("board", "alice", { rev: true }); // 0  — top by descending score

cache.zrange("board", 0, 2, { rev: true }); // top 3 by score: ["alice", "bob"]
cache.zrange("board", 0, -1, { withScores: true }); // [{ member, score }, …]
cache.zrangeByScore("board", 50, 100); // members with 50 ≤ score ≤ 100

cache.zrem("board", "bob"); // true if removed
```

| Method | Description |
|---|---|
| `zadd(key, score, member)` | add or update `member` with `score` (`ZADD`) |
| `zincrby(key, delta, member)` | atomically bump `member`'s score by `delta`; returns the new score (`ZINCRBY`) |
| `zscore(key, member)` | the member's score, or `undefined` (`ZSCORE`) |
| `zrem(key, member)` | remove a member; `true` if it existed (`ZREM`) |
| `zcard(key)` | number of members (`ZCARD`) |
| `zrank(key, member, { rev? })` | 0-based rank by ascending (or `rev` descending) score; `undefined` if absent |
| `zrange(key, start, stop, { rev?, withScores? })` | members by rank range `[start, stop]` inclusive (negative counts from the end), ascending or `rev` descending |
| `zrangeByScore(key, min, max, { withScores? })` | members with `min ≤ score ≤ max`, ascending (`ZRANGEBYSCORE`) |

`zincrby` runs under an immediate transaction, so a leaderboard or sliding-window
rate-limiter stays correct across processes. With `withScores`, `zrange` /
`zrangeByScore` return `Array<{ member, score }>` instead of `string[]`.

A leaderboard top-N and a member's own rank:

```ts
cache.zincrby("scores", 1, userId); // record a point
const top10 = cache.zrange("scores", 0, 9, { rev: true, withScores: true });
const myRank = cache.zrank("scores", userId, { rev: true }); // 0 = first place
```

## Pub/sub

`publish` / `subscribe` (Redis `PUBLISH` / `SUBSCRIBE`) fan out messages to every
listener on a channel — including listeners in **other processes** sharing the same
`.db`.

```ts
const stop = cache.subscribe("jobs", (msg) => console.log("got", msg));
const n = cache.publish("jobs", { id: 7 }); // delivered to every "jobs" subscriber
// n = number of subscribers on THIS instance that received it
stop(); // unsubscribe
```

| Method | Description |
|---|---|
| `publish(channel, message)` | publish to a channel; returns the count of local listeners that received it |
| `subscribe(channel, cb)` | subscribe; `cb` fires for every message published **after** this call. Returns an unsubscribe fn |

Same-process delivery is immediate; cross-process listeners are picked up by a
short poll (`pubsubPollMs`, default `200` ms) that starts on the first
`subscribe()` and **stops when the last one unsubscribes**. Messages are ephemeral
— not replayed to late subscribers, and old messages are pruned automatically (a
late subscriber only sees messages published after it subscribed).

## Options & lifecycle

```ts
const cache = kv(db, {
  namespace: "ratelimit", // isolate multiple caches in one file (default "default")
  sweepIntervalMs: 60_000, // periodically purge expired keys (default: lazy-only)
  pubsubPollMs: 200, // cross-process pub/sub poll interval (ms)
});

cache.stop(); // stop the sweep + pub/sub timers (if any)
```

| Option | Description |
|---|---|
| `namespace` | logical namespace so multiple caches share one database. Default `"default"` |
| `sweepIntervalMs` | if set, a timer periodically purges expired keys. Default: lazy-only (keys are also purged on read) |
| `pubsubPollMs` | how often a `subscribe()` listener polls for cross-process messages. Default `200` |

Expired keys are reclaimed lazily on access regardless of `sweepIntervalMs`; the
sweep timer just bounds how long dead rows linger on disk.

## Postgres engine: `pgKv`

On the [Postgres engine](/packages/postgres) the same model — namespaced keys,
TTLs, sorted sets, table-backed cross-process pub/sub — runs over a networked,
multi-writer database via `pgKv(db)`. The surface is **identical** to `kv`, but
every method is **async**:

```ts
import { createDb } from "@monlite/postgres";
import { pgKv } from "@monlite/kv";

const db = createDb("postgres://user@host/db");
const cache = pgKv(db);

await cache.set("session:42", { user: "ali" }, { ttl: 60_000 });
await cache.get("session:42"); // { user: "ali" }

if (await cache.setNX("lock:sweep", 1, { ttl: 5_000 })) {
  // acquired across all processes — atomic via a Postgres transaction
}

await cache.zincrby("board", 1, "alice");
await cache.zrange("board", 0, 9, { rev: true, withScores: true });

const stop = cache.subscribe("jobs", (m) => console.log(m)); // subscribe stays sync
await cache.publish("jobs", { id: 7 });
```

Every method that touches the database (`get`, `set`, `setNX`, `incr`, `zadd`, …,
`publish`) returns a Promise — `await` it. `subscribe` is synchronous (it returns
the unsubscribe fn immediately) and `stop` is synchronous, exactly as on SQLite.
`setNX`, `incr`, and `zincrby` use Postgres transactions for the same
cross-process atomicity. Calling `kv()` on a Postgres database (or `pgKv()` on a
SQLite database) throws with a clear pointer to the right factory.
