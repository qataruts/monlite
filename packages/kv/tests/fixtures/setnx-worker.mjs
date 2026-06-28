/* global process */
// Used by tests/setnx-cross-process.test.ts. Separate processes race to acquire
// the same key via setNX. With BEGIN IMMEDIATE, exactly one wins and the rest
// cleanly get `false` (LOST) instead of deadlocking on a lock upgrade and
// throwing SQLITE_BUSY.
import { createDb } from "@monlite/core";
import { kv } from "../../dist/index.js";

const [file] = process.argv.slice(2);
const db = createDb(file, { wal: true, synchronous: "FULL" });
try {
  const won = kv(db).setNX("lock:job", process.pid, { ttl: 60_000 });
  process.stdout.write(won ? "WON" : "LOST");
} catch (e) {
  process.stdout.write("ERR:" + (e.code || e.message));
} finally {
  await db.$disconnect();
}
