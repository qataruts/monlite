import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Doc, MonliteOptions } from "./types.js";
import { Collection } from "./collection.js";
import { AutoIndexer } from "./auto-index.js";
import { MonliteError } from "./errors.js";
import { bindable } from "./query/sql.js";

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
  /** The underlying better-sqlite3 connection (escape hatch). */
  readonly sqlite: SqliteDatabase;
  /** @internal */
  readonly autoIndexer: AutoIndexer;

  private readonly collections = new Map<string, Collection<any>>();
  private closed = false;

  constructor(filename: string, options: MonliteOptions = {}) {
    const verbose = options.verbose;
    this.sqlite = new Database(filename, {
      readonly: options.readonly ?? false,
      ...(verbose ? { verbose: (msg?: unknown) => verbose(String(msg)) } : {}),
    });

    if (!options.readonly && (options.wal ?? true)) {
      this.sqlite.pragma("journal_mode = WAL");
    }

    this.autoIndexer = new AutoIndexer(
      this.sqlite,
      options.autoIndex ?? true,
      options.autoIndexAfter ?? 10,
    );
  }

  /** Get (or lazily create) a typed collection handle. */
  collection<T = Doc>(name: string): Collection<T> {
    this.assertOpen();
    validateName(name);
    let col = this.collections.get(name);
    if (!col) {
      col = new Collection<T>(this, name);
      this.collections.set(name, col);
    }
    return col as Collection<T>;
  }

  /** Tagged-template SQL query returning rows. Values are safely parameterized. */
  $queryRaw<R = any>(strings: TemplateStringsArray, ...values: any[]): Promise<R[]> {
    this.assertOpen();
    const { sql, params } = buildTagged(strings, values);
    return Promise.resolve(this.sqlite.prepare(sql).all(...params) as R[]);
  }

  /** Like {@link $queryRaw} but takes a raw SQL string and positional params. */
  $queryRawUnsafe<R = any>(sql: string, ...params: any[]): Promise<R[]> {
    this.assertOpen();
    return Promise.resolve(
      this.sqlite.prepare(sql).all(...params.map(bindable)) as R[],
    );
  }

  /** Tagged-template SQL statement returning the number of affected rows. */
  $executeRaw(strings: TemplateStringsArray, ...values: any[]): Promise<number> {
    this.assertOpen();
    const { sql, params } = buildTagged(strings, values);
    return Promise.resolve(this.sqlite.prepare(sql).run(...params).changes);
  }

  /** Like {@link $executeRaw} but takes a raw SQL string and positional params. */
  $executeRawUnsafe(sql: string, ...params: any[]): Promise<number> {
    this.assertOpen();
    return Promise.resolve(
      this.sqlite.prepare(sql).run(...params.map(bindable)).changes,
    );
  }

  /**
   * Run a function inside a synchronous SQLite transaction. If it throws, the
   * transaction is rolled back.
   */
  async $transaction<R>(fn: (db: this) => R): Promise<R> {
    this.assertOpen();
    // better-sqlite3 transactions are synchronous; `fn` must not be async.
    // A throw inside `txn()` rolls back and rejects this promise.
    const txn = this.sqlite.transaction(() => fn(this));
    return txn();
  }

  /** List all collection (table) names. */
  $collections(): Promise<string[]> {
    this.assertOpen();
    const rows = this.sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return Promise.resolve(rows.map((r) => r.name));
  }

  /** Drop a collection and all of its data. */
  $drop(name: string): Promise<void> {
    this.assertOpen();
    validateName(name);
    this.sqlite.exec(`DROP TABLE IF EXISTS "${name}"`);
    this.collections.delete(name);
    this.autoIndexer.reset(name);
    return Promise.resolve();
  }

  /** Drop every collection in the database. */
  async $dropAll(): Promise<void> {
    for (const name of await this.$collections()) await this.$drop(name);
  }

  /** Close the underlying SQLite connection. */
  $disconnect(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.sqlite.close();
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
