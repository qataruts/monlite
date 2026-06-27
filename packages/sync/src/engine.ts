import { EventEmitter } from "node:events";
import {
  MonliteError,
  type Monlite,
  type ConflictResolver,
} from "@monlite/core";
import type {
  SyncAdapter,
  SyncMode,
  SyncOptions,
  SyncRoundStats,
  SyncStatus,
  Unsubscribe,
} from "./types.js";

const DEFAULT_BATCH_SIZE = 500;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_RETRIES = 4;
const DEFAULT_RETRY_BASE_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Orchestrates replication between a local sync-enabled monlite database and a
 * remote, via a {@link SyncAdapter}. Emits `start`, `sync`, `change`,
 * `conflict`, `retry`, `error`, and `stop` events.
 */
export class SyncEngine extends EventEmitter {
  private readonly adapter: SyncAdapter;
  private readonly mode: SyncMode;
  private readonly remote: string;
  private readonly resolver?: ConflictResolver;
  private readonly explicitCollections?: string[];
  private readonly interval?: number;
  private readonly live: boolean;
  private readonly batchSize: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;

  private timer?: ReturnType<typeof setTimeout>;
  private unwatch?: Unsubscribe;
  private started = false;
  private inFlight: Promise<SyncRoundStats> | null = null;
  private failures = 0;

  constructor(
    private readonly db: Monlite,
    opts: SyncOptions,
  ) {
    super();
    if (!db.$sync) {
      throw new MonliteError(
        "SyncEngine requires a database opened with { sync: true }",
      );
    }
    if (typeof opts.conflict === "string" && opts.conflict !== "lww") {
      throw new MonliteError(
        `Unknown conflict strategy "${opts.conflict}". Use "lww" or a function.`,
      );
    }
    this.adapter = opts.adapter;
    this.mode = opts.mode ?? "two-way";
    this.remote = opts.remote ?? opts.adapter.name;
    this.resolver =
      typeof opts.conflict === "function" ? opts.conflict : undefined;
    this.explicitCollections =
      opts.collections && opts.collections !== "*"
        ? opts.collections
        : undefined;
    this.interval = opts.interval;
    this.live = opts.live ?? false;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    // An 'error' emit with no listener crashes the host process; guarantee one.
    this.on("error", () => {});
  }

  private get store() {
    return this.db.$sync!;
  }

  private async collections(): Promise<string[]> {
    return this.explicitCollections ?? (await this.db.$collections());
  }

  /** Bootstrap, run an initial round, and start scheduling/live streaming. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const state = this.store.getState(this.remote);
    if (
      (this.mode === "push" || this.mode === "two-way") &&
      state.lastPushAt == null
    ) {
      // First push run: enqueue any docs that pre-date sync being enabled.
      this.store.seed(await this.collections());
    }

    await this.sync();

    if (this.interval && this.interval > 0) this.scheduleNext();

    if (this.live && this.adapter.watch) {
      this.unwatch = this.adapter.watch(
        this.store.getState(this.remote).cursor,
        (change) => {
          try {
            const r = this.store.applyRemote(change, this.resolver);
            if (r.applied) this.emit("change", change);
            if (r.conflict) this.emit("conflict", change);
          } catch (err) {
            this.emit("error", err);
          }
        },
        { collections: this.explicitCollections },
      );
    }

    this.emit("start");
  }

  /** Self-scheduling poll loop with exponential backoff + jitter on failure. */
  private scheduleNext(): void {
    const base = this.interval!;
    const backoff =
      this.failures > 0
        ? Math.min(base * 2 ** this.failures, MAX_BACKOFF_MS)
        : base;
    const delay = backoff + Math.floor(Math.random() * backoff * 0.2);
    this.timer = setTimeout(() => {
      this.sync()
        .then(() => {
          this.failures = 0;
        })
        .catch((err) => {
          this.failures++;
          this.emit("error", err);
        })
        .finally(() => {
          if (this.started && this.interval) this.scheduleNext();
        });
    }, delay);
    this.timer.unref?.();
  }

  /** Run a single sync round. Concurrent calls share the in-flight round. */
  sync(): Promise<SyncRoundStats> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRound().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRound(): Promise<SyncRoundStats> {
    const stats: SyncRoundStats = {
      pulled: 0,
      applied: 0,
      conflicts: 0,
      pushed: 0,
      rejected: 0,
    };

    if (this.mode === "pull" || this.mode === "two-way") {
      const r = await this.pullOnce();
      stats.pulled = r.pulled;
      stats.applied = r.applied;
      stats.conflicts = r.conflicts;
    }
    if (this.mode === "push" || this.mode === "two-way") {
      const r = await this.pushOnce();
      stats.pushed = r.pushed;
      stats.rejected = r.rejected;
    }

    this.emit("sync", stats);
    return stats;
  }

  /**
   * Run an adapter operation with exponential-backoff retries. Both `pull`
   * (read-only) and `push` (idempotent via LWW) are safe to repeat, so a
   * transient remote/network blip retries here instead of failing the whole
   * round and waiting a full poll interval. Rethrows once retries are exhausted.
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= this.retries) throw err;
        const backoff = Math.min(
          this.retryBaseMs * 2 ** attempt,
          MAX_BACKOFF_MS,
        );
        const delay = backoff + Math.floor(Math.random() * this.retryBaseMs);
        this.emit("retry", {
          label,
          attempt: attempt + 1,
          delayMs: delay,
          error: err,
        });
        await sleep(delay);
      }
    }
  }

  private async pullOnce() {
    const state = this.store.getState(this.remote);
    // Pass the concrete collection list (adapters like Mongo can't enumerate
    // "all" themselves), so `collections: "*"` works for every adapter.
    const collections = await this.collections();
    const res = await this.withRetry("pull", () =>
      this.adapter.pull(state.cursor, {
        collections,
        limit: this.batchSize,
      }),
    );

    let applied = 0;
    let conflicts = 0;
    for (const change of res.changes) {
      const r = this.store.applyRemote(change, this.resolver);
      if (r.applied) {
        applied++;
        this.emit("change", change);
      }
      if (r.conflict) {
        conflicts++;
        this.emit("conflict", change);
      }
    }

    this.store.setState(this.remote, {
      cursor: res.cursor,
      lastPullAt: Date.now(),
    });
    return { pulled: res.changes.length, applied, conflicts };
  }

  private async pushOnce() {
    const pending = this.store.pending(
      this.explicitCollections,
      this.batchSize,
    );
    if (!pending.length) return { pushed: 0, rejected: 0 };

    const res = await this.withRetry("push", () => this.adapter.push(pending));
    if (res.acked.length) {
      this.store.markPushed(res.acked);
      const maxSeq = Math.max(...res.acked.map((c) => c.seq));
      this.store.setState(this.remote, {
        lastPushSeq: maxSeq,
        lastPushAt: Date.now(),
      });
    }
    return { pushed: res.acked.length, rejected: res.rejected?.length ?? 0 };
  }

  /** Stop scheduling and live streaming. Safe to call multiple times. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = undefined;
    }
    this.emit("stop");
  }

  status(): SyncStatus {
    const state = this.store.getState(this.remote);
    return {
      running: this.started,
      remote: this.remote,
      mode: this.mode,
      pendingPush: this.store.pending(this.explicitCollections).length,
      conflicts: this.store.conflicts().length,
      cursor: state.cursor,
      lastPullAt: state.lastPullAt,
      lastPushAt: state.lastPushAt,
      failures: this.failures,
    };
  }
}

/** Create (and optionally auto-start) a {@link SyncEngine}. */
export function sync(db: Monlite, opts: SyncOptions): SyncEngine {
  const engine = new SyncEngine(db, opts);
  if (opts.autoStart) void engine.start();
  return engine;
}
