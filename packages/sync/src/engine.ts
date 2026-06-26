import { EventEmitter } from "node:events";
import type { Monlite, ConflictResolver } from "@monlite/core";
import type {
  SyncAdapter,
  SyncMode,
  SyncOptions,
  SyncRoundStats,
  SyncStatus,
  Unsubscribe,
} from "./types.js";

/**
 * Orchestrates replication between a local sync-enabled monlite database and a
 * remote, via a {@link SyncAdapter}. Emits `start`, `sync`, `change`,
 * `conflict`, `error`, and `stop` events.
 */
export class SyncEngine extends EventEmitter {
  private readonly adapter: SyncAdapter;
  private readonly mode: SyncMode;
  private readonly remote: string;
  private readonly resolver?: ConflictResolver;
  private readonly explicitCollections?: string[];
  private readonly interval?: number;
  private readonly live: boolean;

  private timer?: ReturnType<typeof setInterval>;
  private unwatch?: Unsubscribe;
  private started = false;
  private inFlight: Promise<SyncRoundStats> | null = null;

  constructor(
    private readonly db: Monlite,
    opts: SyncOptions,
  ) {
    super();
    if (!db.$sync) {
      throw new Error(
        "SyncEngine requires a database opened with { sync: true }",
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

    if (this.interval && this.interval > 0) {
      this.timer = setInterval(() => {
        this.sync().catch((err) => this.emit("error", err));
      }, this.interval);
      this.timer.unref?.();
    }

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

  private async pullOnce() {
    const state = this.store.getState(this.remote);
    const res = await this.adapter.pull(state.cursor, {
      collections: this.explicitCollections,
    });

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
    const pending = this.store.pending(this.explicitCollections);
    if (!pending.length) return { pushed: 0, rejected: 0 };

    const res = await this.adapter.push(pending);
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
      clearInterval(this.timer);
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
    };
  }
}

/** Create (and optionally auto-start) a {@link SyncEngine}. */
export function sync(db: Monlite, opts: SyncOptions): SyncEngine {
  const engine = new SyncEngine(db, opts);
  if (opts.autoStart) void engine.start();
  return engine;
}
