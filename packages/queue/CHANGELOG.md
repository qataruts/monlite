# @monlite/queue

## 0.3.2 — per-queue reaper scope

- **The visibility-timeout reaper is scoped to its own queue.** `recover()` reset stale
  `active` jobs across *all* queues, so a fast queue's reaper could reclaim (and double-run)
  a slow queue's still-running job. The per-worker reaper now filters by its queue; the public
  `recover()` keeps the full sweep. Docs clarify execution is **at-least-once** (idempotency).

## 0.3.0–0.3.1 — opt-in visibility timeout

- **`process(…, { visibilityTimeout })`** — an automatic reaper requeues a job whose worker
  stopped heartbeating past the timeout, while a running job is heartbeated so a legitimately
  long job isn't requeued. Crash recovery without a manual `recover()` call.

## 0.2.0

- `add(name, payload, { jobId })` — dedupe: if a job with that id is already pending/active, the existing job is returned instead of enqueuing a duplicate (idempotent enqueue for resume/replay). `Job.jobId` exposed.

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release.

- Durable SQLite job queue: `add`/`process` with atomic claim (`UPDATE … RETURNING`), retries + exponential backoff, delayed/`runAt` jobs, priorities, concurrency, dead-letter, `completed`/`failed` events, `counts`, and `recover` for crashed workers. Multi-process safe; works on both drivers.
