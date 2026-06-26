# `@monlite/sync` — Design

> Status: **design / not yet implemented**. This document freezes the contract
> and architecture before any code is written. It is the plan for the feature
> that turns monlite from "NeDB on SQLite" into a local-first platform.

---

## 1. Purpose

monlite is a local-first document database. `@monlite/sync` lets a local monlite
file replicate with a remote source of truth — **MongoDB first**, other backends
later — so desktop, CLI, and offline apps can work fully offline and converge
with the cloud when connectivity returns.

This is deliberately a **separate package**. `@monlite/core` stays lean and
dependency-free; apps that don't sync pay nothing.

---

## 2. Goals & non-goals

**Goals**

- **Pluggable adapters** — a small `SyncAdapter` interface; MongoDB is adapter #1, Postgres/CouchDB/HTTP can follow.
- **Offline-first** — queue local mutations, flush on reconnect; never lose a write.
- **Incremental** — transfer only what changed since the last sync (cursors / high-water marks), not the whole collection every time.
- **Predictable conflicts** — Last-Write-Wins by default, with a pluggable resolver.
- **Leverage monlite's ids** — monlite `_id`s are Mongo-compatible ObjectIds, so local↔remote ids map **1:1** with no translation table. This is a real structural advantage and the design leans on it.
- **Minimal core footprint** — sync primitives live behind an opt-in flag.

**Non-goals (v1)**

- Real-time multi-master CRDT convergence (LWW now; CRDT later via the resolver hook).
- Arbitrary server-side filtered replication (start with whole-collection or a simple static filter).
- Local↔local peer sync (focus on local↔remote).
- Shape transformation between local and remote documents (assume same shape; offer `map()` hooks later).

---

## 3. Why this is the moat — and the cost

The hard parts, all of which are where the months go:

1. **Change tracking on both ends** — you cannot sync what you cannot observe changed.
2. **Deletes** — a plain delete leaves no trace; sync needs **tombstones**.
3. **Conflict resolution & clock skew** — "last write" is meaningless without a trustworthy clock.
4. **Idempotency & partial failure** — networks fail mid-batch; every apply must be replayable.
5. **Initial (bulk) sync vs steady-state incremental** — the first sync of a large dataset is a different problem from the 100th.

A *correct* two-way engine is a multi-month effort with ongoing edge-case
maintenance. The phased roadmap (§12) front-loads the cheap, high-value slice
(one-way pull) and defers the expensive slice (two-way live).

---

## 4. The sync contract — what `@monlite/core` must provide

Sync is impossible without a few primitives. Some already exist; the rest are
**additive and gated** behind `createDb(path, { sync: true })` (or auto-enabled
when `@monlite/sync` attaches), so non-sync users keep zero overhead.

| Primitive | Status | Notes |
|---|---|---|
| Stable, globally-unique id | ✅ have | ObjectId, **Mongo-compatible** → 1:1 id mapping |
| Per-doc `updated_at` | ✅ have | Basis for LWW |
| **Local change feed (oplog)** | ➕ new | Append-only `_monlite_changes(seq, collection, _id, op, version, ts)`, written *in the same transaction* as every mutation when sync is on |
| **Tombstones** | ➕ new | Deletes recorded as `op='delete'` (id retained); row removed but tombstone kept until pushed + past a retention window |
| **Per-doc version / clock** | ➕ new | v1: `updated_at` (ms) + `nodeId` tiebreak. v2: **HLC** (hybrid logical clock) to survive wall-clock skew |
| Sync state | ➕ new | `_monlite_sync_state(remote, collection, pull_cursor, push_seq, last_pull_at, last_push_at)` |

> **Decision to make before M1:** adopt an HLC up front or start with
> `updated_at`+`nodeId`. HLC changes the on-disk version format, so retrofitting
> later is a migration. Leaning toward shipping `updated_at`+`nodeId` in M1 and
> reserving a `version` column wide enough to hold an HLC later. (See §13.)

---

## 5. Architecture

```
                      @monlite/sync
   ┌──────────────────────────────────────────────────┐
   │  Engine (orchestrator)                            │
   │   • reads local change feed (push)                │
   │   • applies remote changes (pull)                 │
   │   • conflict resolution                           │
   │   • cursors + state persistence                   │
   │   • scheduling: interval / reconnect / live       │
   └───────────────┬───────────────────────────────────┘
                   │  SyncAdapter
        ┌──────────▼───────────┐    ┌───────────────────┐
        │  MongoAdapter        │    │ (future)          │
        │   pull(cursor)       │    │  PostgresAdapter  │
        │   push(changes)      │    │  HttpAdapter      │
        │   watch?(cursor)     │    │  CouchAdapter     │
        └──────────────────────┘    └───────────────────┘
                   │
            user-supplied authed client (e.g. MongoClient)
```

### 5.1 `SyncAdapter` interface

```ts
type Op = "upsert" | "delete";

interface RemoteChange {
  collection: string;
  _id: string;             // ObjectId hex
  op: Op;
  doc?: Record<string, any>; // present for upsert
  version: Version;          // remote authoritative version
}

interface LocalChange {
  seq: number;             // local change-feed sequence
  collection: string;
  _id: string;
  op: Op;
  doc?: Record<string, any>;
  version: Version;
}

interface PullResult { changes: RemoteChange[]; cursor: Cursor }
interface PushResult { acked: number[]; rejected?: { seq: number; reason: string }[] }

interface SyncAdapter {
  /** Fetch remote changes since `cursor` (null = from the beginning). */
  pull(cursor: Cursor | null, opts: PullOptions): Promise<PullResult>;
  /** Apply local changes to the remote. Idempotent, keyed by `_id`. */
  push(changes: LocalChange[]): Promise<PushResult>;
  /** Optional live stream (e.g. Mongo change streams). */
  watch?(cursor: Cursor | null, onChange: (c: RemoteChange) => void): Unsubscribe;
}
```

### 5.2 Engine responsibilities

- **Pull loop:** `adapter.pull(cursor)` → resolve each remote change against the
  local doc → apply (upsert/delete) → advance `pull_cursor`.
- **Push loop:** read change feed where `seq > push_seq` → `adapter.push(batch)`
  → on `acked` advance `push_seq`; on `rejected` (server-side conflict) run
  conflict resolution and retry.
- **Scheduling:** on an interval, on reconnect, and/or driven by `watch()`.
- **Applied-from-remote changes do not re-enter the local change feed** (avoid
  echo/infinite loops) — they are written with a "synced" marker.

---

## 6. Conflict resolution

- **Default — Last-Write-Wins** by `version` (`updated_at`, tiebreak `nodeId`).
  Deterministic and explainable.
- **Pluggable** — `conflict: (local, remote) => "local" | "remote" | mergedDoc`.
- **Observability** — every conflict is written to `_monlite_conflicts` for
  inspection / manual review, even when auto-resolved.
- **Granularity** — doc-level in v1; per-field or CRDT strategies slot in behind
  the same resolver hook later.

---

## 7. Data flow

**Cursors**

- *Pull cursor* (remote→local): a Mongo change-stream **resume token**, or a
  high-water mark over a server `updatedAt` + `_id` when polling.
- *Push pointer* (local→remote): the last successfully-pushed change-feed `seq`.

**Initial sync (bootstrap)**

| Local | Remote | Strategy |
|---|---|---|
| empty | has data | Bulk **pull** (paginated); insert as already-synced (no echo into feed) |
| has data | empty | Bulk **push** |
| has data | has data | **Reconcile**: fetch remote `{_id, version}` set, diff against local, transfer only deltas. The expensive case — paginated + resumable |

**Steady state** — incremental pull + incremental push; all applies are
idempotent upserts keyed by `_id`, so at-least-once delivery is safe.

**Deletes**

- Local delete → feed `op=delete` (tombstone) → pushed as remote delete.
- Remote delete → applied locally as delete + tombstone.
- Tombstones GC'd once confirmed on both sides **and** past a retention window.

---

## 8. MongoDB adapter specifics

- **Ids:** monlite ObjectId hex ↔ Mongo `ObjectId` — stored as a real `ObjectId`
  on the wire, 1:1. No mapping table. *(The headline benefit of monlite's id scheme.)*
- **Pull (live):** `collection.watch()` change streams; persist the resume token
  as the cursor. Change-stream events carry `operationType`, `documentKey._id`,
  and (for inserts/updates with full-document lookup) the document.
- **Pull (catch-up / no streams):** poll `find({ updatedAt: { $gt: hw } }).sort({ updatedAt: 1, _id: 1 })` with a compound high-water mark.
- **Deletes:** change streams emit `delete` with only `documentKey._id` → map to
  a tombstone. **Without** change streams, plain Mongo deletes are invisible to
  polling, so the server must use **soft-deletes** (a `deletedAt` field). This is
  a documented requirement of the polling mode.
- **Push:** `bulkWrite` with `replaceOne({_id}, doc, {upsert:true})` for upserts
  and `deleteOne({_id})` for tombstones.
- **Transport/auth:** the user supplies a connected `MongoClient`. `@monlite/sync`
  treats `mongodb` as a **peer dependency** and never bundles a driver or
  handles credentials itself.

---

## 9. User-facing API (sketch)

```ts
import { createDb } from "@monlite/core";
import { sync, MongoAdapter } from "@monlite/sync";
import { MongoClient } from "mongodb";

const db = createDb("./app.db", { sync: true });   // enables the change feed
const mongo = new MongoClient(uri);
await mongo.connect();

const engine = sync(db, {
  adapter: new MongoAdapter({ client: mongo, db: "app" }),
  collections: ["users", "orders"],   // or "*"
  mode: "two-way",                    // "pull" | "push" | "two-way"
  conflict: "lww",                    // or (local, remote) => winner
  interval: 5000,                     // poll cadence; or live via change streams
});

engine.on("change", (e) => {/* doc applied from remote */});
engine.on("conflict", (c) => {/* resolved or needs attention */});
engine.on("error", (e) => {/* transport/backoff */});

await engine.start();   // bootstrap + begin loops
await engine.sync();    // force one round now
engine.status();        // { cursors, pendingPush, lastPullAt, lastError }
await engine.stop();
```

---

## 10. Modes / topologies

| Mode | Use case | Effort | Order |
|---|---|---|---|
| **pull-only** | Local read-replica of cloud (desktop dashboards) | ~1–2 weeks | **Ship first** |
| **push-only** | Local is source; cloud is backup/aggregate | small | second |
| **two-way LWW** | The headline feature | multi-week | third |

---

## 11. Edge cases & risks

- **Clock skew** → HLC or server-authoritative versions; never trust raw client wall-clock for ordering.
- **Partial failure / retries** → idempotent upserts + ack-based pointers + at-least-once.
- **Large initial sync** → pagination, resumable bootstrap, backpressure.
- **Schema drift** → optional per-collection `map()` hooks (deferred).
- **Security** → never bundle remote drivers; user supplies an authed client; offer field-redaction hooks.
- **Tombstone growth** → retention policy + GC.
- **Reconnect storms** → debounce + jittered exponential backoff.
- **Echo loops** → remote-applied changes must not re-enter the local feed.

---

## 12. Phased roadmap

- **M0 — this document.** Freeze the `SyncAdapter` contract and the core sync-contract primitives (§4).
- **M1 — core primitives** in `@monlite/core` behind `{ sync: true }`: change feed, tombstones, `version`/`nodeId`, sync-state tables. No network.
- **M2 — `@monlite/sync` + `MongoAdapter`, pull-only.** A working desktop read-replica. **Ship.**
- **M3 — push + two-way LWW**, including bulk-bootstrap reconcile.
- **M4 — live** via Mongo change streams; pluggable conflict resolvers; conflict log.
- **M5 — a second adapter** (Postgres or HTTP) to prove the abstraction holds.

---

## 13. Open questions

1. **HLC now or later?** Affects the on-disk `version` format and is a migration if deferred. *(Leaning: ship `updated_at`+`nodeId` in M1, reserve a wide `version` column.)*
2. **Replication scope for v1** — whole-collection vs a static server-side filter.
3. **Where sync state lives** — inside the same `.db` (portable, atomic with data) vs a sidecar file. *(Leaning: same `.db`.)*
4. **Delete propagation contract** — require Mongo change streams, or mandate server-side soft-deletes for polling mode? Probably support both and document the trade-off.
5. **Multi-device fan-out** for the same user — a later concern, but the cursor/version model should not preclude it.
6. **Backpressure & batch sizing** defaults for large syncs.

---

*This doc is the M0 deliverable. No code ships until the `SyncAdapter` contract
and the §4 primitives are agreed.*
