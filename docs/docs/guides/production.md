---
id: production
title: Production guide
---

# Production guide

monlite is hardened for single-machine system-of-record use. This is the
operations playbook.

## Durability

- Open with `{ synchronous: "FULL" }` for maximum power-loss safety (WAL defaults
  to `NORMAL`). A crash-consistency test (SIGKILL mid-transaction) verifies WAL
  recovery with no torn writes.
- Use [`transactionAsync`](/core/transactions) for read-modify-write units and
  `findOneAndUpdate` for compare-and-swap.

## Concurrency

- One file has a **single writer** at a time; readers are concurrent (WAL).
- Multiple **processes** can share the file: CAS (`findOneAndUpdate`) and the
  queue's atomic claim are cross-process safe (core ≥ 2.6.1).
- `busyTimeout` (default 5000 ms) controls how long a writer waits for the lock.

## Money & precision

Store money as integer minor units (cents), not floats. `$inc` on integers is
exact; floats are not.

## Maintenance

```ts
db.checkIntegrity();        // verify on-disk integrity
db.vacuum(); db.analyze();  // reclaim space; refresh planner stats
db.checkpoint("TRUNCATE");  // fold the WAL in
await db.backup("snap.db"); // consistent snapshot (VACUUM INTO)
```

## Observability

`db.stats()` for size/page/collection/index counts; the `onQuery` hook for a
slow-query log or metrics.

## Errors

Typed errors let you branch precisely: `MonliteUniqueConstraintError`,
`MonliteNotNullError`, `MonliteForeignKeyError`, `MonliteConstraintError`,
`MonliteEncryptionError`. Driver errors are normalized across backends.

## Scale boundary

monlite is **local / edge / desktop / single-machine**. For multi-site shared
live state, very high write volume, or strict-HA, keep the managed services and
[sync](/packages/sync) to them — the same code switches backends.
