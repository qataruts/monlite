# @monlite/queue

A durable job queue for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core), backed
by SQLite — retries, backoff, delayed jobs, priorities, dedupe, and concurrency, with no
separate server. The BullMQ/Redis role, locally.

```bash
npm install @monlite/core @monlite/queue
```

## Quick start

```ts
import { createDb } from "@monlite/core";
import { createQueue } from "@monlite/queue";

const db = createDb("app.db");
const queue = createQueue(db, { maxAttempts: 3 });

// Worker — processes jobs as they arrive
queue.process("email", async (job) => {
  await sendEmail(job.payload);
}, { concurrency: 5 });

queue.on("completed", (job) => console.log("sent", job.id));
queue.on("failed", (job, err) => console.warn("failed", job.id, err.message));

// Producer — enqueue from anywhere, even a different process
queue.add("email", { to: "ali@example.com" });
queue.add("digest", { day: "monday" }, { delay: 60_000, priority: 10 });
```

## Features

**Durable.** Jobs live in SQLite — nothing is lost on crash. On restart, call `queue.recover()`
to requeue any jobs that were `active` when the process died.

**Multi-process safe.** Workers claim jobs with a single `UPDATE … RETURNING`. Run the same
queue in multiple processes against the same `.db`; each job is claimed exactly once.

**Retries with backoff.** Failed jobs retry up to `maxAttempts`; backoff is exponential by
default (capped at 30s). Exhausted jobs become `status: "failed"` and are kept for inspection.

**Delayed and scheduled.** Pass `{ delay: ms }` or `{ runAt: Date }` to defer a job.

**Deduplication.** Pass `{ jobId: "unique-key" }` — a second `add` with the same `jobId` while
the first is pending or active returns the existing job without creating a duplicate.

## API

```ts
const queue = createQueue(db, {
  maxAttempts: 1,    // default attempts before dead-lettering
  backoff: (attempt) => Math.min(1000 * 2 ** attempt, 30_000), // default exponential
  removeOnComplete: false, // delete finished jobs instead of keeping them
});

// Add a job
queue.add(name, payload, { delay?, runAt?, priority?, maxAttempts?, jobId? }); // → Job

// Process jobs
queue.process(name, handler, { concurrency?, pollInterval? }); // → Worker

// Events
queue.on("completed" | "failed", (job, resultOrError) => {});

// Inspect
queue.getJob(id);          // Job | undefined
queue.counts(name?);       // { pending, active, done, failed }

// Crash recovery — requeue jobs stuck "active" from a crashed worker
queue.recover(olderThanMs);

// Shutdown
await worker.stop();   // drain in-flight jobs for one worker
await queue.close();   // stop all workers
```

## Recovering crashed workers

A worker that dies mid-job leaves the job in `active` state. Call `queue.recover()` on startup
(or periodically) to requeue jobs stuck active for longer than a threshold:

```ts
queue.recover(60_000); // requeue anything active for > 60s
```

## Composing with `@monlite/cron`

For **scheduled** durable work, have a cron handler enqueue a job rather than running the work
inline — the schedule is persisted and the work is retried:

```ts
import { createCron } from "@monlite/cron";
const cron = createCron(db);

cron.schedule("nightly-report", "0 0 * * *", () => {
  queue.add("report", { day: new Date().toISOString() });
});
```

## License

MIT
