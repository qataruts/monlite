---
id: transactions
title: Transactions & CAS
---

# Transactions & compare-and-swap

## Synchronous transactions

```ts
db.transaction(() => {
  accounts.update({ where: { _id: "a" }, data: { $inc: { bal: -100 } } });
  accounts.update({ where: { _id: "b" }, data: { $inc: { bal: 100 } } });
}); // BEGIN … COMMIT; a throw rolls everything back
```

## Async transactions

`transactionAsync` lets the callback `await` (read → compute → write) inside one
`BEGIN IMMEDIATE … COMMIT`. It's **serialized**, so concurrent units can't
interleave on the shared connection — no lost updates.

```ts
await db.transactionAsync(async (tx) => {
  const a = await tx.collection("accounts").findById("a");
  if (a!.bal < 100) throw new Error("insufficient");        // rolls back
  await tx.collection("accounts").update({ where: { _id: "a" }, data: { $inc: { bal: -100 } } });
  await tx.collection("accounts").update({ where: { _id: "b" }, data: { $inc: { bal: 100 } } });
});
```

## Compare-and-swap (findOneAndUpdate)

The atomic read-modify-return primitive — match on a guard (`version`/`status`),
mutate, return the new row, or `null` on a lost race. As of `@monlite/core` 2.6.1
the CAS holds **across processes** (runs under `BEGIN IMMEDIATE`), so a separate
worker that loses the race cleanly gets `null` — never a `SQLITE_BUSY` error.

```ts
const claimed = await jobs.findOneAndUpdate({
  where: { _id: jobId, status: "pending" },        // the guard
  data: { $set: { status: "active" }, $inc: { version: 1 } },
  returnDocument: "after",
});
if (claimed) {
  // we own the job
} else {
  // someone else claimed it (or the guard didn't match)
}
```

This is the load-bearing primitive for durable job queues and multi-process
workers. See the [AI-agent backend guide](/guides/ai-agent-backend).
