/* global process */
// Hammered by tests/crash.test.ts: transfer 1 unit A→B atomically, forever, until
// the parent SIGKILLs us mid-flight. Each transfer conserves A.bal + B.bal, so a
// torn (half-applied) transaction after a crash would break the invariant.
import { createDb } from "../../dist/index.js";

const file = process.argv[2];
const db = createDb(file, { synchronous: "FULL" });

for (;;) {
  await db.transactionAsync(async (tx) => {
    const a = await tx.collection("acct").findById("A");
    const b = await tx.collection("acct").findById("B");
    await tx
      .collection("acct")
      .update({ where: { _id: "A" }, data: { bal: a.bal - 1 } });
    await tx
      .collection("acct")
      .update({ where: { _id: "B" }, data: { bal: b.bal + 1 } });
  });
}
