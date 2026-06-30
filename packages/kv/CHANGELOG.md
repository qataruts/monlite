# @monlite/kv

## 0.5.0 — Postgres engine support (pgKv)

The cache now runs on the [`@monlite/postgres`](https://www.npmjs.com/package/@monlite/postgres)
engine via an async `pgKv(db)` — the full surface mirrored: get/set/setNX, incr/decr, mget, keys,
expire/ttl, flush/size, sorted sets (zadd/zincrby/zscore/zrem/zcard/zrank/zrange/zrangeByScore),
and table-backed cross-process pub/sub. Read-modify-write ops run in a transaction; a new
subscriber never replays. Methods are async (`await cache.get(...)`). The sync SQLite `kv()` is
unchanged; `kv(pgDb)` throws a clear redirect. Requires `@monlite/core` ≥ 2.9.0 for the Postgres
path.

## 0.4.1 — pub/sub + ZSET hardening (audit fixes)

Bug fixes from an internal audit. **No API changes.**

- **Pub/sub prune is namespace-scoped.** Publishing now prunes only the publishing namespace's
  expired messages (`WHERE ns = ? AND ts < ?`), so a busy namespace can no longer drop another
  namespace's still-unread messages from the shared table.
- **ZSET score validation.** `zadd`/`zincrby` reject a `NaN`/non-numeric score with a clear error
  instead of failing deep in SQLite with a `NOT NULL` constraint message.
- **`zrange` floors fractional rank arguments** (`zrange(key, 0.7, 1.9)`) so they can't reach
  SQLite's `LIMIT`/`OFFSET` and throw a datatype mismatch.

## 0.4.0 — sorted sets (ZSET)

- **`zadd` / `zscore` / `zincrby` / `zrem` / `zcard` / `zrank` / `zrange` / `zrangeByScore`** —
  Redis-style sorted sets for leaderboards, rate-limiters and priority indexes. `zrange` supports
  rank ranges (negative = from the end), `rev` (descending), and `withScores`; ties break
  lexicographically by member, matching Redis. `zincrby` is atomic across processes.

## 0.3.1 — pub/sub poll on the shared heartbeat

- The cross-process pub/sub poll now registers on the database's shared `Heartbeat`
  (`@monlite/core` ≥ 2.8.0) instead of its own `setInterval`, so it coalesces with the reactor,
  queue and cron into a single timer. No behavior change.

## 0.3.0 — pub/sub

- **`publish(channel, message)` / `subscribe(channel, cb)`** (Redis-style PUBLISH/SUBSCRIBE).
  Same-process delivery is immediate; cross-process listeners (other connections to the same
  `.db`) receive messages too, via a short poll (`pubsubPollMs`, default 200) that starts on the
  first subscribe and **stops when the last unsubscribes** (`unref`'d — no idle cost otherwise).
  Ephemeral — not replayed to late subscribers; old messages are pruned automatically.

## 0.2.2 — correctness fix (bug hunt)

- **`set(key, undefined)` stores JSON `null` and round-trips cleanly** instead of throwing a
  raw `NOT NULL constraint failed` SQL error. Falsy values (`0`, `""`, `false`) are unaffected.

## 0.2.1 — cross-process atomicity

- **`setNX` / `incr` run under an IMMEDIATE transaction**, so the check-and-set is
  atomic even across processes sharing one `.db` (the lock/counter primitives can't
  race). No API change.

## 0.2.0

- `setNX(key, value, { ttl? })` — atomic set-if-absent (Redis `SET NX`), the lock/nonce primitive. Treats an expired key as absent.

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release.

- Redis-like KV cache over SQLite: synchronous `get/set/has/delete`, atomic `incr/decr`, `mget`, `keys(prefix)`, TTLs (`expire`/`ttl`) with lazy expiry + optional sweep, namespaces. Works on both drivers.
