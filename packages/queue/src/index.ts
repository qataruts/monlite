import { EventEmitter } from "node:events";
import type { Monlite, HeartbeatTask } from "@monlite/core";

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
   * Cap for **adaptive idle backoff** (ms). When set above `pollInterval`, an idle
   * worker doubles its poll interval after each empty check (up to this cap) and
   * resets to `pollInterval` on any activity — so a quiet queue settles into a slow
   * heartbeat instead of constant churn, with no cost when busy. Same-process
   * `add()` still wakes the worker instantly. Default: equal to `pollInterval`
   * (no backoff — unchanged behavior). Note: with backoff on, a job enqueued by
   * ANOTHER process / a delayed job may wait up to this cap to be picked up.
   */
  maxPollInterval?: number;
  /**
   * Throttle this worker to at most `count` jobs per `windowMs` (sliding window).
   * The worker stops claiming when the window is full and resumes the instant a
   * slot frees. **Per-worker** — multiple workers / processes each get their own
   * budget (for a global limit, run a single worker). Off by default.
   */
  rateLimit?: { count: number; windowMs: number };
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

/** Serialize a job result, tolerating BigInt / non-JSON values — a quirky handler
 *  result must not throw and leave the job stuck `active` with no fail/retry/event. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    try {
      return JSON.stringify(v, (_k, val) =>
        typeof val === "bigint" ? val.toString() : val,
      );
    } catch {
      return JSON.stringify("[unserializable result]");
    }
  }
}
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
  private task: HeartbeatTask | undefined;
  private drainResolve: (() => void) | undefined;
  private drainPromise: Promise<void> | undefined;
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly maxPollInterval: number;
  /** Current idle poll interval — grows under adaptive backoff, resets on activity. */
  private idleInterval: number;
  private readonly visibilityTimeout: number;
  private reaper: ReturnType<typeof setInterval> | undefined;
  private readonly rateLimit?: { count: number; windowMs: number };
  /** Recent job-start timestamps within the rate-limit window. */
  private starts: number[] = [];

  constructor(
    private readonly q: Queue,
    readonly name: string,
    private readonly handler: Handler,
    opts: ProcessOptions,
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.pollInterval = opts.pollInterval ?? 500;
    this.rateLimit =
      opts.rateLimit && opts.rateLimit.count > 0 && opts.rateLimit.windowMs > 0
        ? opts.rateLimit
        : undefined;
    this.maxPollInterval = Math.max(
      this.pollInterval,
      opts.maxPollInterval ?? this.pollInterval,
    );
    this.idleInterval = this.pollInterval;
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
    let claimedAny = false;
    let rateWaitMs = 0;
    while (this.running && this.inFlight < this.concurrency) {
      if (this.rateLimit) {
        const t = Date.now();
        const cutoff = t - this.rateLimit.windowMs;
        if (this.starts.length)
          this.starts = this.starts.filter((s) => s > cutoff);
        if (this.starts.length >= this.rateLimit.count) {
          // Window full — stop claiming; wake when the oldest start ages out.
          rateWaitMs = this.starts[0] + this.rateLimit.windowMs - t;
          break;
        }
      }
      const job = this.q.claimInternal(this.name);
      if (!job) break;
      if (this.rateLimit) this.starts.push(Date.now());
      claimedAny = true;
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
    // Adaptive idle backoff: reset on activity, otherwise grow toward the cap so a
    // quiet queue stops churning. A no-op when maxPollInterval === pollInterval.
    this.idleInterval = claimedAny
      ? this.pollInterval
      : Math.min(this.idleInterval * 2, this.maxPollInterval);
    // If rate-limited, wake exactly when the window frees a slot (overrides idle
    // backoff); otherwise use the (backed-off) idle interval.
    const nextInterval =
      rateWaitMs > 0 ? Math.max(1, rateWaitMs) : this.idleInterval;
    // Schedule the next poll on the database's shared heartbeat (one timer for all
    // workers + the reactor/kv/cron). Same-process add() and job completion still
    // call kick() directly for instant pickup.
    if (this.running && (rateWaitMs > 0 || this.inFlight < this.concurrency)) {
      if (!this.task) {
        this.task = this.q.heartbeat.every(nextInterval, () => this.kick());
      } else {
        this.task.setInterval(nextInterval);
      }
    }
  }

  private checkDrained(): void {
    if (!this.running && this.inFlight === 0 && this.drainResolve) {
      this.drainResolve();
      this.drainResolve = undefined;
      this.drainPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.task) {
      this.task.cancel();
      this.task = undefined;
    }
    if (this.reaper) clearInterval(this.reaper);
    if (this.inFlight === 0) return;
    // Share ONE drain promise across concurrent stop()/close() calls — overwriting
    // a single resolver would orphan the earlier caller's promise forever.
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });
    }
    return this.drainPromise;
  }
}

/**
 * A durable, multi-process-safe job queue backed by SQLite. Producers `add`
 * jobs; workers `process` them with retries, backoff, delays, and concurrency.
 * Emits `"completed"` (job, result) and `"failed"` (job, error).
 */
export class Queue extends EventEmitter {
  private readonly driver: Monlite["driver"];
  /** @internal Shared heartbeat — workers register their idle poll here. */
  readonly heartbeat: Monlite["heartbeat"];
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly removeOnComplete: boolean;
  readonly workerId: string;
  private readonly workers: WorkerImpl[] = [];

  constructor(db: Monlite, opts: QueueOptions = {}) {
    super();
    if (db.asyncDriver)
      throw new Error(
        "@monlite/queue: the Postgres engine is asynchronous — use `new PgQueue(db)` " +
          "or `createPgQueue(db)` (its methods return Promises). `Queue`/`createQueue()` " +
          "are the synchronous SQLite engine.",
      );
    this.driver = db.driver;
    this.heartbeat = db.heartbeat;
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
      // Scope dedupe to THIS queue — a jobId is unique per queue, not globally;
      // without `queue = ?` a same-jobId job on another queue was silently dropped.
      const existing = this.driver
        .prepare(
          `SELECT * FROM _jobs WHERE job_id = ? AND queue = ? AND status IN ('pending','active') LIMIT 1`,
        )
        .get(opts.jobId, name) as Row | undefined;
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
        .run(safeStringify(result), now(), job.id, job.attempts).changes > 0
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

// ── Postgres engine: async queue over FOR UPDATE SKIP LOCKED ──────────────────
//
// The Queue above is synchronous (one connection, RETURNING claims). On the Postgres
// engine the same model runs over a networked, multi-writer table: the claim is
// `FOR UPDATE SKIP LOCKED`, so N workers across N processes each grab a different job
// with zero contention. The database methods are async — `await` them.
const pgEnsured = new WeakMap<object, Promise<void>>();

/** Postgres returns BIGINT/BIGSERIAL columns as strings — coerce the numerics. */
function deserializePg(row: any): Job {
  return {
    id: Number(row.id),
    queue: row.queue,
    jobId: row.job_id ?? undefined,
    status: row.status,
    priority: Number(row.priority),
    payload: JSON.parse(row.payload),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAt: Number(row.run_at),
    result: row.result != null ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

class PgWorkerImpl implements Worker {
  private running = true;
  private inFlight = 0;
  private kicking = false;
  private task: HeartbeatTask | undefined;
  private drainResolve: (() => void) | undefined;
  private drainPromise: Promise<void> | undefined;
  private readonly concurrency: number;
  private readonly pollInterval: number;
  private readonly maxPollInterval: number;
  private idleInterval: number;
  private readonly visibilityTimeout: number;
  private reaper: ReturnType<typeof setInterval> | undefined;
  private readonly rateLimit?: { count: number; windowMs: number };
  private starts: number[] = [];

  constructor(
    private readonly q: PgQueue,
    readonly name: string,
    private readonly handler: Handler,
    opts: ProcessOptions,
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.pollInterval = opts.pollInterval ?? 500;
    this.rateLimit =
      opts.rateLimit && opts.rateLimit.count > 0 && opts.rateLimit.windowMs > 0
        ? opts.rateLimit
        : undefined;
    this.maxPollInterval = Math.max(
      this.pollInterval,
      opts.maxPollInterval ?? this.pollInterval,
    );
    this.idleInterval = this.pollInterval;
    this.visibilityTimeout = Math.max(0, opts.visibilityTimeout ?? 0);
    if (this.visibilityTimeout > 0) {
      this.reaper = setInterval(
        () => {
          if (this.running) void this.q.recover(this.visibilityTimeout, this.name);
        },
        Math.max(1000, Math.floor(this.visibilityTimeout / 2)),
      );
      this.reaper.unref?.();
    }
    void this.kick();
  }

  /** Fill spare capacity with claimable jobs; otherwise schedule a poll. Re-entrant-safe. */
  async kick(): Promise<void> {
    if (!this.running || this.kicking) return;
    this.kicking = true;
    let claimedAny = false;
    let rateWaitMs = 0;
    try {
      while (this.running && this.inFlight < this.concurrency) {
        if (this.rateLimit) {
          const t = Date.now();
          const cutoff = t - this.rateLimit.windowMs;
          if (this.starts.length)
            this.starts = this.starts.filter((s) => s > cutoff);
          if (this.starts.length >= this.rateLimit.count) {
            rateWaitMs = this.starts[0] + this.rateLimit.windowMs - t;
            break;
          }
        }
        const job = await this.q.claimInternal(this.name);
        if (!job) break;
        if (this.rateLimit) this.starts.push(Date.now());
        claimedAny = true;
        this.inFlight++;
        this.runJob(job);
      }
    } finally {
      this.kicking = false;
    }
    this.idleInterval = claimedAny
      ? this.pollInterval
      : Math.min(this.idleInterval * 2, this.maxPollInterval);
    const nextInterval =
      rateWaitMs > 0 ? Math.max(1, rateWaitMs) : this.idleInterval;
    if (this.running && (rateWaitMs > 0 || this.inFlight < this.concurrency)) {
      if (!this.task) {
        this.task = this.q.heartbeat.every(nextInterval, () => void this.kick());
      } else {
        this.task.setInterval(nextInterval);
      }
    }
  }

  private runJob(job: Job): void {
    let hb: ReturnType<typeof setInterval> | undefined;
    if (this.visibilityTimeout > 0) {
      hb = setInterval(
        () => void this.q.heartbeatInternal(job.id, job.attempts),
        Math.max(1000, Math.floor(this.visibilityTimeout / 2)),
      );
      hb.unref?.();
    }
    Promise.resolve()
      .then(() => this.handler(job))
      .then(
        async (result) => {
          if (await this.q.completeInternal(job, result))
            this.q.emit("completed", job, result);
        },
        async (err) => {
          if (await this.q.failInternal(job, err))
            this.q.emit("failed", job, err);
        },
      )
      .finally(() => {
        if (hb) clearInterval(hb);
        this.inFlight--;
        if (this.running) void this.kick();
        else this.checkDrained();
      });
  }

  private checkDrained(): void {
    if (!this.running && this.inFlight === 0 && this.drainResolve) {
      this.drainResolve();
      this.drainResolve = undefined;
      this.drainPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.task) {
      this.task.cancel();
      this.task = undefined;
    }
    if (this.reaper) clearInterval(this.reaper);
    if (this.inFlight === 0) return;
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });
    }
    return this.drainPromise;
  }
}

/**
 * A durable, multi-process job queue on the **Postgres** engine — the same model as
 * {@link Queue}, claiming the next due job with `FOR UPDATE SKIP LOCKED` (so workers across
 * processes never contend). Database methods are async — `await` them. Emits `"completed"`
 * (job, result) and `"failed"` (job, error).
 */
export class PgQueue extends EventEmitter {
  private readonly driver: NonNullable<Monlite["asyncDriver"]>;
  /** @internal Shared heartbeat — workers register their idle poll here. */
  readonly heartbeat: Monlite["heartbeat"];
  private readonly ready: Promise<void>;
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly removeOnComplete: boolean;
  readonly workerId: string;
  private readonly workers: PgWorkerImpl[] = [];

  constructor(db: Monlite, opts: QueueOptions = {}) {
    super();
    if (!db.asyncDriver)
      throw new Error(
        "@monlite/queue: PgQueue requires the Postgres engine — use `new Queue(db)` " +
          "/ `createQueue(db)` on the SQLite engine.",
      );
    this.driver = db.asyncDriver;
    this.heartbeat = db.heartbeat;
    this.maxAttempts = opts.maxAttempts ?? 1;
    this.backoff = opts.backoff ?? defaultBackoff;
    this.removeOnComplete = opts.removeOnComplete ?? false;
    this.workerId =
      opts.workerId ??
      `w-${typeof process !== "undefined" && process.pid ? process.pid : Math.floor(Math.random() * 1e6)}`;
    if (!pgEnsured.has(db)) {
      const drv = this.driver;
      pgEnsured.set(
        db,
        (async () => {
          await drv.exec(
            `CREATE TABLE IF NOT EXISTS _jobs (
              id BIGSERIAL PRIMARY KEY,
              queue TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL,
              run_at BIGINT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
              payload TEXT NOT NULL, result TEXT, error TEXT, locked_by TEXT, job_id TEXT,
              created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
          );
          await drv.exec(
            `CREATE INDEX IF NOT EXISTS _jobs_claim ON _jobs (queue, status, priority, run_at)`,
          );
          await drv.exec(
            `CREATE INDEX IF NOT EXISTS _jobs_jobid ON _jobs (job_id)`,
          );
        })(),
      );
    }
    this.ready = pgEnsured.get(db)!;
  }

  /** Enqueue a job. Pass `opts.jobId` to dedupe (see {@link Queue.add}). */
  async add<T = any>(
    name: string,
    payload: T,
    opts: AddOptions = {},
  ): Promise<Job<T>> {
    await this.ready;
    const t = now();
    if (opts.jobId) {
      const existing = (
        await this.driver.query(
          `SELECT * FROM _jobs WHERE job_id = ? AND queue = ? AND status IN ('pending','active') LIMIT 1`,
          [opts.jobId, name],
        )
      ).rows[0] as Row | undefined;
      if (existing) return deserializePg(existing) as Job<T>;
    }
    const runAt = opts.runAt ?? (opts.delay ? t + opts.delay : t);
    const row = (
      await this.driver.query(
        `INSERT INTO _jobs (queue, status, priority, run_at, attempts, max_attempts, payload, job_id, created_at, updated_at)
         VALUES (?, 'pending', ?, ?, 0, ?, ?, ?, ?, ?) RETURNING *`,
        [
          name,
          opts.priority ?? 0,
          runAt,
          opts.maxAttempts ?? this.maxAttempts,
          JSON.stringify(payload ?? null),
          opts.jobId ?? null,
          t,
          t,
        ],
      )
    ).rows[0] as Row;
    const job = deserializePg(row) as Job<T>;
    for (const w of this.workers) if (w.name === name) void w.kick();
    return job;
  }

  /** Register a worker for a queue. Returns a handle with `stop()`. */
  process<T = any, R = any>(
    name: string,
    handler: Handler<T, R>,
    opts: ProcessOptions = {},
  ): Worker {
    const w = new PgWorkerImpl(this, name, handler as Handler, opts);
    this.workers.push(w);
    return w;
  }

  async getJob<T = any>(id: number): Promise<Job<T> | undefined> {
    await this.ready;
    const row = (
      await this.driver.query(`SELECT * FROM _jobs WHERE id = ?`, [id])
    ).rows[0] as Row | undefined;
    return row ? (deserializePg(row) as Job<T>) : undefined;
  }

  /** Count jobs by status (optionally for one queue). */
  async counts(name?: string): Promise<Record<JobStatus, number>> {
    await this.ready;
    const rows = (
      await this.driver.query(
        name
          ? `SELECT status, COUNT(*) AS n FROM _jobs WHERE queue = ? GROUP BY status`
          : `SELECT status, COUNT(*) AS n FROM _jobs GROUP BY status`,
        name ? [name] : [],
      )
    ).rows as Array<{ status: JobStatus; n: any }>;
    const out: Record<JobStatus, number> = {
      pending: 0,
      active: 0,
      done: 0,
      failed: 0,
    };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  /** Reset jobs stuck in `active` past `olderThanMs` back to `pending`. Returns the count. */
  async recover(olderThanMs = 60_000, name?: string): Promise<number> {
    await this.ready;
    const filter = name ? " AND queue = ?" : "";
    const params: any[] = name
      ? [now(), now() - olderThanMs, name]
      : [now(), now() - olderThanMs];
    return (
      await this.driver.query(
        `UPDATE _jobs SET status='pending', locked_by=NULL, updated_at=? WHERE status='active' AND updated_at < ?${filter}`,
        params,
      )
    ).changes;
  }

  /** @internal Extend a running job's visibility timeout (worker heartbeat). */
  async heartbeatInternal(id: number, attempts: number): Promise<void> {
    await this.driver.query(
      `UPDATE _jobs SET updated_at=? WHERE id=? AND status='active' AND attempts=?`,
      [now(), id, attempts],
    );
  }

  /** Stop all workers and wait for in-flight jobs to finish. */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.stop()));
  }

  /** @internal Atomically claim the next due job (FOR UPDATE SKIP LOCKED), counting the attempt. */
  async claimInternal(name: string): Promise<Job | null> {
    await this.ready;
    const t = now();
    const row = (
      await this.driver.query(
        `UPDATE _jobs SET status='active', attempts=attempts+1, locked_by=?, updated_at=?
         WHERE id = (
           SELECT id FROM _jobs
           WHERE queue=? AND status='pending' AND run_at<=?
           ORDER BY priority DESC, id ASC
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING *`,
        [this.workerId, t, name, t],
      )
    ).rows[0] as Row | undefined;
    return row ? deserializePg(row) : null;
  }

  /** @internal Mark a job done; false if fenced out by a reclaim (see {@link Queue.completeInternal}). */
  async completeInternal(job: Job, result: unknown): Promise<boolean> {
    if (this.removeOnComplete) {
      return (
        (
          await this.driver.query(
            `DELETE FROM _jobs WHERE id=? AND attempts=?`,
            [job.id, job.attempts],
          )
        ).changes > 0
      );
    }
    return (
      (
        await this.driver.query(
          `UPDATE _jobs SET status='done', result=?, error=NULL, updated_at=? WHERE id=? AND attempts=?`,
          [safeStringify(result), now(), job.id, job.attempts],
        )
      ).changes > 0
    );
  }

  /** @internal Record a failure (retry or dead-letter); false if fenced out. */
  async failInternal(job: Job, err: unknown): Promise<boolean> {
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempts < job.maxAttempts) {
      return (
        (
          await this.driver.query(
            `UPDATE _jobs SET status='pending', run_at=?, error=?, locked_by=NULL, updated_at=? WHERE id=? AND attempts=?`,
            [now() + this.backoff(job.attempts), message, now(), job.id, job.attempts],
          )
        ).changes > 0
      );
    }
    return (
      (
        await this.driver.query(
          `UPDATE _jobs SET status='failed', error=?, updated_at=? WHERE id=? AND attempts=?`,
          [message, now(), job.id, job.attempts],
        )
      ).changes > 0
    );
  }
}

/** Create a job queue over a monlite database (SQLite engine — synchronous API). */
export function createQueue(db: Monlite, opts?: QueueOptions): Queue {
  return new Queue(db, opts);
}

/** Create a job queue over a monlite database on the Postgres engine (async API). */
export function createPgQueue(db: Monlite, opts?: QueueOptions): PgQueue {
  return new PgQueue(db, opts);
}
