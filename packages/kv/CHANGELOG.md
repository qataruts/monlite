# @monlite/kv

## 0.1.0

- Initial release.

- Redis-like KV cache over SQLite: synchronous `get/set/has/delete`, atomic `incr/decr`, `mget`, `keys(prefix)`, TTLs (`expire`/`ttl`) with lazy expiry + optional sweep, namespaces. Works on both drivers.
