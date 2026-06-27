import type {
  CollectionOptions,
  ColumnInfo,
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
  private closed = false;

  constructor(filename: string, options: MonliteOptions = {}) {
    this.driver = createDriver(filename, {
      driver: options.driver,
      readonly: options.readonly,
      wal: options.wal,
      busyTimeout: options.busyTimeout,
      verbose: options.verbose,
    });

    this.autoIndexer = new AutoIndexer(
      this.driver,
      options.autoIndex ?? true,
      options.autoIndexAfter ?? 10,
    );

    if (options.sync) {
      this.$sync = new SyncStore(this.driver, options.nodeId, this);
    }
  }

  /** Stable node id for LWW tie-breaking (only when sync is enabled). */
  get nodeId(): string | undefined {
    return this.$sync?.nodeId;
  }

  /** The underlying native database handle (escape hatch). */
  get sqlite(): any {
    return this.driver.raw;
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
