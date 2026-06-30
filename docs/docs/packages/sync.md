---
id: sync
title: "@monlite/sync"
---

# @monlite/sync — local-first replication

Replicate a local monlite database to and from a cloud of record — **MongoDB,
PostgreSQL, MySQL/MariaDB, another monlite, or memory** — without giving up the
local-first model. Your app reads and writes a single `.db` file at native speed;
sync moves changes to and from the remote in the background. Pull / push /
two-way, with last-write-wins or a custom conflict resolver, retries, and an
optional live stream.

```bash
npm install @monlite/sync
# plus the remote's driver, as a peer:
npm install mongodb        # MongoAdapter
npm install pg             # PostgresAdapter
npm install mysql2         # MySqlAdapter
```

```ts
import { createDb } from "@monlite/core";
import { sync, MongoAdapter } from "@monlite/sync";
import { MongoClient } from "mongodb";

const db = createDb("app.db", { sync: true });   // sync metadata must be enabled
const mongo = await new MongoClient(process.env.MONGO_URL!).connect();

const engine = sync(db, {
  adapter: new MongoAdapter({ client: mongo, db: "app" }),
  collections: "*",        // or ["users", "orders"]
  mode: "two-way",         // "pull" | "push" | "two-way"
  conflict: "lww",         // or a (ctx) => "local" | "remote" resolver
  interval: 5_000,         // poll every 5s (omit for manual .sync() only)
  live: true,              // also stream remote changes if the adapter supports it
});

await engine.start();      // bootstrap, run one round, begin scheduling/streaming
// ... app runs, writes flow both ways ...
await engine.stop();
```

## Enable sync metadata first

Replication needs a change feed, tombstones, and per-document versions. Open the
database with `{ sync: true }` so monlite tracks them — it is **off by default**
and adds zero overhead when disabled:

```ts
const db = createDb("app.db", { sync: true });
```

A stable `nodeId` (used for last-write-wins tie-breaking) is auto-generated and
persisted on first sync-enabled open; pass `nodeId` to `createDb` to set it
explicitly. The engine throws if you hand it a database that wasn't opened with
`{ sync: true }`.

## How it works

monlite's sync metadata gives every write an ordered sequence number and a
version string (`makeVersion(ts, nodeId)` — a timestamp plus a node tiebreak).
The engine drives a [`SyncAdapter`](#custom-adapters) each round:

- **Push** — every local write is enqueued on `db.$sync`. Each round, the engine
  drains the pending queue (in `batchSize` chunks) and calls
  `adapter.push(changes)`. A change is marked pushed **only** once the adapter
  acks it; anything unacked re-sends next round. Pushes are idempotent (keyed by
  `_id` + version), so a retried or duplicated push is safe.
- **Pull** — the engine calls `adapter.pull(cursor, { collections, limit })`,
  applies each `RemoteChange` through `db.$sync.applyRemote(change, resolver)`,
  then advances the cursor. The cursor advances only after the batch applies, so
  a crash mid-pull simply re-pulls.
- **Live** (`live: true`) — if the adapter implements `watch()` (e.g. Mongo
  change streams), the engine subscribes and applies remote changes as they
  arrive, in between polls.

The cursor is opaque to the engine. The SQL/Mongo adapters page each collection
by `version > cursor` and track a **per-collection** cursor — a single global
cursor would permanently skip a lagging collection once another's versions run
ahead and the `LIMIT` cuts it short.

A backlog never has to fit in one round: `batchSize` (default 500) bounds each
pull/push, and the rest drains over subsequent rounds.

## Modes and collections

| `mode` | Direction |
|---|---|
| `"pull"` | remote → local only |
| `"push"` | local → remote only |
| `"two-way"` (default) | both — pull, then push, each round |

`collections` is `"*"` (default — all local collections) or an explicit list.
Both **document** and **structured (columnar)** collections sync. On the first
push run, documents that pre-date sync being enabled are seeded into the push
queue, so the initial bootstrap is complete.

## Conflict handling

When a pull delivers a change for a document that also changed locally, the
resolver decides the winner:

- **`"lww"` (default)** — last write wins, comparing version strings (timestamp,
  then `nodeId` as a deterministic tiebreak). No coordination needed.
- **A custom resolver** — a pure function returning `"local"` or `"remote"`:

```ts
const engine = sync(db, {
  adapter,
  conflict: ({ collection, _id, local, remote }) => {
    // local.version, remote.version, remote.doc are available
    if (collection === "ledger") return "remote"; // server is authoritative
    return local.version > remote.version ? "local" : "remote";
  },
});

engine.on("conflict", (change) => log.warn("conflict on", change._id));
```

The resolver runs for both polled pulls and live-streamed changes. Applied
changes emit `change`; conflicts emit `conflict` and count toward
`status().conflicts`.

## Two-way sync, end to end

```ts
const db = createDb("app.db", { sync: true });
const engine = sync(db, {
  adapter: new PostgresAdapter({ pool }),
  mode: "two-way",
  interval: 3_000,
});

await engine.start();

// A local write is queued, pushed next round, and lands in Postgres.
await db.collection("orders").create({ data: { total: 42, status: "open" } });

// A change made in Postgres (by another node) is pulled and applied locally;
// engine.on("change", ...) fires as remote changes arrive.
```

Run the same engine on every node, all pointed at the shared remote, and they
converge — each node pushes its writes and pulls everyone else's, LWW settling
concurrent edits.

## Resilience

A flaky network won't drop or duplicate data:

- Failed `pull`/`push` retry with exponential backoff + jitter (`retries`,
  default 4; `retryBaseMs`, default 200ms — set `retries: 0` to disable). Each
  attempt emits a `retry` event. This is safe because pull is read-only and push
  is idempotent.
- The poll loop itself backs off exponentially (up to ~60s) after consecutive
  failed rounds, then recovers to `interval` once a round succeeds.
- Timers are `unref`'d, so a running engine never keeps the process alive on its
  own.

## API

```ts
const engine = sync(db, options);   // create; pass { autoStart: true } to start now
new SyncEngine(db, options);        // same, without auto-start

await engine.start();   // bootstrap + first round + scheduling/streaming
await engine.sync();    // force a single round now (returns SyncRoundStats)
await engine.stop();    // stop scheduling + streaming (idempotent)
engine.status();        // SyncStatus snapshot
```

### `SyncOptions`

| Option | Default | Meaning |
|---|---|---|
| `adapter` | — | the replication backend (required) |
| `collections` | `"*"` | `"*"` (all local) or an explicit list |
| `mode` | `"two-way"` | `"pull"` \| `"push"` \| `"two-way"` |
| `conflict` | `"lww"` | `"lww"` or a `ConflictResolver` |
| `interval` | — | poll cadence in ms; omit for manual `.sync()` only |
| `batchSize` | `500` | max changes per pull/push round |
| `retries` | `4` | per-operation retry count (0 disables) |
| `retryBaseMs` | `200` | base backoff (ms) for retries |
| `live` | `false` | subscribe via `adapter.watch` if available |
| `remote` | adapter name | state key for cursors/pointers |
| `autoStart` | `false` | call `.start()` on creation |

### `status()` → `SyncStatus`

```ts
{
  running: boolean;
  remote: string;
  mode: SyncMode;
  pendingPush: number;   // local changes not yet acked
  conflicts: number;     // unresolved conflicts recorded
  cursor: string | null; // current pull position
  lastPullAt: number | null;
  lastPushAt: number | null;
  failures: number;      // consecutive failed rounds (drives backoff)
}
```

### Events

`SyncEngine` is an `EventEmitter`: `start`, `sync` (a `SyncRoundStats`), `change`
(a `RemoteChange` applied), `conflict`, `retry`, `error`, `stop`.

```ts
engine.on("sync", (s) => console.log(`+${s.pushed} pushed, ${s.applied} applied`));
engine.on("error", (err) => log.error(err));
```

## Adapters

| Adapter | Remote | Notes |
|---|---|---|
| `MongoAdapter` | MongoDB | `bulkWrite` upserts; live `watch()` via change streams (needs a replica set). monlite `_id`s map 1:1 to Mongo `ObjectId`s. |
| `PostgresAdapter` | PostgreSQL | one `jsonb` table per collection, auto-created. Polling only. |
| `MySqlAdapter` | MySQL / MariaDB | one `json` table per collection, auto-created. Polling only. |
| `MonliteAdapter` | another monlite | monlite-to-monlite (e.g. multi-device via a shared hub). In-process, no external service. |
| `MemoryAdapter` | in-memory | tests and a reference implementation. |

Every adapter takes a `collectionMap` to rename collections on the remote, and a
`name` to override the state/cursor key. The SQL adapters store each document as
`(_id, doc, _monlite_v, _monlite_deleted)`; the Mongo adapter carries the version
in `_monlite_v` and soft-deletes via `_monlite_deleted`, so changes round-trip
without echoing.

```ts
import { MongoAdapter, PostgresAdapter, MySqlAdapter } from "@monlite/sync";

new MongoAdapter({ client: mongoClient, db: "app" });
new PostgresAdapter({ pool: pgPool, schema: "public" });
new MySqlAdapter({ pool: mysql2Pool });
```

## Custom adapters

Any backend that can store changes and page them by version can be a sync target.
Implement the `SyncAdapter` interface (`name`, `pull`, `push`, and an optional
`watch`) and pass an instance as `adapter`. The engine handles ordering,
batching, retries, cursors, and conflict resolution — the adapter only moves
bytes:

```ts
interface SyncAdapter {
  readonly name: string;
  pull(cursor: Cursor, opts: PullOptions): Promise<PullResult>;
  push(changes: LocalChange[]): Promise<PushResult>;
  watch?(cursor: Cursor, onChange: (c: RemoteChange) => void, opts: PullOptions): Unsubscribe;
}
```

See the [custom adapter guide](/guides/custom-adapter) for a full walkthrough.

## Postgres as a cloud of record vs. `@monlite/postgres`

These are different tools. `@monlite/sync` keeps the database **local** and
replicates to Postgres in the background — ideal for offline-first apps and edge
nodes. [`@monlite/postgres`](/packages/postgres) instead **runs the entire
monlite API directly on Postgres** (no local file), for a networked, multi-writer
backend. Develop locally, then either sync to the cloud or swap the engine —
the same collection API either way.
