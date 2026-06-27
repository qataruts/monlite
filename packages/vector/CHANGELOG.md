# @monlite/vector

## 0.2.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.2.0

- **hybridSearch()** — fuse FTS (keyword) + vector (semantic) results with
  Reciprocal Rank Fusion. Falls back to vector-only when FTS is not configured.
- Track @monlite/core ^1.0.0.


## 0.1.0

- Initial release: local vector / semantic search via sqlite-vec. `vector()`
  plugin + `collection.findSimilar({ vector, topK, where })`, automatic index
  maintenance on writes (incl. synced changes), L2 and cosine metrics, and
  `reindex()`. Requires `createDb({ allowExtensions: true })`. Works on both
  monlite backends.
