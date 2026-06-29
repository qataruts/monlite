# @monlite/kv

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
