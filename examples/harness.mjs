// The local "agent harness": cache + queue + cron in one embedded db (the Redis
// roles, locally). Run: node harness.mjs
import { createDb } from "@monlite/core";
import { kv } from "@monlite/kv";
import { createQueue } from "@monlite/queue";
import { createCron, nextCronRun } from "@monlite/cron";

const db = createDb(":memory:");

// Cache (Redis-style, synchronous) with TTL
const cache = kv(db);
cache.set("greeting", "hello", { ttl: 60_000 });
console.log("🔑 kv:", cache.get("greeting"), "| incr:", cache.incr("hits", 2));

// Durable job queue
const queue = createQueue(db, { maxAttempts: 3 });
const done = new Promise((r) =>
  queue.on("completed", (_job, result) => r(result)),
);
queue.process("greet", (job) => `Hi ${job.payload.name}!`, { pollInterval: 5 });
queue.add("greet", { name: "Ali" });
console.log("📨 queue:", await done);

// Cron — compose with the queue for durable scheduled work
const cron = createCron(db, { checkInterval: 10 });
cron.schedule("nightly", "0 0 * * *", () =>
  queue.add("greet", { name: "cron" }),
);
console.log(
  "⏰ cron 'nightly' next:",
  new Date(cron.next("nightly")).toLocaleString(),
);
console.log("⏰ next Monday 09:00:", nextCronRun("0 9 * * 1").toDateString());

cron.stop();
await queue.close();
await db.$disconnect();
