---
id: realtime
title: Realtime & change feed
---

# Realtime & change feed

monlite has a local-first reactivity layer: live queries (`watch()`), single-document
listeners (`watchDoc()`), and a durable, ordered **change feed** that also delivers writes
from other processes sharing the same `.db`.

> On the [`@monlite/postgres`](../packages/postgres) engine, `watch()` works the same way over
> Postgres `LISTEN/NOTIFY` — a per-table trigger notifies on every write from any connection, so
> live queries are truly cross-process. The same delta engine computes added/removed/changed/moved.

All of it is **additive and opt-in** — the change feed adds nothing until you turn it on.

## Live queries — `collection.watch()`

`watch(args, cb)` delivers an initial snapshot (`type: "init"`) and then re-fires only when a
relevant change lands (row-level matching — irrelevant writes don't trigger a recompute).

```ts
const stop = users.watch(
  { where: { role: "admin" }, orderBy: { name: "asc" } },
  ({ type, results, added, removed, changed, moved, changedFields }) => {
    renderAdminList(results);
  },
);
// later: stop()
```

The event includes structural deltas:

| Field | Meaning |
|---|---|
| `added` | documents that entered the result set |
| `removed` | documents that left |
| `changed` | documents still in the set whose contents changed |
| `moved` | documents whose **position** changed (ordered queries only) |
| `changedFields` | per-document (`_id` → field names) list of fields that actually changed |

### Watch a single document

```ts
const stop = orders.watchDoc("o-123", (doc, event) => {
  if (!doc) console.log("deleted");
  else render(doc);
});
```

### Fire only on specific fields

```ts
// Emits only when `status` changes; edits to other fields are ignored.
// (added / removed / moved still always fire.)
orders.watch({ where: { open: true }, fields: ["status"] }, onChange);
```

## The change feed

Turn it on with `{ changefeed: true }` (or `{ sync: true }`, which implies it):

```ts
const db = createDb("./app.db", { changefeed: true });
```

Every write appends an ordered entry you can stream — including writes from **other processes**
on the same file and changes applied by [`@monlite/sync`](../packages/sync):

```ts
for await (const ev of db.changes("orders", { since: lastSeq, signal })) {
  // ev = { seq, collection, id, op: "upsert" | "delete", ts }
  lastSeq = ev.seq; // persist to resume exactly here after a restart
}
```

| Method | Purpose |
|---|---|
| `db.changes(collection?, { since, pollMs, signal })` | streaming `AsyncIterable`, resumable by `seq` |
| `db.changesSince(collection, since, limit?)` | non-streaming pull |
| `db.currentSeq()` | highest `seq` so far — a cursor for "only new" |
| `db.compactChanges({ keepLast })` | bound feed growth (never drops unpushed sync changes) |

## Cross-process reactivity

With the change feed on, `watch()` is driven by the feed — so a write in **another process or
connection** to the same `.db` fires your local watchers:

```ts
const db = createDb("./app.db", { changefeed: true, reactorPollMs: 200 });
db.collection("orders").watch({ where: { status: "open" } }, render);
// A different process writing to ./app.db now updates this watcher.
```

Same-process writes still notify immediately; other processes are picked up every
`reactorPollMs` (default `200`). With the feed **off**, `watch()` is purely in-process (the
default, zero overhead).

This cross-process poll — along with `@monlite/kv` pub/sub, the `@monlite/queue` idle poll and
`@monlite/cron` — runs on the database's **single coalesced timer** (`db.heartbeat`): one
event-loop wakeup for all of them, armed only for the soonest-due task, and none at all when
nothing is registered.

> Building a networked, multi-client realtime service (push to browsers/mobile) on top of this
> feed is the `@monlite/realtime` package's job — the feed is the durable, resumable backbone it
> streams from.
