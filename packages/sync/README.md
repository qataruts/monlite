# @monlite/sync

Local-first sync for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core) —
replicate your local SQLite database to MongoDB, PostgreSQL, MySQL, or another monlite instance.

Work fully offline. Converge with a remote source of truth when you reconnect. Last-write-wins
conflict resolution by default, or provide your own.

```ts
import { createDb } from "@monlite/core";
import { sync, MongoAdapter } from "@monlite/sync";
import { MongoClient } from "mongodb";

const db = createDb("./app.db", { sync: true }); // enable the change feed
const mongo = new MongoClient(uri);
await mongo.connect();

const engine = sync(db, {
  adapter: new MongoAdapter({ client: mongo, db: "app" }),
  collections: ["users", "orders"], // or "*" for all
  mode: "two-way",                  // "pull" | "push" | "two-way"
  conflict: "lww",                  // or a custom (ctx) => "local" | "remote" function
  interval: 5000,                   // poll cadence in ms
  retries: 4,                       // retries per operation before a round fails
});

await engine.start();   // bootstrap + begin syncing
await engine.sync();    // force one round
engine.status();        // { running, pendingPush, conflicts, cursor, … }
await engine.stop();
```

## Install

```bash
npm install @monlite/core @monlite/sync

# Add only the adapter peer dependency you need:
npm install mongodb   # for MongoAdapter
npm install pg        # for PostgresAdapter
npm install mysql2    # for MySqlAdapter
```

## How it works

When opened with `{ sync: true }`, `@monlite/core` records every document write in an
append-only **change feed** with tombstones for deletes and a last-write-wins **version**
(timestamp + nodeId). The sync engine:

1. **Pulls** remote changes since a saved cursor and applies them locally, resolving conflicts.
2. **Pushes** unsent local changes to the remote (idempotent, keyed by `_id`).

monlite `_id`s are MongoDB ObjectId-compatible — no translation table. Versions travel with the
data so changes never echo back into an infinite loop.

## Adapters

| Adapter | Remote | Notes |
|---|---|---|
| `MongoAdapter` | MongoDB | `bulkWrite` upserts + soft-deletes, change streams for live `watch` |
| `PostgresAdapter` | PostgreSQL | Each collection maps to a `jsonb` table; `INSERT … ON CONFLICT` |
| `MySqlAdapter` | MySQL / MariaDB | Each collection maps to a `json` table; `INSERT … ON DUPLICATE KEY UPDATE` |
| `MonliteAdapter` | Another monlite db | Monlite-to-monlite replication (e.g. multi-device via a shared hub) |
| `MemoryAdapter` | In-memory | For tests and as a reference implementation |

```ts
// PostgreSQL example
import { sync, PostgresAdapter } from "@monlite/sync";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
sync(db, {
  adapter: new PostgresAdapter({ pool }),
  collections: ["todos"],
});
```

Write your own by implementing the `SyncAdapter` interface (`pull` / `push` / optional `watch`).
See the [custom adapter guide](../../docs/docs/guides/custom-adapter.md).

## Modes

- `"pull"` — local is a read-replica of the remote.
- `"push"` — local is the source; remote is a backup or aggregate.
- `"two-way"` — bidirectional with LWW conflict resolution (default).

## Conflicts

Last-write-wins by version (timestamp + nodeId) by default. Provide a function for custom logic:

```ts
sync(db, {
  adapter,
  conflict: ({ collection, _id, local, remote }) =>
    remote.version > local.version ? "remote" : "local",
});
```

Every resolved conflict is recorded in the local conflict log — inspect with `db.$sync.conflicts()`.

## Events

The engine is an `EventEmitter`: `start`, `sync` (round stats), `change`, `conflict`,
`retry` (`{ label, attempt, delayMs, error }`), `error`, `stop`.

## Resilience

A flaky network or momentary outage won't lose data:

- **Per-operation retries.** A failed `pull`/`push` is retried with exponential backoff + jitter
  (`retries`, default 4; `retryBaseMs`, default 200) before the round fails. Safe because `pull`
  is read-only and `push` is idempotent (LWW by `_id` + version). Each attempt emits `retry`.
- **No partial-failure loss.** A change is marked pushed only after the remote acks it. Anything
  unacked stays queued and is re-sent on the next round. Re-sends are idempotent. The pull
  cursor advances only after a batch is fully applied.

## Notes

- Both document and structured collections sync. For structured collections, open with the same
  `schema` on each node so both sides know the native columns.
- `MongoAdapter` is verified against a live MongoDB replica set (push, pull, two-way
  convergence, soft-deletes, and change streams) in CI.
- Works on both monlite backends (`better-sqlite3` and built-in `node:sqlite`).

## License

MIT
