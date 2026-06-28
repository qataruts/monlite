import type {
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

    this.autoIndexer = new AutoIndexer(
      this.driver,
      options.autoIndex ?? true,
      options.autoIndexAfter ?? 10,
    );

    if (options.sync) {
      this.$sync = new SyncStore(this.driver, options.nodeId, this);
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
   * Avoid issuing unrelated writes from outside while one is in flight.
   */
  async transactionAsync<R>(fn: (db: this) => Promise<R> | R): Promise<R> {
    this.assertOpen();
    if (!this.driver.transactionAsync) {
      throw new MonliteError(
        "The active driver does not support transactionAsync. Use a built-in " +
          "driver (better-sqlite3 / node:sqlite) or update @monlite/wasm.",
      );
    }
    const run = this.txTail.then(() =>
      this.driver.transactionAsync!(async () => fn(this)),
    );
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
    const rows = this.driver
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '\\_monlite\\_%' ESCAPE '\\'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return Promise.resolve(rows.map((r) => r.name));
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
