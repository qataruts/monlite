---
id: durability
title: Durability & operations
---

# Durability & operations

monlite is hardened for system-of-record use on a single machine.

## Durability tuning

```ts
const db = createDb("app.db", { synchronous: "FULL" }); // OFF | NORMAL | FULL | EXTRA
```

WAL defaults to `NORMAL`; use `FULL` for maximum power-loss safety. A
crash-consistency test (SIGKILL mid-transaction → reopen) verifies the WAL
recovers with no torn writes.

## Maintenance

```ts
db.checkIntegrity();    // PRAGMA integrity_check → true or the problems
db.checkIntegrity(true); // quick_check
db.vacuum();            // reclaim space
db.analyze();           // refresh the query planner stats
db.checkpoint("TRUNCATE"); // fold the WAL into the main file
```

## Backup

```ts
await db.backup("backup.db"); // consistent snapshot via VACUUM INTO
```

In local deployments, backup is literally **copy the `.db` file** (with the
server stopped, or after a checkpoint).

## Observability

```ts
const stats = db.stats();
// { sizeBytes, pageSize, pageCount, collections, indexes }

const db2 = createDb("app.db", {
  onQuery: ({ sql, durationMs }) => {
    if (durationMs > 50) log.warn("slow query", { sql, durationMs });
  },
});
```

## Encryption at rest

```ts
const db = createDb("app.db", { encryption: { key: process.env.DB_KEY } });
await db.rekey(newKey); // rotate
```

Backed by `better-sqlite3-multiple-ciphers` (optional peer dependency); not
available on `node:sqlite`.

See the [production guide](/guides/production) for the full operations playbook.
