# @monlite/fts

## 0.2.0

- `collection.catchUp()` + an `updated_at` high-water-mark: incrementally index documents written by **another process** (and reconcile cross-process deletes) without a full reindex — so a separate searcher process stays fresh. Indexes on open too.

## 0.1.3

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.2

- Track @monlite/core ^1.0.0.


## 0.1.1

- Track @monlite/core ^0.10.0 (no code change).


## 0.1.0

- Initial release: SQLite FTS5 full-text search plugin. `collection.search()`,
  automatic index maintenance on writes (incl. synced changes), dot-path fields,
  `where` filtering, and `reindex()`. Works on both monlite backends.
