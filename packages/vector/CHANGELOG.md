# @monlite/vector

## 0.1.0

- Initial release: local vector / semantic search via sqlite-vec. `vector()`
  plugin + `collection.findSimilar({ vector, topK, where })`, automatic index
  maintenance on writes (incl. synced changes), L2 and cosine metrics, and
  `reindex()`. Requires `createDb({ allowExtensions: true })`. Works on both
  monlite backends.
