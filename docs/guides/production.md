# Guide: running monlite in production

monlite is a thin, ACID layer over SQLite. Most "production" concerns are SQLite
operational practices — this guide collects the ones that matter, plus the
monlite APIs that support them.

> monlite targets **local / edge / desktop / single-machine** workloads. For
> distributed, multi-writer, cloud-scale data, keep a server DB and replicate to
> it with [`@monlite/sync`](https://www.npmjs.com/package/@monlite/sync).

## Backend choice

| Backend | Use it when |
| --- | --- |
| `better-sqlite3` | You want the fastest native driver and don't mind a build step. |
| `node:sqlite` | You want zero dependencies (Node ≥ 22.5). |
| `@monlite/wasm` | You're in the browser. |

All three are the same SQLite engine and the same file format.

## Durability

WAL is on by default with `synchronous = NORMAL` (safe across **application**
crashes). For maximum **power-loss** durability:

```ts
const db = createDb("app.db", { synchronous: "FULL" });
```

- `NORMAL` (default): fast; a power loss may lose the last transaction(s) but the
  file stays consistent.
- `FULL` / `EXTRA`: each commit is durable through power loss; slower.

Checkpoint the WAL periodically on long-running writers so it doesn't grow
unbounded: `db.checkpoint("TRUNCATE")`.

## Transactions

```ts
// Synchronous critical section (no awaits inside):
await db.$transaction((tx) => { /* sync reads + writes */ });

// Async unit-of-work — await inside, atomic, serialized (no lost updates):
await db.transactionAsync(async (tx) => {
  const acct = await tx.collection("accounts").findById(id);
  await tx.collection("accounts").update({ where: { _id: id }, data: { balance: acct.balance - amt } });
  await tx.collection("ledger").create({ data: { acct: id, amt } });
});
```

Use `transactionAsync` for read → compute → write flows (e.g. double-entry
posting). It serializes calls, so concurrent units can't lose updates. **Create
collections at startup**, not inside a transaction that may roll back.

## Concurrency

SQLite is single-writer; WAL allows concurrent readers. monlite sets
`busy_timeout = 5000` ms, so a brief writer contention waits rather than throwing.
Tune it with `{ busyTimeout }`. For multi-process access, all processes should use
WAL (the default) on the same file.

## Integrity, backup & recovery

```ts
db.checkIntegrity();              // true | string[] of problems
await db.backup("backup.db");     // consistent snapshot (VACUUM INTO)
```

- **Backups:** `db.backup(path)` writes a consistent copy even while the DB is in
  use. Rotate snapshots on a schedule.
- **Restore:** a backup file *is* a complete database — restore by replacing the
  file (while closed) or opening it directly with `createDb`.
- Run `db.checkIntegrity()` after a hard crash or before a backup if you suspect
  corruption.

## Maintenance

```ts
db.analyze();   // refresh planner stats after large data changes
db.vacuum();    // reclaim space / defragment (rewrites the file)
```

Auto-index learning persists in `_monlite_autoindex`, so query plans stay
predictable across restarts. For hot paths you can also pre-declare indexes via a
structured `schema` so nothing is left to learning.

## Encryption keys

With the `encryption` option (see the main README), **you** own the key. Don't
hard-code it — load it from the OS keychain / an env var / a KMS, and rotate with
`db.rekey(newKey)`. Losing the key means losing the data.

## Money & precision

SQLite numbers are 64-bit floats. For currency, **store integer minor units**
(cents) or decimal strings — never accumulate floats. Structured columns can be
declared `INTEGER` for this.

## Error reference

All thrown errors extend `MonliteError`:

| Class | Meaning |
| --- | --- |
| `MonliteError` | Base class for everything monlite throws. |
| `MonliteQueryError` | Malformed query/update payload (bad operator, mixed forms). |
| `MonliteConstraintError` | A database constraint was violated (base of the below). |
| `MonliteUniqueConstraintError` | Unique index / primary-key collision. |
| `MonliteNotNullError` | A `NOT NULL` column got null. |
| `MonliteForeignKeyError` | A foreign-key constraint failed. |
| `MonliteEncryptionError` | Wrong/missing key, or the file isn't encrypted. |

```ts
import { MonliteUniqueConstraintError } from "@monlite/core";
try {
  await users.create({ data: { email } });
} catch (e) {
  if (e instanceof MonliteUniqueConstraintError) { /* duplicate email */ }
}
```
