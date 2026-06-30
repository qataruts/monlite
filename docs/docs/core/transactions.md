---
id: transactions
title: Transactions & CAS
---

# Transactions & compare-and-swap

monlite gives you three levels of atomicity:

1. **Per-method atomicity** — `createMany`, `updateMany`, `deleteMany`, `upsert`, and
   `bulkWrite` each run their whole batch in one transaction already.
2. **Multi-step transactions** — `db.$transaction` / `db.transactionAsync` wrap several
   operations in a single all-or-nothing unit.
3. **Compare-and-swap** — `findOneAndUpdate` with a guard in `where` is an atomic
   read-modify-return that holds even **across processes**.

## `db.$transaction` — synchronous unit

Run a function inside one synchronous transaction. The callback receives the database
handle. If it throws, the whole transaction rolls back.

```ts
await db.$transaction((tx) => {
  tx.collection("accounts").update({ where: { _id: "a" }, data: { $inc: { balance: -100 } } });
  tx.collection("accounts").update({ where: { _id: "b" }, data: { $inc: { balance: +100 } } });
}); // BEGIN … COMMIT; a throw inside rolls everything back
```

The body must be **synchronous** (no `await` inside) — it runs as a SQLite transaction.
When you need to read, compute, then write, use `transactionAsync`.

## `db.transactionAsync` — async unit

`transactionAsync` lets the callback `await` (read → compute → write) inside one
`BEGIN IMMEDIATE … COMMIT`. A throw rolls the whole thing back. This is the right
primitive for read-modify-write logic like a double-entry posting.

```ts
await db.transactionAsync(async (tx) => {
  const accounts = tx.collection("accounts");
  const a = await accounts.findById("a");
  if (!a || a.balance < 100) throw new Error("insufficient funds"); // rolls back

  await accounts.update({ where: { _id: "a" }, data: { $inc: { balance: -100 } } });
  await accounts.update({ where: { _id: "b" }, data: { $inc: { balance: +100 } } });
});
```

Calls are **serialized**: two concurrent `transactionAsync` units can't interleave on
the shared connection, so a `read balances → compute → write debit + credit` sequence is
safe against lost updates. It is also re-entrant — a `transactionAsync` called inside
another's callback nests as a `SAVEPOINT` rather than deadlocking.

`transactionAsync` is the transaction path the [Postgres engine](/packages/postgres)
uses internally for its multi-document writes, so the same atomic-unit code carries over
when you swap engines.

:::warning Do all writes inside the callback
A write issued from **outside** the callback while a `transactionAsync` is in flight
(e.g. from another async task during one of its `await`s) is **rejected with an error**.
On a single connection it would otherwise silently fold into the transaction and be lost
on rollback. Await the transaction first, or move the write into the callback.
:::

## `findOneAndUpdate` — compare-and-swap

The atomic read-modify-return primitive. Match on a guard in `where` (a `version`,
`status`, owner, …), mutate, and return the resulting document — or `null` if the guard
didn't match. `returnDocument` chooses `"before"` or `"after"` (default `"after"`).

The read and write run in one transaction under `BEGIN IMMEDIATE` (the write lock is
taken up front), so the guard is a **true compare-and-swap even across processes**: a
racing writer blocks on the lock, re-reads the already-changed row, finds its guard no
longer matches, and cleanly returns `null` — instead of racing on a stale snapshot or
erroring with `SQLITE_BUSY`.

```ts
// Exactly-once job claim — N workers race, exactly one wins.
const claimed = await jobs.findOneAndUpdate({
  where: { status: "pending" },                 // the guard
  data: { $set: { status: "active", workerId } },
  returnDocument: "after",
});
if (claimed) {
  // we own the job
} else {
  // someone else claimed it (or nothing was pending)
}
```

### Optimistic concurrency (version guard)

```ts
const next = await docs.findOneAndUpdate({
  where: { _id, version: 7 },                   // only if still at version 7
  data: { $set: { body }, $inc: { version: 1 } },
});
if (!next) throw new Error("stale write — reload and retry");
```

This is the load-bearing primitive for durable job queues and multi-process workers.
See the [AI-agent backend guide](/guides/ai-agent-backend).

## Writes index atomically

Plugin index maintenance (FTS, vector, …) runs **inside the same transaction** as the
write that triggered it. If indexing fails — e.g. [`@monlite/vector`](/packages/vector)
rejecting a wrong-dimension vector partway through a `createMany` — the whole write rolls
back, so you never end up with a base row that isn't in the index. The call throws; fix
the data and retry. (Across processes, indexes still reconcile via the plugins' catch-up
pass.)

## Notes & gotchas

- **`$transaction` body is synchronous**; use `transactionAsync` whenever you need to
  `await` between steps.
- **Never write from outside an in-flight `transactionAsync`** — it's rejected by design
  (see the warning above).
- **CAS returns `null` on a lost race**, never an error — branch on the result, don't
  wrap it in try/catch for contention.
- **The same transaction code runs on Postgres.** `transactionAsync` and
  `findOneAndUpdate` behave identically on [`@monlite/postgres`](/packages/postgres),
  where the cross-process CAS is backed by the database's own row locks.
