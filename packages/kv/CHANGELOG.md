# @monlite/kv

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release.

- Redis-like KV cache over SQLite: synchronous `get/set/has/delete`, atomic `incr/decr`, `mget`, `keys(prefix)`, TTLs (`expire`/`ttl`) with lazy expiry + optional sweep, namespaces. Works on both drivers.
