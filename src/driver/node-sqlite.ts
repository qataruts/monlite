import type { Driver, DriverOpenOptions, PreparedStatement } from "./types.js";

/**
 * Adapter over Node's built-in `node:sqlite` (Node >= 22.5). Lets monlite run
 * with zero external dependencies. Note: `node:sqlite` is still flagged
 * experimental by Node and prints a one-time ExperimentalWarning.
 *
 * Unlike better-sqlite3 it has no `.transaction()` / `.pragma()` helpers, so
 * transactions are implemented here with BEGIN/COMMIT and nested SAVEPOINTs.
 */
export class NodeSqliteDriver implements Driver {
  readonly name = "node:sqlite";
  readonly raw: any;
  private readonly verbose?: (sql: string) => void;
  private depth = 0;

  constructor(nodeSqlite: any, filename: string, options: DriverOpenOptions) {
    this.verbose = options.verbose;
    const { DatabaseSync } = nodeSqlite;
    this.raw = new DatabaseSync(filename, {
      readOnly: options.readonly ?? false,
    });
    if (!options.readonly && (options.wal ?? true)) {
      this.raw.exec("PRAGMA journal_mode = WAL");
    }
  }

  exec(sql: string): void {
    this.verbose?.(sql);
    this.raw.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    this.verbose?.(sql);
    const stmt = this.raw.prepare(sql);
    return {
      run: (...p: any[]) => stmt.run(...p),
      get: (...p: any[]) => stmt.get(...p),
      all: (...p: any[]) => stmt.all(...p),
    };
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `monlite_sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec("BEGIN");
    else this.raw.exec(`SAVEPOINT ${savepoint}`);
    this.depth++;

    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.raw.exec("ROLLBACK");
      else this.raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}
