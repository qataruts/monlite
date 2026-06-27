---
id: sync
title: "@monlite/sync"
---

# @monlite/sync — local-first replication

Replicate a local monlite database to/from MongoDB, PostgreSQL, MySQL, another
monlite, or memory. Pull / push / two-way / live, with last-write-wins or custom
conflict resolution.

```bash
npm install @monlite/sync
```

```ts
import { createDb } from "@monlite/core";
import { sync, MongoAdapter } from "@monlite/sync";

const db = createDb("app.db", { sync: true });

const engine = sync(db, {
  adapter: new MongoAdapter({ client: mongo, db: "app" }),
  collections: ["users", "orders"], // or "*"
  mode: "two-way",                   // "pull" | "push" | "two-way"
  conflict: "lww",                   // or (ctx) => "local" | "remote"
  interval: 5000,                    // poll cadence (optional)
  retries: 4,                        // retry a failed round before failing
});

await engine.start();   // bootstrap + begin syncing
await engine.sync();    // force one round
engine.status();        // { running, pendingPush, conflicts, cursor, … }
await engine.stop();
```

## Adapters

| Adapter | Use |
|---|---|
| `MongoAdapter` | MongoDB (change streams for live) |
| `PostgresAdapter` | PostgreSQL (`jsonb` tables) — local runtime, Postgres as cloud-of-record |
| `MySqlAdapter` | MySQL / MariaDB (`json` tables) |
| `MonliteAdapter` | monlite-to-monlite (multi-device via a shared hub) |
| `MemoryAdapter` | tests / reference implementation |

## Resilience

A flaky network won't drop data: failed `pull`/`push` retry with exponential
backoff (`retries`, `retryBaseMs`), and a change is marked pushed **only** on
remote ack — anything unacked re-sends next round (idempotent via LWW). The pull
cursor advances only after a batch fully applies.

Both document **and** structured collections sync. Write a [custom
adapter](/guides/custom-adapter) for any other backend.
