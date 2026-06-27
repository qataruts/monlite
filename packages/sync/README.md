# 🌙 @monlite/sync

> Local-first sync for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) —
> replicate a local SQLite document database with MongoDB and other backends.

`@monlite/sync` turns a local monlite database into a local-first store: work
fully offline, then converge with a remote source of truth when you reconnect.
MongoDB is the first adapter; the design is pluggable.

```ts
import { createDb } from "@monlite/core";
import { sync, MongoAdapter } from "@monlite/sync";
import { MongoClient } from "mongodb";

const db = createDb("./app.db", { sync: true }); // enable the change feed
const mongo = new MongoClient(uri);
await mongo.connect();

const engine = sync(db, {
  adapter: new MongoAdapter({ client: mongo, db: "app" }),
  collections: ["users", "orders"], // or "*"
  mode: "two-way",                  // "pull" | "push" | "two-way"
  conflict: "lww",                  // or (ctx) => "local" | "remote"
  interval: 5000,                   // poll cadence (optional)
  retries: 4,                       // retry a failed pull/push before the round fails
});

await engine.start();   // bootstrap + begin syncing
await engine.sync();    // force one round
engine.status();        // { running, pendingPush, conflicts, cursor, ... }
await engine.stop();
```

## Install

```bash
npm install @monlite/core @monlite/sync
# for the Mongo adapter, also: npm install mongodb
```

`mongodb` is an optional peer dependency — only needed for `MongoAdapter`.

## How it works

When a database is opened with `{ sync: true }`, `@monlite/core` records every
document-collection write in an append-only **change feed** (with tombstones for
deletes and a last-write-wins **version** of `timestamp:nodeId`). The engine:

1. **Pulls** remote changes since a saved cursor and applies them locally,
   resolving conflicts (LWW by default, or a custom resolver).
2. **Pushes** unsent local changes to the remote (idempotent, keyed by `_id`).

monlite `_id`s are MongoDB ObjectId-compatible, so local and remote ids map
**1:1** — no translation table. Versions travel with the data, so changes never
echo back into an infinite loop.

## Adapters

| Adapter | Use |
|---|---|
| `MongoAdapter` | Sync against MongoDB. `bulkWrite` upserts + soft-deletes, `_monlite_v` cursor for polling, change streams for live (`watch`). |
| `PostgresAdapter` | Sync against PostgreSQL. Each collection maps to a `jsonb` table; `INSERT … ON CONFLICT` upserts + soft-deletes, `_monlite_v` cursor for polling. Keep local monlite as the embedded runtime and Postgres as the cloud of record. |
| `MySqlAdapter` | Sync against MySQL / MariaDB. Each collection maps to a `json` table; `INSERT … ON DUPLICATE KEY UPDATE` upserts + soft-deletes, `_monlite_v` cursor for polling. |
| `MonliteAdapter` | Use another sync-enabled monlite database as the remote — monlite-to-monlite replication (e.g. multi-device via a shared hub). |
| `MemoryAdapter` | In-memory remote for tests and as a reference implementation. |

```ts
import { sync, PostgresAdapter } from "@monlite/sync";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
sync(db, {
  adapter: new PostgresAdapter({ pool }), // optional: schema, collectionMap
  collections: ["todos"],
});
```

`mongodb`, `pg`, and `mysql2` are optional peer dependencies — install only the
one your adapter needs.

Write your own by implementing `SyncAdapter` (`pull` / `push` / optional `watch`).

## Modes

- `"pull"` — local read-replica of the remote.
- `"push"` — local is the source; remote is a backup/aggregate.
- `"two-way"` — bidirectional with LWW conflict resolution (default).

## Conflicts

Last-write-wins by version by default. Provide a function for custom logic:

```ts
sync(db, {
  adapter,
  conflict: ({ collection, _id, local, remote }) =>
    remote.version > local.version ? "remote" : "local",
});
```

Every resolved conflict is recorded in the local conflict log
(`db.$sync.conflicts()`).

## Events

`engine` is an `EventEmitter`: `start`, `sync` (round stats), `change`,
`conflict`, `retry` (`{ label, attempt, delayMs, error }`), `error`, `stop`.

## Resilience

A flaky network or a momentary remote outage shouldn't drop data:

- **Per-operation retries.** A failed `pull`/`push` is retried with exponential
  backoff + jitter (`retries`, default 4; `retryBaseMs`, default 200) before the
  round fails — finer-grained than the poll-loop backoff, and it also protects
  one-shot `engine.sync()` calls. Safe because `pull` is read-only and `push` is
  idempotent (LWW by `_id`+version). Each attempt emits a `retry` event.
- **No partial-failure data loss.** A change is marked pushed **only** once the
  remote acks it; anything unacked (or lost when retries are finally exhausted)
  stays queued and is re-sent on the next round. Re-sends are idempotent, so a
  push that applied remotely but failed before acking is reconciled, not
  duplicated. The pull cursor advances only after a batch is fully applied.

## Status & limitations

- Works against any monlite SQLite backend (`better-sqlite3` or built-in `node:sqlite`).
- The engine and all adapters are covered by end-to-end tests. `MongoAdapter`
  is verified against a **live MongoDB replica set** (push, pull, two-way
  convergence, soft-deletes, and **change streams**) in CI's `mongo` job.
- **Both document and structured collections sync.** For a structured
  collection, open it with its `schema` on each node before syncing so every
  side knows the native columns.
- Conflict resolution is last-write-wins by version; a node that wins a conflict
  re-propagates its value so the two ends converge.

## License

MIT 🌙
