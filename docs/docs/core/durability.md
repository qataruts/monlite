---
id: durability
title: Durability & operations
---

# Durability & operations

monlite is hardened for system-of-record use on a single machine. It runs SQLite in WAL mode by
default, enforces foreign keys, and exposes the durability, integrity, backup, and maintenance
controls you need to operate it as a real database.

```ts
const db = createDb("app.db", {
  wal: true,             // WAL journal mode (default)
  synchronous: "NORMAL", // WAL's default; FULL for max power-loss safety
  busyTimeout: 5000,     // ms to wait on a locked db before erroring (default)
});
```

## Open options (durability & concurrency)

All of these are passed to `createDb(filename, options)` and apply to the SQLite engine.

| Option | Default | Meaning |
|---|---|---|
| `wal` | `true` | Use WAL journal mode for better read/write concurrency. Disabled automatically when `readonly` is set. |
| `synchronous` | `NORMAL` (WAL default) | Durability vs speed: `"OFF"` \| `"NORMAL"` \| `"FULL"` \| `"EXTRA"`. Only applied when you pass it; otherwise SQLite's WAL default (`NORMAL`) stands. |
| `busyTimeout` | `5000` | Milliseconds to wait on a locked database before throwing, instead of failing immediately. |
| `readonly` | `false` | Open read-only. Writes throw; WAL is not engaged. |

On open, monlite always sets `PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout`, then engages
WAL (unless read-only or `wal: false`), then applies `synchronous` if provided.

### WAL mode

WAL (Write-Ahead Logging) is on by default. It lets readers and a writer proceed concurrently
(readers don't block the writer and vice-versa), which matters when multiple processes or
connections share the same `.db`. The WAL file (`app.db-wal`) and shared-memory file
(`app.db-shm`) sit alongside the main database; both are part of the database — copy them with the
main file (or checkpoint first; see [Backup](#backup)).

### `synchronous` — durability vs speed

`synchronous` controls how aggressively SQLite flushes to disk:

- `OFF` — fastest, but the database can corrupt on **power loss / OS crash** (an app-level crash
  is still safe in WAL). Use only for disposable/rebuildable data.
- `NORMAL` — the WAL default. Safe against application crashes; a power loss can lose the last
  committed transaction(s) but **cannot corrupt** the database. The right default for most apps.
- `FULL` — flushes the WAL on every commit. No committed transaction is lost on power loss, at
  some write cost. Use for a strict system of record.
- `EXTRA` — like `FULL` plus an extra directory sync; maximum durability.

```ts
const db = createDb("ledger.db", { synchronous: "FULL" }); // strict system of record
```

A crash-consistency test (SIGKILL mid-transaction, then reopen) verifies the WAL recovers with no
torn or partial writes.

### Read-only mode

```ts
const db = createDb("app.db", { readonly: true });
```

Opens the file read-only — any write throws, and WAL is not engaged. Useful for replicas,
read-only analytics processes, or serving a snapshot safely while another process owns writes.

## Transactions

Two transaction primitives commit/roll back atomically:

```ts
// Synchronous unit of work (fn must not await).
await db.$transaction((tx) => {
  // reads + writes; a throw rolls everything back
});

// Async unit of work — fn may await between reads and writes, all inside one
// BEGIN IMMEDIATE … COMMIT. Calls are serialized so concurrent async transactions
// can't interleave on the shared connection.
await db.transactionAsync(async (tx) => {
  const acct = await accounts.findById(id);
  await accounts.update({ where: { _id: id }, data: { $inc: { balance: -amount } } });
});
```

`transactionAsync` is the right primitive for read → compute → write patterns (e.g. a
double-entry posting). A plain write issued from **outside** an in-flight `transactionAsync` is
rejected — it would otherwise silently fold into that transaction on the shared connection.

## Integrity, maintenance & checkpointing

```ts
db.checkIntegrity();      // PRAGMA integrity_check → true, or an array of problems found
db.checkIntegrity(true);  // PRAGMA quick_check (faster, less exhaustive)

db.vacuum();              // rebuild the file: reclaim space and defragment
db.analyze();             // refresh the query planner's statistics

db.checkpoint();          // PASSIVE checkpoint (default)
db.checkpoint("TRUNCATE"); // fold the WAL fully into the main file and truncate it
```

`checkpoint(mode)` accepts `"PASSIVE"` (default), `"FULL"`, `"RESTART"`, or `"TRUNCATE"`. A
`TRUNCATE` checkpoint is the clean way to fold all WAL contents back into the main `.db` file —
do this before copying the file for a backup if you want to copy the single file alone.

## Backup

```ts
await db.backup("backup.db"); // consistent snapshot via VACUUM INTO (dest must not exist)
```

`backup(path)` writes a single, consistent on-disk snapshot using `VACUUM INTO` — safe to run
while the database is live, and the destination is a clean, fully-checkpointed file with no
sidecar WAL/SHM.

For local/embedded deployments, backup can also be literally **copying the `.db` file** — but
because WAL writes go to the `-wal` sidecar, do it with the writer stopped, **or** copy all three
files (`app.db`, `app.db-wal`, `app.db-shm`) together, **or** run a `TRUNCATE` checkpoint first so
the WAL is empty. When in doubt, prefer `db.backup()` — it handles all of this.

## Encryption at rest

```ts
const db = createDb("app.db", { encryption: { key: process.env.DB_KEY } });
await db.rekey(newKey);          // rotate the key
await db.rekey(newKey, "chacha20"); // rotate and change cipher scheme
```

Encryption is backed by `better-sqlite3-multiple-ciphers` (an optional, drop-in replacement for
`better-sqlite3`); it is **not** available on the `node:sqlite` backend. The key must be supplied
at open. `rekey()` only works on a database opened with `encryption` (it throws otherwise) and
re-encrypts the file with the new key (and optional cipher).

## Observability

```ts
const stats = db.stats();
// { sizeBytes, pageSize, pageCount, collections, indexes }

const db2 = createDb("app.db", {
  onQuery: ({ sql, durationMs }) => {
    if (durationMs > 50) log.warn("slow query", { sql, durationMs });
  },
  verbose: (sql) => log.debug(sql), // log every statement (debugging)
});
```

`stats()` returns on-disk size and object counts for monitoring. `onQuery` fires after each
statement with its timing — wire a slow-query log or metrics here; it adds overhead only when
provided. `verbose` logs every executed SQL string.

You can also guard resource usage at open: `maxDocumentBytes` rejects writes whose serialized
document exceeds a byte limit, and `maxRows` makes an unbounded `findMany` (no `take`) throw past
a row cap instead of materializing an unbounded result set. Both are off by default; internal
queries (indexing, reactivity) are never capped.

See the [production guide](/guides/production) for the full operations playbook.
