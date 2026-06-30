---
id: queue
title: "@monlite/queue"
---

# @monlite/queue — durable job queue

A BullMQ-style job queue in a file — durable, transactional, multi-process safe.
Producers `add` jobs; workers `process` them with retries, backoff, delays,
priorities, concurrency, rate limiting, and dead-lettering. On the SQLite engine
it's `createQueue(db)` (synchronous); on the [Postgres engine](/packages/postgres)
it's [`createPgQueue(db)`](#postgres-engine-createpgqueue) (async, claiming with
`FOR UPDATE SKIP LOCKED` so workers across processes never contend).

```bash
npm install @monlite/queue
```

```ts
import { createDb } from "@monlite/core";
import { createQueue } from "@monlite/queue";

const db = createDb("app.db");
const queue = createQueue(db, { maxAttempts: 3 });

// Worker
queue.process("email", async (job) => { await sendEmail(job.payload); }, { concurrency: 5 });
queue.on("completed", (job, result) => console.log("sent", job.id, result));
queue.on("failed", (job, err) => console.warn("failed", job.id, err.message));

// Producer
queue.add("email", { to: "ali@example.com" });
queue.add("digest", { day: "mon" }, { delay: 60_000, priority: 10, jobId: "digest-mon" });
```

## Adding jobs

`add(name, payload, opts?)` enqueues a job onto queue `name` and returns the
created (or, when deduped, existing) `Job`.

```ts
queue.add("resize", { url }); // run as soon as a worker is free
queue.add("resize", { url }, { delay: 5_000 }); // not before 5s from now
queue.add("resize", { url }, { runAt: Date.now() + 60_000 }); // exact epoch-ms run time
queue.add("resize", { url }, { priority: 10 }); // higher runs first (default 0)
queue.add("resize", { url }, { maxAttempts: 5 }); // override the queue default
queue.add("nightly", {}, { jobId: "nightly-2026-06-30" }); // dedupe key
```

| `AddOptions` | Description |
|---|---|
| `jobId` | dedupe key — if a job with this id is already `pending`/`active` **on this queue**, the existing job is returned instead of adding a duplicate (idempotent enqueue, e.g. resume/replay) |
| `delay` | ms to wait before the job becomes runnable |
| `runAt` | explicit epoch-ms run time (overrides `delay`) |
| `priority` | higher runs first within a queue. Default `0` |
| `maxAttempts` | total attempts before dead-lettering. Default: the queue's `maxAttempts` |

Dedupe is scoped per queue: the same `jobId` on a different queue is a different
job. A dedupe match returns the existing job rather than throwing, so enqueues are
safely idempotent.

## Processing jobs

`process(name, handler, opts?)` registers a worker for queue `name` and returns a
`Worker` handle with `stop()`. The handler receives the `Job`; its return value
becomes `job.result` and is passed to the `completed` event. A throw triggers a
retry (or dead-letter once attempts are exhausted).

```ts
const worker = queue.process(
  "email",
  async (job) => {
    await sendEmail(job.payload); // job.payload, job.id, job.attempts, …
    return { messageId: "abc" }; // becomes job.result + the `completed` arg
  },
  {
    concurrency: 5, // up to 5 jobs in flight per worker (default 1)
    pollInterval: 500, // poll for due jobs every 500ms when idle (default)
    maxPollInterval: 5_000, // adaptive idle backoff cap (see below)
    rateLimit: { count: 10, windowMs: 1000 }, // ≤ 10 jobs/sec (see below)
    visibilityTimeout: 30_000, // auto-reclaim crashed jobs after 30s (see below)
  },
);

await worker.stop(); // stop claiming, wait for in-flight jobs to drain
```

| `ProcessOptions` | Description |
|---|---|
| `concurrency` | jobs run concurrently per worker. Default `1` |
| `pollInterval` | how often to poll for due jobs when idle (ms). Default `500` |
| `maxPollInterval` | cap for adaptive idle backoff (ms); when above `pollInterval`, an idle worker doubles its interval after each empty poll and resets on activity. Default: equal to `pollInterval` (no backoff) |
| `rateLimit` | `{ count, windowMs }` sliding-window throttle, **per worker**. Off by default |
| `visibilityTimeout` | ms after which a stalled `active` job (no heartbeat) is reclaimed to `pending`. Off by default |

### The `Job` object

```ts
interface Job<T = any> {
  id: number; // auto-increment job id — key external side-effects on this
  queue: string;
  jobId?: string; // the dedupe key, if added with one
  status: "pending" | "active" | "done" | "failed";
  priority: number;
  payload: T;
  attempts: number; // attempts already made (0 until the first run)
  maxAttempts: number;
  runAt: number; // epoch ms
  result?: any; // set on success
  error?: string; // last error message
  createdAt: number;
  updatedAt: number;
}
```

### Events

The queue is an `EventEmitter`:

```ts
queue.on("completed", (job, result) => { /* job succeeded */ });
queue.on("failed", (job, err) => { /* job threw (a retry OR final dead-letter) */ });
```

`failed` fires on every failed attempt, including retries; check
`job.attempts >= job.maxAttempts` to detect a final dead-letter.

## Retries, backoff & dead-letter

A handler that throws is retried up to `maxAttempts` times; after that the job is
dead-lettered (`status: "failed"`, keeping its last `error`). The delay before
retry N defaults to exponential backoff capped at 30s — override it:

```ts
const queue = createQueue(db, {
  maxAttempts: 5, // default attempts before dead-lettering (default 1 = no retry)
  backoff: (attempt) => attempt * 2_000, // custom backoff per attempt (ms)
  removeOnComplete: true, // delete jobs on success instead of keeping them as `done`
  workerId: "billing-1", // identifies this process in the locked_by column
});
```

| `QueueOptions` | Description |
|---|---|
| `maxAttempts` | default attempts before dead-lettering. Default `1` (no retry) |
| `backoff` | `(attempt) => ms` delay before retry N. Default: exponential, capped at 30s |
| `removeOnComplete` | delete jobs once completed instead of keeping them as `done`. Default `false` |
| `workerId` | identifies this worker process in the `locked_by` column |

## Crash recovery & at-least-once

- **Atomic claim** — workers grab the next due job with a single
  `UPDATE … RETURNING` (highest `priority`, then oldest), so multiple worker
  **processes** can drain the same db without ever running the same job twice.
- **Manual recovery** — `queue.recover(olderThanMs?, name?)` requeues jobs left
  `active` by a dead worker (default `60_000` ms); returns the count recovered.
  Pass `name` to scope it to one queue.
- **Automatic reaper** — `process(..., { visibilityTimeout })` runs a reaper: a
  job that stays `active` longer than the timeout without a heartbeat is returned
  to `pending`. While a handler runs, its job is heartbeated, so a legitimately
  long job isn't reaped.
- **Execution is at-least-once.** The claim is exactly-once, but recovery (manual
  or `visibilityTimeout`) can re-run a crashed/slow worker's job — make handlers
  **idempotent** (key external side-effects on `job.id`). Once a job is reclaimed,
  the original (revived) worker is **fenced out**: its late completion is ignored
  and fires no duplicate `completed`/`failed` event.

```ts
queue.counts(); // { pending, active, done, failed } across all queues
queue.counts("email"); // …for one queue
queue.getJob(42); // a Job by id, or undefined
queue.recover(); // requeue jobs stuck active > 60s (e.g. on startup)
await queue.close(); // stop every worker and drain in-flight jobs
```

| Method | Description |
|---|---|
| `add(name, payload, opts?)` | enqueue a job; returns the `Job` |
| `process(name, handler, opts?)` | register a worker; returns a `Worker` (`stop()`) |
| `getJob(id)` | look up a job by id |
| `counts(name?)` | `{ pending, active, done, failed }`, optionally for one queue |
| `recover(olderThanMs?, name?)` | requeue jobs stuck `active`; returns the count |
| `close()` | stop all workers and wait for in-flight jobs to finish |

## Rate limiting & idle backoff

```ts
// Throttle a worker to at most 10 jobs/sec (e.g. an external API's limit)
queue.process("call-api", handler, { rateLimit: { count: 10, windowMs: 1000 } });

// Let an idle worker back off instead of polling every 500ms forever
queue.process("rare", handler, { pollInterval: 500, maxPollInterval: 5_000 });
```

- **`rateLimit: { count, windowMs }`** — a sliding-window throttle: the worker
  stops claiming when the window is full and resumes the instant a slot frees.
  **Per-worker** — multiple workers/processes each get their own budget, so run a
  single worker for a global limit. Off by default.
- **`maxPollInterval`** — opt-in adaptive backoff: an idle worker doubles its poll
  interval up to this cap and resets on activity, so a quiet queue stops churning
  the DB. Same-process `add()` and job completion still wake it instantly. With
  backoff on, a job enqueued by *another* process (or a delayed job) may wait up to
  this cap to be picked up. Default = `pollInterval` (unchanged behavior).

All workers' idle polls (plus the reactor, kv pub/sub and cron) share the
database's **single coalesced timer**, so a busy app with many subsystems still
runs one event-loop wakeup, not many.

## Postgres engine: `createPgQueue`

On the [Postgres engine](/packages/postgres), `createPgQueue(db)` runs the same
model over a networked, multi-writer table: the claim is `FOR UPDATE SKIP LOCKED`,
so N workers across N processes each grab a different job with **zero contention**.
The surface mirrors `createQueue`, but database methods are **async** — `await`
them:

```ts
import { createDb } from "@monlite/postgres";
import { createPgQueue } from "@monlite/queue";

const db = createDb("postgres://user@host/db");
const queue = createPgQueue(db, { maxAttempts: 3 });

// process() and the events are the same — register a worker
queue.process("email", async (job) => { await sendEmail(job.payload); }, { concurrency: 5 });
queue.on("completed", (job, result) => console.log("sent", job.id, result));
queue.on("failed", (job, err) => console.warn("failed", job.id, err.message));

// add(), getJob(), counts(), recover(), close() are async
await queue.add("email", { to: "ali@example.com" }, { jobId: "welcome-ali" });
await queue.counts("email"); // { pending, active, done, failed }
await queue.getJob(42);
await queue.recover(); // requeue jobs stuck active
await queue.close();
```

Everything else is identical — `AddOptions`, `ProcessOptions`, `QueueOptions`, the
`Job` shape, retries/backoff, dead-letter, the `completed`/`failed` events, and
the fenced at-least-once semantics. `process()` and the `EventEmitter` API stay
synchronous; only the methods that hit the database (`add`, `getJob`, `counts`,
`recover`, `close`) return Promises. Calling `createQueue()`/`new Queue()` on a
Postgres database (or `createPgQueue()`/`new PgQueue()` on SQLite) throws with a
pointer to the right factory.
