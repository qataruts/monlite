# @monlite/kv

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
