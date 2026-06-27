/* global process */
// Used by tests/cas-cross-process.test.ts. A separate process races to claim a
// job via findOneAndUpdate's compare-and-swap (status: pending -> active). With
// the BEGIN IMMEDIATE hardening, exactly one worker wins; the rest cleanly get
// null (LOST) instead of throwing SQLITE_BUSY_SNAPSHOT on a stale WAL snapshot.
import { createDb } from "../../dist/index.js";

const [file, jobId] = process.argv.slice(2);
const db = createDb(file, { synchronous: "FULL" });
try {
  const won = await db.collection("jobs").findOneAndUpdate({
    where: { _id: jobId, status: "pending" },
    data: { $set: { status: "active" }, $inc: { version: 1 } },
    returnDocument: "after",
  });
  process.stdout.write(won ? "WON" : "LOST");
} catch (e) {
  process.stdout.write("ERR:" + (e.code || e.message));
} finally {
  await db.$disconnect();
}
