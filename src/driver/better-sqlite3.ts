import type { Driver, DriverOpenOptions, PreparedStatement } from "./types.js";

const STMT_CACHE_MAX = 256;

/** Adapter over the `better-sqlite3` native driver. */
export class BetterSqlite3Driver implements Driver {
  readonly name = "better-sqlite3";
  readonly raw: any;
  private readonly verbose?: (sql: string) => void;
  private readonly cache = new Map<string, PreparedStatement>();

  constructor(
    BetterSqlite3: any,
    filename: string,
    options: DriverOpenOptions,
  ) {
    this.verbose = options.verbose;
    this.raw = new BetterSqlite3(filename, {
      readonly: options.readonly ?? false,
    });
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma(`busy_timeout = ${options.busyTimeout ?? 5000}`);
    if (!options.readonly && (options.wal ?? true)) {
      this.raw.pragma("journal_mode = WAL");
    }
  }

  exec(sql: string): void {
    this.verbose?.(sql);
    this.raw.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    this.verbose?.(sql);
    const cached = this.cache.get(sql);
    if (cached) return cached;
    const stmt = this.raw.prepare(sql) as PreparedStatement; // reusable
    this.cacheStmt(sql, stmt);
    return stmt;
  }

  private cacheStmt(sql: string, stmt: PreparedStatement): void {
    if (this.cache.size >= STMT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(sql, stmt);
  }

  transaction<T>(fn: () => T): T {
    // Nested calls automatically use SAVEPOINTs in better-sqlite3.
    return this.raw.transaction(fn)();
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
