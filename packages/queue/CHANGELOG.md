# @monlite/queue

## 0.2.0

- `add(name, payload, { jobId })` — dedupe: if a job with that id is already pending/active, the existing job is returned instead of enqueuing a duplicate (idempotent enqueue for resume/replay). `Job.jobId` exposed.

## 0.1.1

- Allow `@monlite/core` 2.0 (dependency range `^2.0.0`). No API changes.

## 0.1.0

- Initial release.

- Durable SQLite job queue: `add`/`process` with atomic claim (`UPDATE … RETURNING`), retries + exponential backoff, delayed/`runAt` jobs, priorities, concurrency, dead-letter, `completed`/`failed` events, `counts`, and `recover` for crashed workers. Multi-process safe; works on both drivers.
