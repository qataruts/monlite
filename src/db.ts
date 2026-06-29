import type {
  ChangeEvent,
  ChangesOptions,
  CollectionOptions,
  ColumnInfo,
  DbStats,
  Doc,
  MonliteOptions,
} from "./types.js";
import { Collection } from "./collection.js";
import { AutoIndexer } from "./auto-index.js";
import { MonliteError, normalizeDriverError } from "./errors.js";
import { bindable } from "./query/sql.js";
import { createDriver } from "./driver/index.js";
import type { Driver } from "./driver/types.js";
import { SyncStore } from "./sync/store.js";
import { Reactor } from "./reactive.js";
import { Heartbeat, type HeartbeatTask } from "./heartbeat.js";
import type { MonlitePlugin } from "./plugin.js";

function validateName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new MonliteError(
      `Invalid collection name "${name}". Names must start with a letter or ` +
        `underscore and contain only letters, digits and underscores.`,
    );
  }
}

function buildTagged(
  strings: TemplateStringsArray,
  values: any[],
): { sql: string; params: any[] } {
  let sql = "";
  const params: any[] = [];
  strings.forEach((part, i) => {
    sql += part;
    if (i < values.length) {
      sql += "?";
      params.push(bindable(values[i]));
    }
  });
  return { sql, params };
}

/** Sleep that resolves early if the signal aborts (for the polling change stream). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      // Remove the listener on the normal (timed-out) path too — `{ once: true }`
      // only fires on abort, so without this each poll iteration would leak one.
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A monlite database — a thin document layer over a single SQLite file.
 * Create one with {@link createDb}.
 */
export class Monlite {
  /** @internal The active SQLite driver. */
  readonly driver: Driver;
  /** @internal */
  readonly autoIndexer: AutoIndexer;
  /** @internal Reactivity hub for `collection.watch()`. */
  readonly reactor = new Reactor();
  /** @internal Sync metadata store; present only when `{ sync: true }`. */
  readonly $sync?: SyncStore;

  private readonly collections = new Map<string, Collection<any>>();
  private readonly plugins: MonlitePlugin[];
  private readonly encrypted: boolean;
  private closed = false;
  /** @internal Resource limits (0/undefined = off). */
  readonly maxDocumentBytes?: number;
  readonly maxRows?: number;
  /** Serializes async transactions so their await points never interleave. */
  private txTail: Promise<unknown> = Promise.resolve();
  /** Depth of in-flight async transactions, and an async-context store to tell a
   *  transaction's OWN writes apart from foreign ones during its await window. */
  private asyncTxDepth = 0;
  private als: any;
  private alsLoaded = false;
  /** @internal Shared coalescing scheduler — every subsystem's periodic poll
   *  (reactor, kv pub/sub, queue idle poll, cron) registers here so the database
   *  runs ONE timer instead of many. */
  readonly heartbeat = new Heartbeat();
  /** Cross-process reactivity: feed `seq` already delivered to the reactor. */
  private reactorCursor = 0;
  private reactorTask?: HeartbeatTask;
  private readonly reactorPollMs: number;

  private getAls(): any {
    if (!this.alsLoaded) {
      this.alsLoaded = true;
      try {
        const proc: any = typeof process !== "undefined" ? process : undefined;
        const mod = proc?.getBuiltinModule?.("async_hooks");
        this.als = mod ? new mod.AsyncLocalStorage() : null;
      } catch {
        this.als = null;
      }
    }
    return this.als;
  }

  /**
   * @internal Throw if a plain write is issued from OUTSIDE an in-flight
   * `transactionAsync` callback — on a single connection it would silently fold
   * into that transaction (committing/rolling back with it). Writes from within
   * the transaction's own callback are allowed.
   */
  assertWriteAllowed(): void {
    if (this.asyncTxDepth === 0) return;
    const als = this.getAls();
    if (als && als.getStore() !== undefined) return; // inside the active tx
    throw new MonliteError(
      "A write was issued from outside an in-flight transactionAsync. Await the " +
        "transaction before writing, or perform the write inside its callback — " +
        "plain writes can't be safely interleaved with an async transaction on one connection.",
    );
  }

  constructor(filename: string, options: MonliteOptions = {}) {
    this.driver = createDriver(filename, {
      driver: options.driver,
      readonly: options.readonly,
      wal: options.wal,
      busyTimeout: options.busyTimeout,
      synchronous: options.synchronous,
      allowExtensions: options.allowExtensions,
      encryption: options.encryption,
      verbose: options.verbose,
      onQuery: options.onQuery,
    });
    this.encrypted = options.encryption !== undefined;
    this.maxDocumentBytes = options.maxDocumentBytes;
    this.maxRows = options.maxRows;
    this.reactorPollMs = Math.max(20, options.reactorPollMs ?? 200);

    this.autoIndexer = new AutoIndexer(
      this.driver,
      options.autoIndex ?? true,
      options.autoIndexAfter ?? 10,
    );

    // The change feed underpins sync AND realtime/cross-process reactivity, so
    // initialise it for either. `sync` implies `changefeed`.
    if (options.sync || options.changefeed) {
      this.$sync = new SyncStore(
        this.driver,
        options.nodeId,
        this,
        !!options.sync,
      );
    }

    this.plugins = options.plugins ?? [];
    for (const plugin of this.plugins) plugin.init?.(this);
  }

  /** @internal Notify plugins that documents changed (post-commit). */
  firePluginAfterWrite(collection: string, ids: string[]): void {
    if (this.plugins.length === 0 || ids.length === 0) return;
    const fire = () => {
      for (const plugin of this.plugins) {
        plugin.afterWrite?.(this, { collection, ids });
      }
    };
    // Batch all plugin index writes (fts/vector) into a single transaction, so a
    // bulk write does ONE commit/fsync instead of one per indexed row (N+1). When
    // already inside a transaction this nests as a SAVEPOINT.
    if (ids.length > 1) this.driver.transaction(fire);
    else fire();
  }

  /** Stable node id for LWW tie-breaking (only when sync is enabled). */
  get nodeId(): string | undefined {
    return this.$sync?.nodeId;
  }

  /** The underlying native database handle (escape hatch). */
  get sqlite(): any {
    // Prefer a driver-provided, better-sqlite3-compatible facade (the wasm
    // driver supplies one so plugins work in the browser); else the raw handle.
    return this.driver.sqlite ?? this.driver.raw;
  }

  /** Name of the active backend: `"better-sqlite3"` or `"node:sqlite"`. */
  get driverName(): string {
    return this.driver.name;
  }

  /**
   * Get (or lazily create) a typed collection handle. Pass `{ schema }` to make
   * it a structured collection backed by native SQL columns; omit for the
   * default schema-free document mode. Options apply only on first access.
   */
  collection<T = Doc>(
    name: string,
    options?: CollectionOptions,
  ): Collection<T> {
    this.assertOpen();
    validateName(name);
    let col = this.collections.get(name);
    if (!col) {
      col = new Collection<T>(this, name, options);
      this.collections.set(name, col);
      // Attach plugin-provided methods (e.g. `search`) to the handle.
      for (const plugin of this.plugins) {
        for (const [method, impl] of Object.entries(
          plugin.collectionMethods ?? {},
        )) {
          (col as any)[method] = (...args: any[]) => impl(col!, ...args);
        }
      }
    } else if (options?.schema) {
      // A collection's mode/columns are fixed on first access; surface conflicts
      // instead of silently ignoring a re-declaration.
      const requested = Object.keys(options.schema);
      const existing = new Set(col.columnNames);
      const sameShape =
        col.mode === "structured" &&
        requested.length === existing.size &&
        requested.every((c) => existing.has(c));
      if (!sameShape) {
        throw new MonliteError(
          `Collection "${name}" was already opened with a different schema/mode. ` +
            `A collection's storage mode is fixed on first access.`,
        );
      }
    }
    return col as Collection<T>;
  }

  /** Inspect a collection's physical columns (PRAGMA table_info). */
  $schema(name: string): Promise<ColumnInfo[]> {
    this.assertOpen();
    validateName(name);
    const rows = this.driver
      .prepare(`PRAGMA table_info("${name}")`)
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    return Promise.resolve(
      rows.map((r) => ({
        name: r.name,
        type: r.type,
        notNull: !!r.notnull,
        primaryKey: !!r.pk,
      })),
    );
  }

  /** Tagged-template SQL query returning rows. Values are safely parameterized. */
  $queryRaw<R = any>(
    strings: TemplateStringsArray,
    ...values: any[]
  ): Promise<R[]> {
    this.assertOpen();
    const { sql, params } = buildTagged(strings, values);
    return Promise.resolve(this.driver.prepare(sql).all(...params) as R[]);
  }

  /** Like {@link $queryRaw} but takes a raw SQL string and positional params. */
  $queryRawUnsafe<R = any>(sql: string, ...params: any[]): Promise<R[]> {
    this.assertOpen();
    return Promise.resolve(
      this.driver.prepare(sql).all(...params.map(bindable)) as R[],
    );
  }

  /** Tagged-template SQL statement returning the number of affected rows. */
  $executeRaw(
    strings: TemplateStringsArray,
    ...values: any[]
  ): Promise<number> {
    this.assertOpen();
    const { sql, params } = buildTagged(strings, values);
    try {
      return Promise.resolve(this.driver.prepare(sql).run(...params).changes);
    } catch (err) {
      throw normalizeDriverError(err);
    }
  }

  /** Like {@link $executeRaw} but takes a raw SQL string and positional params. */
  $executeRawUnsafe(sql: string, ...params: any[]): Promise<number> {
    this.assertOpen();
    return Promise.resolve(
      this.driver.prepare(sql).run(...params.map(bindable)).changes,
    );
  }

  /**
   * Run a function inside a synchronous SQLite transaction. If it throws, the
   * transaction is rolled back.
   */
  async $transaction<R>(fn: (db: this) => R): Promise<R> {
    this.assertOpen();
    // Transactions are synchronous; `fn` must not be async. A throw inside
    // rolls back and (being in an async method) rejects this promise.
    return this.driver.transaction(() => fn(this));
  }

  /**
   * Run an **async** unit of work atomically. Unlike {@link $transaction}, `fn`
   * may `await` (read → compute → write); everything runs inside one
   * `BEGIN IMMEDIATE … COMMIT`, and a throw rolls the whole thing back.
   *
   * Calls are **serialized** so two concurrent async transactions can't
   * interleave on the shared connection — the right primitive for things like a
   * double-entry posting (`read balances → compute → write debit + credit`).
   * Unrelated writes issued from OUTSIDE the callback while one is in flight are
   * rejected (they'd otherwise silently fold into this transaction on the shared
   * connection) — await it first, or do the write inside the callback.
   */
  async transactionAsync<R>(fn: (db: this) => Promise<R> | R): Promise<R> {
    this.assertOpen();
    if (!this.driver.transactionAsync) {
      throw new MonliteError(
        "The active driver does not support transactionAsync. Use a built-in " +
          "driver (better-sqlite3 / node:sqlite) or update @monlite/wasm.",
      );
    }
    const als = this.getAls();
    // Re-entrant: a transactionAsync called INSIDE another's callback must NOT
    // re-queue on txTail (it would deadlock waiting for the outer to release).
    // Run it directly — it already inherits the outer's async-context scope, and
    // the driver nests it as a SAVEPOINT.
    if (als && als.getStore() != null) {
      this.asyncTxDepth++;
      return Promise.resolve(
        this.driver.transactionAsync!(async () => fn(this)),
      ).finally(() => {
        this.asyncTxDepth--;
      }) as Promise<R>;
    }
    const token = {};
    const run = this.txTail.then(() => {
      this.asyncTxDepth++;
      const exec = () => this.driver.transactionAsync!(async () => fn(this));
      // Run inside an async-context scope so the transaction's own writes are
      // recognised (and foreign writes during its awaits are rejected).
      return Promise.resolve(als ? als.run(token, exec) : exec()).finally(
        () => {
          this.asyncTxDepth--;
        },
      );
    });
    // Keep the queue alive even if this run rejects.
    this.txTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<R>;
  }

  /** List all collection (table) names. */
  $collections(): Promise<string[]> {
    this.assertOpen();
    // Only real monlite collections — every one has an `_id` column. This excludes
    // plugin/auxiliary tables (queue `_jobs`, fts `*_fts*`, vector `*_vec*`, dynamic
    // index tables) that would otherwise leak into e.g. `sync({ collections: "*" })`
    // and be treated as user data.
    const rows = this.driver
      .prepare(
        `SELECT m.name AS name FROM sqlite_master m
         WHERE m.type='table'
           AND m.name NOT LIKE 'sqlite_%'
           AND m.name NOT LIKE '\\_monlite\\_%' ESCAPE '\\'
           AND EXISTS (
             SELECT 1 FROM pragma_table_info(m.name) ti WHERE ti.name = '_id'
           )
         ORDER BY m.name`,
      )
      .all() as Array<{ name: string }>;
    return Promise.resolve(rows.map((r) => r.name));
  }

  /* ----------------------------- change feed ----------------------------- */

  private assertChangefeed(): void {
    if (!this.$sync) {
      throw new MonliteError(
        "The change feed is off. Open the database with { changefeed: true } " +
          "(or { sync: true }) to use changes()/changesSince()/currentSeq().",
      );
    }
  }

  /**
   * Stream the ordered, durable change feed — including writes from OTHER
   * processes sharing this `.db` and changes applied by sync. Requires
   * `{ changefeed: true }` (or `{ sync: true }`). Resume exactly after a prior
   * point by passing that event's `seq` as `since`; stop via an `AbortSignal`
   * or by breaking the loop.
   *
   * ```ts
   * for await (const ev of db.changes("orders", { since: lastSeq, signal })) {
   *   // ev = { seq, collection, id, op: "upsert"|"delete", ts }
   * }
   * ```
   */
  async *changes(
    collection?: string,
    opts: ChangesOptions = {},
  ): AsyncIterableIterator<ChangeEvent> {
    this.assertChangefeed();
    const pollMs = opts.pollMs ?? 200;
    const signal = opts.signal;
    let cursor = opts.since ?? 0;
    while (!signal?.aborted) {
      const batch = this.$sync!.feedSince(collection, cursor, 1000);
      for (const ev of batch) {
        if (signal?.aborted) return;
        cursor = ev.seq;
        yield ev;
      }
      // Drained a full batch? loop immediately to catch up; else wait for more.
      if (batch.length === 1000) continue;
      if (signal?.aborted) return;
      await abortableSleep(pollMs, signal);
    }
  }

  /** Pull (non-streaming) changes with `seq > since`, optionally for one collection. */
  changesSince(
    collection: string | undefined,
    since: number,
    limit = 1000,
  ): ChangeEvent[] {
    this.assertOpen();
    this.assertChangefeed();
    return this.$sync!.feedSince(collection, since, limit);
  }

  /** Highest change-feed `seq` so far (0 if empty) — a cursor for "only new" streams. */
  currentSeq(): number {
    this.assertOpen();
    this.assertChangefeed();
    return this.$sync!.currentSeq();
  }

  /**
   * Bound change-feed growth: drop old entries, keeping at least `keepLast` and
   * never an unpushed local change (sync still needs those). Returns rows removed.
   */
  compactChanges(opts: { keepLast?: number } = {}): number {
    this.assertOpen();
    this.assertChangefeed();
    return this.$sync!.compact(opts);
  }

  /* ----------------------- cross-process reactivity ----------------------- */

  /**
   * @internal Notify watchers after a local write. With the change feed on, the
   * feed is the single source (so writes from OTHER processes are picked up too);
   * otherwise emit the ids directly (in-process only — the unchanged default).
   */
  notifyReactor(collection: string, ids: string[]): void {
    // Deliver AFTER the write commits, so watchers never see uncommitted or
    // rolled-back data and (changefeed on) the reactor cursor only advances over
    // committed seqs. afterWrite runs inside the write transaction.
    const deliver = () => {
      if (this.closed) return;
      if (this.$sync) this.drainReactor();
      else this.reactor.emit(collection, ids);
    };
    if (this.driver.afterCommit) this.driver.afterCommit(deliver);
    else deliver();
  }

  /**
   * @internal Begin polling the change feed (idempotent) so `watch()` sees
   * writes from other processes. No-op unless the change feed is enabled.
   */
  ensureReactorPolling(): void {
    if (!this.$sync || this.reactorTask) return;
    // Re-pin the cursor to "now" each time polling (re)starts — i.e. whenever the
    // watcher set goes empty -> non-empty — so writes made during a no-watcher
    // window aren't replayed to a later watcher whose init snapshot already
    // includes them. (The task is cancelled on the last unwatch below.)
    this.reactorCursor = this.$sync.currentSeq();
    this.reactorTask = this.heartbeat.every(this.reactorPollMs, () =>
      this.drainReactor(),
    );
  }

  /** @internal Stop the change-feed poll when the last watcher unregisters. */
  maybeStopReactorPolling(): void {
    if (this.reactorTask && !this.reactor.hasAnyWatchers()) {
      this.reactorTask.cancel();
      this.reactorTask = undefined;
    }
  }

  /** Deliver every feed change since the cursor to the reactor (local + remote). */
  private drainReactor(): void {
    if (!this.$sync || !this.reactor.hasAnyWatchers()) return;
    const batch = this.$sync.feedSince(undefined, this.reactorCursor, 5000);
    if (batch.length === 0) return;
    const byColl = new Map<string, string[]>();
    for (const ev of batch) {
      if (ev.seq > this.reactorCursor) this.reactorCursor = ev.seq;
      let arr = byColl.get(ev.collection);
      if (!arr) byColl.set(ev.collection, (arr = []));
      arr.push(ev.id);
    }
    for (const [coll, idList] of byColl) this.reactor.emit(coll, idList);
  }

  /** Drop a collection and all of its data. */
  $drop(name: string): Promise<void> {
    this.assertOpen();
    validateName(name);
    this.driver.exec(`DROP TABLE IF EXISTS "${name}"`);
    this.collections.delete(name);
    this.autoIndexer.reset(name);
    return Promise.resolve();
  }

  /** Drop every collection in the database. */
  async $dropAll(): Promise<void> {
    for (const name of await this.$collections()) await this.$drop(name);
  }

  /**
   * Write a consistent on-disk snapshot of the database to `path` (via
   * `VACUUM INTO`). The destination file must not already exist.
   */
  backup(path: string): Promise<void> {
    this.assertOpen();
    this.driver.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    return Promise.resolve();
  }

  /**
   * Verify on-disk integrity via SQLite's `integrity_check` (or the faster
   * `quick_check`). Returns `true` when healthy, or the list of problems found.
   */
  checkIntegrity(quick = false): true | string[] {
    this.assertOpen();
    const pragma = quick ? "quick_check" : "integrity_check";
    const rows = this.driver.prepare(`PRAGMA ${pragma}`).all() as Array<{
      [k: string]: string;
    }>;
    const messages = rows.map((r) => Object.values(r)[0]);
    return messages.length === 1 && messages[0] === "ok" ? true : messages;
  }

  /** Rebuild the database file to reclaim space and defragment (`VACUUM`). */
  vacuum(): void {
    this.assertOpen();
    this.driver.exec("VACUUM");
  }

  /** Refresh the query planner's statistics (`ANALYZE`). */
  analyze(): void {
    this.assertOpen();
    this.driver.exec("ANALYZE");
  }

  /** Database size and object counts (for monitoring/diagnostics). */
  stats(): DbStats {
    this.assertOpen();
    const scalar = (sql: string, key: string): number =>
      ((this.driver.prepare(sql).get() as Record<string, any>)?.[
        key
      ] as number) ?? 0;
    const pageSize = scalar("PRAGMA page_size", "page_size");
    const pageCount = scalar("PRAGMA page_count", "page_count");
    const tables = this.driver
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>;
    let collections = 0;
    for (const { name } of tables) {
      const cols = (
        this.driver.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      if (cols.includes("_id") && cols.includes("data")) collections++;
    }
    const indexes = scalar(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index'`,
      "n",
    );
    return {
      sizeBytes: pageSize * pageCount,
      pageSize,
      pageCount,
      collections,
      indexes,
    };
  }

  /**
   * Checkpoint the WAL into the main database file. `mode` is one of
   * `PASSIVE` (default), `FULL`, `RESTART`, or `TRUNCATE`.
   */
  checkpoint(
    mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE",
  ): void {
    this.assertOpen();
    this.driver.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  /**
   * Rotate the encryption key. Only valid for a database opened with the
   * `encryption` option; throws otherwise. Pass `cipher` to also change scheme.
   */
  rekey(key: string, cipher?: string): void {
    this.assertOpen();
    if (!this.encrypted || !this.driver.rekey) {
      throw new MonliteError(
        "rekey() requires a database opened with the `encryption` option.",
      );
    }
    this.driver.rekey(key, cipher);
  }

  /** Close the underlying SQLite connection. */
  $disconnect(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.heartbeat.stop();
      this.driver.close();
    }
    return Promise.resolve();
  }

  private assertOpen(): void {
    if (this.closed) throw new MonliteError("Database connection is closed");
  }
}

/**
 * Open (or create) a monlite database backed by a single SQLite file.
 * Use `":memory:"` for an in-memory database.
 */
export function createDb(filename: string, options?: MonliteOptions): Monlite {
  return new Monlite(filename, options);
}
