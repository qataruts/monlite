# @monlite/queue

A **durable job queue** for [`@monlite/core`](https://www.npmjs.com/package/@monlite/core), backed by SQLite — retries, backoff, delayed jobs, priorities, and concurrency, with no separate server. Part of the [local AI-agent harness](https://github.com/qataruts/monlite#readme) (the BullMQ/Redis role, locally).

```bash
npm install @monlite/core @monlite/queue
```

## Quick start

```ts
import { createDb } from "@monlite/core";
import { createQueue } from "@monlite/queue";

const db = createDb("app.db");
const queue = createQueue(db, { maxAttempts: 3 });

// Worker
queue.process("email", async (job) => {
  await sendEmail(job.payload);
}, { concurrency: 5 });

queue.on("completed", (job) => console.log("sent", job.id));
queue.on("failed", (job, err) => console.warn("failed", job.id, err.message));

// Producer
queue.add("email", { to: "ali@example.com" });
queue.add("digest", { day: "mon" }, { delay: 60_000, priority: 10 });
```

## Features

- **Durable & transactional** — jobs live in SQLite, so nothing is lost on crash.
- **Atomic claim** — workers grab jobs with a single `UPDATE … RETURNING`, so it's
  **multi-process safe** (run workers in several processes against the same db).
- **Retries with backoff** — failed jobs retry up to `maxAttempts`; backoff is
  exponential by default (override with `backoff(attempt) => ms`).
- **Delayed / scheduled** — `{ delay }` or `{ runAt }`.
- **Priorities** — higher `priority` runs first.
- **Concurrency** — `{ concurrency }` per worker.
- **Dead-letter** — exhausted jobs become `status: "failed"` and are kept for inspection.

## API

```ts
const queue = createQueue(db, {
  maxAttempts,      // default attempts before dead-lettering (default 1)
  backoff,          // (attempt) => ms; default exponential capped at 30s
  removeOnComplete, // delete finished jobs instead of keeping them (default false)
});

queue.add(name, payload, { delay, runAt, priority, maxAttempts }); // → Job
queue.process(name, handler, { concurrency, pollInterval });       // → Worker
queue.on("completed" | "failed", (job, resultOrError) => {});
queue.getJob(id);                  // Job | undefined
queue.counts(name?);               // { pending, active, done, failed }
queue.recover(olderThanMs);        // requeue jobs stuck "active" from a crash
await worker.stop();               // stop one worker (drains in-flight)
await queue.close();               // stop all workers
```

## Recovering crashed jobs

A worker that dies mid-job leaves the job `active`. Call `queue.recover()` on
startup (or periodically) to requeue jobs that have been `active` longer than a
threshold:

```ts
queue.recover(60_000); // requeue anything stuck > 60s
```

MIT
