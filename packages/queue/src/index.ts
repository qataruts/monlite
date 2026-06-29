import { EventEmitter } from "node:events";
import type { Monlite } from "@monlite/core";

export type JobStatus = "pending" | "active" | "done" | "failed";

export interface Job<T = any> {
  id: number;
  queue: string;
  /** Dedupe key, if the job was added with one. */
  jobId?: string;
  status: JobStatus;
  priority: number;
  payload: T;
  /** Number of attempts already made (0 until the first run). */
  attempts: number;
  maxAttempts: number;
  runAt: number;
  result?: any;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AddOptions {
  /** Dedupe key — skip if a job with this id is already pending/active. */
  jobId?: string;
  /** Delay before the job becomes runnable (ms). */
  delay?: number;
  /** Explicit epoch-ms run time (overrides `delay`). */
  runAt?: number;
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Total attempts before dead-lettering. Default: the queue's `maxAttempts`. */
  maxAttempts?: number;
}

export interface ProcessOptions {
  /** Jobs run concurrently per worker. Default 1. */
  concurrency?: number;
  /** How often to poll for due jobs when idle (ms). Default 500. */
  pollInterval?: number;
  /**
   * Visibility timeout (ms). If set, a crashed worker's job is automatically
   * reclaimed: a job that stays `active` without a heartbeat for this long is
   * returned to `pending`. While a handler runs, its job is heartbeated so a
   * legitimately long job isn't reaped. Off by default (jobs are never reaped).
   */
  visibilityTimeout?: number;
}

export interface QueueOptions {
  /** Default attempts before dead-lettering. Default 1 (no retry). */
  maxAttempts?: number;
  /** Backoff before retry N (ms). Default: exponential, capped at 30s. */
  backoff?: (attempt: number) => number;
  /** Delete jobs once completed instead of keeping them as `done`. Default false. */
  removeOnComplete?: boolean;
  /** Identifies this worker process in the `locked_by` column. */
  workerId?: string;
}

export type Handler<T = any, R = any> = (job: Job<T>) => Promise<R> | R;

export interface Worker {
  /** Stop claiming new jobs and wait for in-flight ones to finish. */
  stop(): Promise<void>;
}

interface Row {
  id: number;
  queue: string;
  status: JobStatus;
  priority: number;
  run_at: number;
  attempts: number;
  max_attempts: number;
  payload: string;
  result: string | null;
  error: string | null;
  job_id: string | null;
  created_at: number;
  updated_at: number;
}

const ensured = new WeakSet<object>();
const now = () => Date.now();
const defaultBackoff = (attempt: number) =>
  Math.min(30_000, 1000 * 2 ** (attempt - 1));

function deserialize(row: Row): Job {
  return {
    id: row.id,
    queue: row.queue,
    jobId: row.job_id ?? undefined,
    status: row.status,
    priority: row.priority,
    payload: JSON.parse(row.payload),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    result: row.result != null ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class WorkerImpl implements Worker {
  private running = true;
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private drainResolve: (() => void) | undefined;
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly visibilityTimeout: number;
  private reaper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly q: Queue,
    readonly name: string,
    private readonly handler: Handler,
    opts: ProcessOptions,
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.pollInterval = opts.pollInterval ?? 500;
    this.visibilityTimeout = Math.max(0, opts.visibilityTimeout ?? 0);
    if (this.visibilityTimeout > 0) {
      this.reaper = setInterval(
        () => {
          if (this.running) this.q.recover(this.visibilityTimeout, this.name);
        },
        Math.max(1000, Math.floor(this.visibilityTimeout / 2)),
      );
      this.reaper.unref?.();
    }
    this.kick();
  }

  /** Fill spare capacity with claimable jobs; otherwise schedule a poll. */
  kick(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.running && this.inFlight < this.concurrency) {
      const job = this.q.claimInternal(this.name);
      if (!job) break;
      this.inFlight++;
      // Heartbeat the job while it runs so the reaper's visibility timeout won't
      // reclaim a legitimately long-running job.
      let hb: ReturnType<typeof setInterval> | undefined;
      if (this.visibilityTimeout > 0) {
        hb = setInterval(
          () => this.q.heartbeatInternal(job.id, job.attempts),
          Math.max(1000, Math.floor(this.visibilityTimeout / 2)),
        );
        hb.unref?.();
      }
      Promise.resolve()
        .then(() => this.handler(job))
        .then(
          (result) => {
            // Only emit if the write landed — a fenced-out (reclaimed) job is now
            // owned by another worker, which will emit its own result.
            if (this.q.completeInternal(job, result))
              this.q.emit("completed", job, result);
          },
          (err) => {
            if (this.q.failInternal(job, err)) this.q.emit("failed", job, err);
          },
        )
        .finally(() => {
          if (hb) clearInterval(hb);
          this.inFlight--;
          if (this.running) this.kick();
          else this.checkDrained();
        });
    }
    if (this.running && this.inFlight < this.concurrency) {
      this.timer = setTimeout(() => this.kick(), this.pollInterval);
      this.timer.unref?.();
    }
  }

  private checkDrained(): void {
    if (!this.running && this.inFlight === 0 && this.drainResolve) {
      this.drainResolve();
      this.drainResolve = undefined;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.reaper) clearInterval(this.reaper);
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
  }
}

/**
 * A durable, multi-process-safe job queue backed by SQLite. Producers `add`
 * jobs; workers `process` them with retries, backoff, delays, and concurrency.
 * Emits `"completed"` (job, result) and `"failed"` (job, error).
 */
export class Queue extends EventEmitter {
  private readonly driver: Monlite["driver"];
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly removeOnComplete: boolean;
  readonly workerId: string;
  private readonly workers: WorkerImpl[] = [];

  constructor(db: Monlite, opts: QueueOptions = {}) {
    super();
    this.driver = db.driver;
    this.maxAttempts = opts.maxAttempts ?? 1;
    this.backoff = opts.backoff ?? defaultBackoff;
    this.removeOnComplete = opts.removeOnComplete ?? false;
    // `process` is absent in the browser — fall back to a random id there.
    this.workerId =
      opts.workerId ??
      `w-${typeof process !== "undefined" && process.pid ? process.pid : Math.floor(Math.random() * 1e6)}`;

    if (!ensured.has(db)) {
      this.driver.exec(
        `CREATE TABLE IF NOT EXISTS _jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          queue TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL,
          run_at INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
          payload TEXT NOT NULL, result TEXT, error TEXT, locked_by TEXT, job_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )`,
      );
      // Add job_id to pre-existing tables (idempotent).
      try {
        this.driver.exec(`ALTER TABLE _jobs ADD COLUMN job_id TEXT`);
      } catch {
        /* column already exists */
      }
      this.driver.exec(
        `CREATE INDEX IF NOT EXISTS _jobs_claim ON _jobs (queue, status, priority, run_at)`,
      );
      this.driver.exec(
        `CREATE INDEX IF NOT EXISTS _jobs_jobid ON _jobs (job_id)`,
      );
      ensured.add(db);
    }
  }

  /**
   * Enqueue a job. Pass `opts.jobId` to **dedupe**: if a job with that id is
   * already pending or active, the existing job is returned instead of adding a
   * duplicate (idempotent enqueue — e.g. for resume/replay).
   */
  add<T = any>(name: string, payload: T, opts: AddOptions = {}): Job<T> {
    const t = now();
    if (opts.jobId) {
      const existing = this.driver
        .prepare(
          `SELECT * FROM _jobs WHERE job_id = ? AND status IN ('pending','active') LIMIT 1`,
        )
        .get(opts.jobId) as Row | undefined;
      if (existing) return deserialize(existing) as Job<T>;
    }
    const runAt = opts.runAt ?? (opts.delay ? t + opts.delay : t);
    const info = this.driver
      .prepare(
        `INSERT INTO _jobs (queue, status, priority, run_at, attempts, max_attempts, payload, job_id, created_at, updated_at)
         VALUES (?, 'pending', ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        opts.priority ?? 0,
        runAt,
        opts.maxAttempts ?? this.maxAttempts,
        JSON.stringify(payload ?? null),
        opts.jobId ?? null,
        t,
        t,
      );
    const job = this.getJob(Number(info.lastInsertRowid))!;
    for (const w of this.workers) if (w.name === name) w.kick();
    return job as Job<T>;
  }

  /** Register a worker for a queue. Returns a handle with `stop()`. */
  process<T = any, R = any>(
    name: string,
    handler: Handler<T, R>,
    opts: ProcessOptions = {},
  ): Worker {
    const w = new WorkerImpl(this, name, handler as Handler, opts);
    this.workers.push(w);
    return w;
  }

  getJob<T = any>(id: number): Job<T> | undefined {
    const row = this.driver
      .prepare(`SELECT * FROM _jobs WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? (deserialize(row) as Job<T>) : undefined;
  }

  /** Count jobs by status (optionally for one queue). */
  counts(name?: string): Record<JobStatus, number> {
    const rows = (
      name
        ? this.driver
            .prepare(
              `SELECT status, COUNT(*) AS n FROM _jobs WHERE queue = ? GROUP BY status`,
            )
            .all(name)
        : this.driver
            .prepare(`SELECT status, COUNT(*) AS n FROM _jobs GROUP BY status`)
            .all()
    ) as Array<{ status: JobStatus; n: number }>;
    const out: Record<JobStatus, number> = {
      pending: 0,
      active: 0,
      done: 0,
      failed: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /**
   * Reset jobs stuck in `active` (e.g. from a crashed worker) back to `pending`
   * if they haven't been touched in `olderThanMs`. Returns the count recovered.
   * Pass `name` to scope it to one queue — the per-worker reaper does this so a
   * fast queue's reaper can't reclaim a slow queue's still-running jobs.
   */
  recover(olderThanMs = 60_000, name?: string): number {
    const filter = name ? " AND queue = ?" : "";
    const params: any[] = name
      ? [now(), now() - olderThanMs, name]
      : [now(), now() - olderThanMs];
    return this.driver
      .prepare(
        `UPDATE _jobs SET status='pending', locked_by=NULL, updated_at=?
         WHERE status='active' AND updated_at < ?${filter}`,
      )
      .run(...params).changes;
  }

  /** @internal Extend a running job's visibility timeout (worker heartbeat). */
  heartbeatInternal(id: number, attempts: number): void {
    // Fence on the claim-time attempt: don't heartbeat a job that was already
    // reclaimed (attempts bumped) by another worker.
    this.driver
      .prepare(
        `UPDATE _jobs SET updated_at=? WHERE id=? AND status='active' AND attempts=?`,
      )
      .run(now(), id, attempts);
  }

  /** Stop all workers and wait for in-flight jobs to finish. */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.stop()));
  }

  /** @internal Atomically claim the next due job, counting the attempt. */
  claimInternal(name: string): Job | null {
    const t = now();
    const row = this.driver
      .prepare(
        `UPDATE _jobs SET status='active', attempts=attempts+1, locked_by=?, updated_at=?
         WHERE id = (
           SELECT id FROM _jobs
           WHERE queue=? AND status='pending' AND run_at<=?
           ORDER BY priority DESC, id ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(this.workerId, t, name, t) as Row | undefined;
    return row ? deserialize(row) : null;
  }

  /**
   * @internal Mark a job done. Returns false if the job was reclaimed by another
   * worker since this one claimed it (fenced on the claim-time attempt) — the
   * caller then skips emitting "completed" so a revived stale worker can't clobber
   * the new run or fire a duplicate event.
   */
  completeInternal(job: Job, result: unknown): boolean {
    if (this.removeOnComplete) {
      return (
        this.driver
          .prepare(`DELETE FROM _jobs WHERE id=? AND attempts=?`)
          .run(job.id, job.attempts).changes > 0
      );
    }
    return (
      this.driver
        .prepare(
          `UPDATE _jobs SET status='done', result=?, error=NULL, updated_at=? WHERE id=? AND attempts=?`,
        )
        .run(JSON.stringify(result ?? null), now(), job.id, job.attempts)
        .changes > 0
    );
  }

  /** @internal Record a failure (retry or dead-letter). Returns false if fenced out (see completeInternal). */
  failInternal(job: Job, err: unknown): boolean {
    // `job.attempts` was already incremented at claim time; it also fences this
    // write against a job another worker has since reclaimed.
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempts < job.maxAttempts) {
      return (
        this.driver
          .prepare(
            `UPDATE _jobs SET status='pending', run_at=?, error=?, locked_by=NULL, updated_at=? WHERE id=? AND attempts=?`,
          )
          .run(
            now() + this.backoff(job.attempts),
            message,
            now(),
            job.id,
            job.attempts,
          ).changes > 0
      );
    }
    return (
      this.driver
        .prepare(
          `UPDATE _jobs SET status='failed', error=?, updated_at=? WHERE id=? AND attempts=?`,
        )
        .run(message, now(), job.id, job.attempts).changes > 0
    );
  }
}

/** Create a job queue over a monlite database. */
export function createQueue(db: Monlite, opts?: QueueOptions): Queue {
  return new Queue(db, opts);
}
