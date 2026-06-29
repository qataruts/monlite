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

## Pub/sub

`publish` / `subscribe` (Redis `PUBLISH` / `SUBSCRIBE`) fan out messages to listeners —
including **across processes** sharing the same `.db`.

```ts
const stop = cache.subscribe("jobs", (msg) => console.log("got", msg));
cache.publish("jobs", { id: 7 }); // delivered to every subscriber on "jobs"
stop(); // unsubscribe
```

Same-process delivery is immediate; cross-process listeners are picked up by a short poll
(`pubsubPollMs`, default `200`) that starts on the first `subscribe()` and **stops when the
last one unsubscribes**. Messages are ephemeral — not replayed to late subscribers, and old
messages are pruned automatically.

## Sorted sets (ZSET)

Redis-style sorted sets — leaderboards, rate-limiters, priority indexes.

```ts
cache.zadd("board", 100, "alice");
cache.zadd("board", 60, "bob");
cache.zincrby("board", 5, "bob"); // → 65
cache.zrange("board", 0, 2, { rev: true }); // top 3 by score
cache.zrange("board", 0, -1, { withScores: true }); // [{ member, score }, …]
cache.zrangeByScore("board", 50, 100); // members with 50 ≤ score ≤ 100
cache.zrank("board", "alice", { rev: true }); // 0 = top
```

| Method | Description |
|---|---|
| `zadd(key, score, member)` / `zincrby(key, delta, member)` | add/update / atomically bump a score |
| `zscore` / `zrank(key, member, { rev })` | a member's score / 0-based rank (ties lexicographic) |
| `zrange(key, start, stop, { rev, withScores })` | members by rank range (negative = from the end) |
| `zrangeByScore(key, min, max, { withScores })` | members within a score range |
| `zrem` / `zcard` | remove a member / count members |
