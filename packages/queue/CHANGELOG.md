# @monlite/queue

## 0.4.1 — idle poll on the shared heartbeat

- A worker's idle poll now registers on the database's shared `Heartbeat` (`@monlite/core` ≥ 2.8.0)
  instead of a per-worker `setTimeout`, so multiple workers + the reactor/kv/cron share one timer.
  Same-process `add()` and job completion still call `kick()` directly (instant). No behavior change.

## 0.4.0 — adaptive idle backoff (opt-in)

- **`maxPollInterval` (per `process()`)** enables adaptive idle backoff: an idle worker doubles
  its poll interval after each empty check, up to the cap, and resets to `pollInterval` on any
  activity — so a quiet queue settles into a slow heartbeat instead of polling the DB twice a
  second forever. Same-process `add()` still wakes the worker instantly.
- **Default unchanged** — when `maxPollInterval` is omitted (or equal to `pollInterval`), polling
  is the same fixed interval as before. Note: with backoff on, a job enqueued by *another process*
  / a delayed job may wait up to the cap to be picked up.

## 0.3.5 — correctness fixes (bug hunt)

- **Dedupe by `jobId` is scoped to the queue.** The same `jobId` on a _different_ queue
  was silently dropped (it returned the other queue's job) — now each queue dedupes
  independently.
- **A non-serializable handler result (BigInt / circular) no longer crashes the worker.**
  It was throwing while recording completion and leaving the job stuck `active` with no
  fail/retry/event; results are now serialized defensively (BigInt→string, circular→placeholder).
- **Concurrent `stop()`/`close()` no longer deadlock.** A shared drain promise replaces the
  single resolver that a second `stop()` overwrote, which orphaned the first caller forever.

## 0.3.4 — repackage (dependency fix)

- Republished because 0.3.3 (and 0.3.2) shipped with an unresolved `@monlite/core: "workspace:^"` dependency
  (published via npm instead of pnpm), which cannot install outside the monorepo. No code
  change from 0.3.3 (and 0.3.2); the `@monlite/core` range now correctly resolves to `^2.6.x`.

## 0.3.3 — completion fencing

- **A reclaimed job rejects its original worker's stale write.** After a job is
  recovered (`visibilityTimeout`/`recover()`) and re-claimed by another worker, a
  revived slow/crashed worker could still mark it done/failed — clobbering the new run
  and firing a duplicate event. Completion, failure, and heartbeat are now **fenced on
  the claim-time attempt**; a worker emits `completed`/`failed` only when its write
  lands. Works cross-process and same-process.

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
