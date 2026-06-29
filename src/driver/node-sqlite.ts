import { MonliteError } from "../errors.js";
import { REGEXP_FN, monliteRegexp } from "./regexp.js";
import type { Driver, DriverOpenOptions, PreparedStatement } from "./types.js";

const STMT_CACHE_MAX = 256;

/**
 * Coerce a result row's BigInt cells back to plain numbers. node:sqlite is read
 * with `readBigInts` on (so it doesn't throw on integers above 2^53); this gives
 * the same shape better-sqlite3 returns — a JS number, lossy only beyond 2^53.
 */
function coerceBigInts<T>(row: T): T {
  if (row && typeof row === "object") {
    const r = row as Record<string, unknown>;
    for (const k in r) if (typeof r[k] === "bigint") r[k] = Number(r[k]);
  }
  return row;
}

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
  private readonly onQuery?: (e: { sql: string; durationMs: number }) => void;
  private readonly cache = new Map<string, PreparedStatement>();
  private depth = 0;

  constructor(nodeSqlite: any, filename: string, options: DriverOpenOptions) {
    if (options.encryption) {
      throw new MonliteError(
        "Encryption is not supported on the node:sqlite backend. Use " +
          "better-sqlite3 with the better-sqlite3-multiple-ciphers package.",
      );
    }
    this.verbose = options.verbose;
    this.onQuery = options.onQuery;
    const { DatabaseSync } = nodeSqlite;
    this.raw = new DatabaseSync(filename, {
      readOnly: options.readonly ?? false,
      ...(options.allowExtensions ? { allowExtension: true } : {}),
    });
    if (options.allowExtensions) this.raw.enableLoadExtension(true);
    this.raw.exec(`PRAGMA busy_timeout = ${options.busyTimeout ?? 5000}`);
    this.raw.function(REGEXP_FN, { deterministic: true }, monliteRegexp);
    if (!options.readonly && (options.wal ?? true)) {
      this.raw.exec("PRAGMA journal_mode = WAL");
    }
    if (options.synchronous) {
      this.raw.exec(`PRAGMA synchronous = ${options.synchronous}`);
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

    const stmt = this.raw.prepare(sql);
    // Read large integers as BigInt so node:sqlite doesn't THROW on values above
    // 2^53 (better-sqlite3 returns a lossy number instead). We then coerce BigInt
    // back to Number below, so both drivers behave identically: a JS number, lossy
    // only beyond 2^53. (Writes of unsafe numbers are rejected upstream; use BigInt
    // or a TEXT column for exact large ids.)
    stmt.setReadBigInts?.(true);
    const report = this.onQuery;
    const time = report
      ? <R>(run: () => R): R => {
          const start = performance.now();
          try {
            return run();
          } finally {
            report({ sql, durationMs: performance.now() - start });
          }
        }
      : <R>(run: () => R): R => run();
    const wrapped: PreparedStatement = {
      run: (...p: any[]) => time(() => stmt.run(...p)),
      get: (...p: any[]) => time(() => coerceBigInts(stmt.get(...p))),
      all: (...p: any[]) =>
        time(() => (stmt.all(...p) as any[]).map(coerceBigInts)),
    };
    if (this.cache.size >= STMT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(sql, wrapped);
    return wrapped;
  }

  transaction<T>(fn: () => T, immediate = false): T {
    const savepoint = `monlite_sp_${this.depth}`;
    if (this.depth === 0)
      this.raw.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
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
      // Best-effort rollback. If the rollback itself fails, force the depth
      // back to a clean state so the connection isn't poisoned for the process.
      try {
        if (this.depth === 0) this.raw.exec("ROLLBACK");
        else this.raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        this.depth = 0;
        try {
          this.raw.exec("ROLLBACK");
        } catch {
          /* already rolled back / no active txn */
        }
      }
      throw err;
    }
  }

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    const savepoint = `monlite_sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${savepoint}`);
    this.depth++;

    try {
      const result = await fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth--;
      try {
        if (this.depth === 0) this.raw.exec("ROLLBACK");
        else this.raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        this.depth = 0;
        try {
          this.raw.exec("ROLLBACK");
        } catch {
          /* already rolled back / no active txn */
        }
      }
      throw err;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
