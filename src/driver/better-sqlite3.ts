import type { Driver, DriverOpenOptions, PreparedStatement } from "./types.js";

/** Adapter over the `better-sqlite3` native driver. */
export class BetterSqlite3Driver implements Driver {
  readonly name = "better-sqlite3";
  readonly raw: any;
  private readonly verbose?: (sql: string) => void;

  constructor(BetterSqlite3: any, filename: string, options: DriverOpenOptions) {
    this.verbose = options.verbose;
    this.raw = new BetterSqlite3(filename, {
      readonly: options.readonly ?? false,
    });
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
    // better-sqlite3 statements already match the PreparedStatement shape.
    return this.raw.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    // Nested calls automatically use SAVEPOINTs in better-sqlite3.
    return this.raw.transaction(fn)();
  }

  close(): void {
    this.raw.close();
  }
}
