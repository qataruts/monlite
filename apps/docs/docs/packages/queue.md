---
id: queue
title: "@monlite/queue"
---

# @monlite/queue — durable job queue

A BullMQ-style job queue over SQLite — durable, transactional, multi-process safe.

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
  a dead worker.

`queue.counts(name?)` → `{ pending, active, done, failed }`.
