---
id: queue
title: "@monlite/queue"
---

# @monlite/queue — durable job queue

A BullMQ-style job queue — durable, transactional, multi-process safe. On
[`@monlite/core`](./postgres) it's `createQueue(db)` (synchronous, SQLite); on
[`@monlite/postgres`](./postgres) it's `createPgQueue(db)` (async, claiming with
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
queue.on("completed", (job) => console.log("sent", job.id));
queue.on("failed", (job, err) => console.warn("failed", job.id, err.message));

// Producer
queue.add("email", { to: "ali@example.com" });
queue.add("digest", { day: "mon" }, { delay: 60_000, priority: 10, jobId: "digest-mon" });
```

- **Atomic claim** — workers grab jobs with a single `UPDATE … RETURNING`, so
  multiple worker **processes** can drain the same db safely.
- **Retries with backoff**, **delayed / scheduled** (`{ delay }` / `{ runAt }`),
  **priorities**, **concurrency**, **dead-letter**.
- **Dedupe** — a second `add` with the same `jobId` while pending/active returns
  the existing job.
- **Crash recovery** — `queue.recover(olderThanMs)` requeues jobs left `active` by
  a dead worker. Or set `process(..., { visibilityTimeout })` for an automatic
  reaper: a job that runs longer than the timeout without a heartbeat is reclaimed,
  while a running job is heartbeated so a legitimately long job isn't requeued.
- **Execution is at-least-once.** The atomic claim is exactly-once, but recovery
  (manual or `visibilityTimeout`) can re-run a crashed/slow worker's job — make
  handlers **idempotent** (key external side-effects on `job.id`). Once a job is
  reclaimed, the original (revived) worker is **fenced out**: its late completion
  is ignored and fires no duplicate `completed`/`failed` event.

`queue.counts(name?)` → `{ pending, active, done, failed }`.

## Rate limiting & idle backoff

```ts
// Throttle a worker to at most 10 jobs/sec (e.g. an external API's limit)
queue.process("call-api", handler, { rateLimit: { count: 10, windowMs: 1000 } });

// Let an idle worker back off instead of polling every 500ms forever
queue.process("rare", handler, { pollInterval: 500, maxPollInterval: 5_000 });
```

- **`rateLimit: { count, windowMs }`** — a sliding-window throttle: the worker stops claiming when
  the window is full and resumes the instant a slot frees. **Per-worker** (run a single worker for
  a global limit). Off by default.
- **`maxPollInterval`** — opt-in adaptive backoff: an idle worker doubles its poll interval up to
  this cap and resets on activity, so a quiet queue stops churning the DB. Same-process `add()` and
  job completion still wake it instantly. Default = `pollInterval` (unchanged behavior).

All workers' idle polls (plus the reactor, kv pub/sub and cron) share the database's **single
coalesced timer**, so a busy app with many subsystems still runs one event-loop wakeup, not many.
