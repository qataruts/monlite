---
id: realtime
title: Realtime & change feed
---

# Realtime & change feed

monlite has a local-first reactivity layer built on three primitives: live result-set
queries (`collection.watch()`), single-document listeners (`collection.watchDoc()`), and a
durable, ordered **change feed** (`db.changes()`) that also delivers writes made by other
processes sharing the same `.db`.

```ts
const users = db.collection("users");

const sub = users.watch(
  { where: { role: "admin" }, orderBy: { name: "asc" } },
  (event) => {
    // fires immediately with the current matches, then on every relevant change
    renderAdminList(event.results);
  },
);
// later
sub.stop();
```

The reactivity layer is **additive and zero-overhead until used**. `watch()` works out of the
box, in-process, with no configuration. The durable change feed and cross-process delivery are
opt-in (`{ changefeed: true }`) and add nothing until you turn them on.

## Live queries — `collection.watch()`

`watch(args, cb)` registers a live query. The callback fires once **immediately** with the
current result set (`type: "init"`), then again every time a change actually affects that result
set. Changes that don't touch the query are filtered out at the row level — an unrelated write
never triggers a recompute.

```ts
const sub = orders.watch({ where: { status: "open" } }, (event) => {
  console.log(event.type); // "init" first, then "change"
});

sub.results; // the current result set, kept up to date
sub.stop();  // unsubscribe
```

`watch()` returns a `WatchHandle`:

| Member | Description |
|---|---|
| `results` | the current result set, always up to date (same as the last event's `results`) |
| `stop()` | unsubscribe; no further callbacks fire |

### `WatchArgs`

`WatchArgs` is a `findMany` query plus one reactive-only field (`fields`). All of the read
options shape both the initial snapshot and which rows the live query tracks:

| Field | Meaning |
|---|---|
| `where` | filter — the result set is exactly the documents that match |
| `orderBy` | sort order; required to receive `moved` deltas (see below) |
| `select` | project the emitted documents to a subset of fields |
| `take` | cap the result set size (e.g. a top-N leaderboard) |
| `skip` | offset into the ordered result set |
| `fields` | only emit a `"change"` when one of these fields changes (field-scoped; see below) |

```ts
// A live top-10 leaderboard.
scores.watch(
  { orderBy: { points: "desc" }, take: 10, select: { name: true, points: true } },
  (event) => render(event.results),
);
```

Projection via `select` is applied only at the emit boundary — identity and diffing always run
on the full document internally, so a `select` that omits `_id` or a changed field can never
corrupt the deltas.

### The `LiveEvent` deltas

Every callback receives a `LiveEvent`. Beyond the full `results`, it carries structural deltas so
you can update the UI incrementally instead of re-rendering everything:

| Field | Meaning |
|---|---|
| `type` | `"init"` for the first delivery, `"change"` for every update after |
| `results` | the full current result set (projected by `select`, if any) |
| `added` | documents that entered the result set since the last event |
| `removed` | documents that left the result set |
| `changed` | documents still in the set whose contents changed this tick |
| `moved` | documents whose **position** changed — only for an ordered (`orderBy`) query; `undefined` otherwise |
| `changedFields` | per-document map (`_id` → field names) of the fields that actually changed value |

```ts
todos.watch({ where: { done: false }, orderBy: { rank: "asc" } }, (event) => {
  for (const t of event.added) addRow(t);
  for (const t of event.removed) removeRow(t._id);
  for (const t of event.changed) updateRow(t, event.changedFields?.[t._id] ?? []);
  for (const t of event.moved ?? []) repositionRow(t);
});
```

Notes on the delta semantics:

- A document is `changed` only when it is present before **and** after the tick and was actually
  written this tick — detection uses the change set, not `updated_at`, so even same-millisecond
  edits are caught.
- `changedFields` ignores the system timestamps `created_at` / `updated_at`.
- `moved` is rank-based: it reports a surviving document whose index among the *survivors*
  changed, so it isn't noise from documents merely being added or removed around it. It is only
  populated for ordered queries.

### Field-scoped watching

Pass `fields` to suppress `"change"` events unless one of the listed fields actually changed.
Documents entering (`added`), leaving (`removed`), or moving (`moved`) still always fire — only
pure content changes are filtered.

```ts
// Re-render only when `status` changes; edits to other fields are ignored.
orders.watch({ where: { open: true }, fields: ["status"] }, (event) => {
  updateStatusBadges(event.changed);
});
```

### `collection.watchDoc()`

`watchDoc(id, cb)` is a single-document listener, in the style of Firestore's `onSnapshot(doc)`.
The callback fires immediately with the current document (or `null` if it does not exist) and
again on every change to it — **including a delete, which delivers `null`**.

```ts
const sub = orders.watchDoc("o-123", (doc, event) => {
  if (!doc) {
    console.log("deleted");
  } else {
    render(doc);
  }
});
sub.stop();
```

It is implemented on top of `watch({ where: { _id: id }, take: 1 })`, so it carries the same
`LiveEvent` as its second argument if you need the deltas.

## The change feed — `db.changes()`

The change feed is an ordered, durable log of every write. Turn it on at `createDb` with
`{ changefeed: true }` (or `{ sync: true }`, which implies it):

```ts
const db = createDb("./app.db", { changefeed: true });
```

With it on, every write appends one row to the feed: a create or update is an `"upsert"`, a
delete is a `"delete"`. The feed includes writes from **other processes** on the same file and
changes applied by [`@monlite/sync`](/packages/sync). It is the durable backbone behind both
sync and cross-process reactivity.

```ts
let lastSeq = 0;
for await (const ev of db.changes("orders", { since: lastSeq, signal })) {
  // ev: { seq, collection, id, op: "upsert" | "delete", ts }
  lastSeq = ev.seq; // persist to resume exactly here after a restart
  await project(ev);
}
```

Each `ChangeEvent` has:

| Field | Meaning |
|---|---|
| `seq` | monotonic cursor — pass back as `since` to resume strictly after this event |
| `collection` | the collection the change belongs to |
| `id` | the document `_id` |
| `op` | `"upsert"` (create/update) or `"delete"` |
| `ts` | wall-clock epoch milliseconds when the change was recorded |

The change-feed API on `db`:

| Method | Purpose |
|---|---|
| `db.changes(collection?, { since, pollMs, signal })` | streaming `AsyncIterableIterator<ChangeEvent>`, resumable by `seq`; omit `collection` for all collections |
| `db.changesSince(collection, since, limit?)` | non-streaming pull of events with `seq > since` (default `limit` 1000) |
| `db.currentSeq()` | the highest `seq` so far (0 if empty) — a cursor to start a "only new changes" stream |
| `db.compactChanges({ keepLast })` | bound feed growth; drops old entries but never an unpushed local change that sync still needs |

`db.changes()` polls (`pollMs`, default `200`) so it picks up cross-process writes; break the
loop or abort the `signal` to stop. Calling any change-feed method without the feed enabled
throws — open with `{ changefeed: true }` or `{ sync: true }`.

### Resumable, cross-process projections

Because the feed is durable and resumable by `seq`, you can build a crash-safe projection or an
outbox/relay: persist the last `seq` you processed, and on restart resume strictly after it. No
events are missed across a restart, and writes from sibling processes flow through the same feed.

## Cross-process reactivity

With the change feed on, `watch()` is **driven by the feed** rather than only by in-process
writes — so a write from **another process or connection** to the same `.db` fires your local
watchers:

```ts
const db = createDb("./app.db", { changefeed: true, reactorPollMs: 200 });
db.collection("orders").watch({ where: { status: "open" } }, render);
// A different process writing to ./app.db now updates this watcher.
```

Same-process writes still notify watchers **immediately** (after the write commits — watchers
never see uncommitted or rolled-back data). Writes from other processes are picked up every
`reactorPollMs` (default `200`, minimum `20`). With the feed **off**, `watch()` is purely
in-process — the default, with zero overhead.

This cross-process poll — along with the [`@monlite/kv`](/packages/kv) pub/sub, the
[`@monlite/queue`](/packages/queue) idle poll, and [`@monlite/cron`](/packages/cron) — shares the
database's **single coalesced timer** (`db.heartbeat`): one event-loop wakeup serves all of them,
armed only for the soonest-due task, and none at all when nothing is registered. The poll is
allocated only while at least one watcher is registered and released when the last one stops.

## Realtime on the Postgres engine

`watch()` and `watchDoc()` work identically on the [`@monlite/postgres`](/packages/postgres)
engine — **same API, same `LiveEvent` deltas** (`added` / `removed` / `changed` / `moved` /
`changedFields`), same field-scoping. The delta engine (`computeLiveEvent`) is shared between the
SQLite and Postgres paths, so the two can never diverge; only how the next result set is fetched
differs.

```ts
import { postgres } from "@monlite/postgres";

const db = createDb("ignored", { driver: postgres({ connectionString: process.env.DATABASE_URL }) });

db.collection("orders").watch({ where: { status: "open" } }, (event) => {
  render(event.results); // identical event shape to SQLite
});
```

On Postgres, realtime is implemented over native `LISTEN/NOTIFY`: a per-table trigger NOTIFYs a
`monlite_<table>` channel with the changed `_id` on **every write from any connection**, so live
queries are **truly cross-process** without any polling — a write from a different client,
process, or machine fires your watchers. The reactor coalesces NOTIFYs arriving in the same tick
(a brief debounce) and re-queries each affected watcher once, then runs the same diff. Tearing
down the last watcher `UNLISTEN`s; `db.$disconnect()` closes the listener connections.

> Building a networked, multi-client realtime service (push to browsers/mobile) on top of the
> feed is the job of the `@monlite/realtime` package — the change feed is the durable, resumable
> backbone it streams from.
