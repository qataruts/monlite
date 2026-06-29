import { MonliteEncryptionError } from "../errors.js";
import { REGEXP_FN, monliteRegexp } from "./regexp.js";
import type { Driver, DriverOpenOptions, PreparedStatement } from "./types.js";

const STMT_CACHE_MAX = 256;

const quote = (s: string) => s.replace(/'/g, "''");

/** Adapter over the `better-sqlite3` native driver. */
export class BetterSqlite3Driver implements Driver {
  readonly name = "better-sqlite3";
  readonly raw: any;
  private readonly verbose?: (sql: string) => void;
  private readonly onQuery?: (e: { sql: string; durationMs: number }) => void;
  private readonly cache = new Map<string, PreparedStatement>();

  constructor(
    BetterSqlite3: any,
    filename: string,
    options: DriverOpenOptions,
  ) {
    this.verbose = options.verbose;
    this.onQuery = options.onQuery;
    this.raw = new BetterSqlite3(filename, {
      readonly: options.readonly ?? false,
    });
    // The key must be applied before any other access to the database.
    if (options.encryption) {
      this.applyKey(options.encryption.key, options.encryption.cipher);
    }
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma(`busy_timeout = ${options.busyTimeout ?? 5000}`);
    this.raw.function(REGEXP_FN, { deterministic: true }, monliteRegexp);
    if (!options.readonly && (options.wal ?? true)) {
      this.raw.pragma("journal_mode = WAL");
    }
    if (options.synchronous) {
      this.raw.pragma(`synchronous = ${options.synchronous}`);
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
    const raw = this.raw.prepare(sql) as PreparedStatement; // reusable
    const stmt = this.onQuery ? this.timed(sql, raw) : raw;
    this.cacheStmt(sql, stmt);
    return stmt;
  }

  /** Wrap a statement so each execution reports its duration to `onQuery`. */
  private timed(sql: string, stmt: PreparedStatement): PreparedStatement {
    const report = this.onQuery!;
    const time = <R>(run: () => R): R => {
      const start = performance.now();
      try {
        return run();
      } finally {
        report({ sql, durationMs: performance.now() - start });
      }
    };
    return {
      run: (...p: any[]) => time(() => stmt.run(...p)),
      get: (...p: any[]) => time(() => stmt.get(...p)),
      all: (...p: any[]) => time(() => stmt.all(...p)),
    };
  }

  private cacheStmt(sql: string, stmt: PreparedStatement): void {
    if (this.cache.size >= STMT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(sql, stmt);
  }

  /** Callbacks to run after the OUTERMOST transaction commits (see {@link afterCommit}). */
  private afterCommitHooks: Array<() => void> = [];

  afterCommit(cb: () => void): void {
    if (!this.raw.inTransaction) cb();
    else this.afterCommitHooks.push(cb);
  }

  private runAfterCommit(): void {
    const hooks = this.afterCommitHooks;
    this.afterCommitHooks = [];
    for (const h of hooks) {
      try {
        h();
      } catch {
        /* a post-commit hook must not break siblings */
      }
    }
  }

  transaction<T>(fn: () => T, immediate = false): T {
    // Nested calls automatically use SAVEPOINTs in better-sqlite3.
    const top = !this.raw.inTransaction;
    const tx = this.raw.transaction(fn);
    try {
      const result = immediate ? tx.immediate() : tx();
      if (top) this.runAfterCommit(); // outermost committed
      return result;
    } catch (err) {
      if (top) this.afterCommitHooks = []; // outermost rolled back — discard
      throw err;
    }
  }

  private asyncSp = 0;

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    // BEGIN IMMEDIATE at the top level; SAVEPOINT when already in a transaction.
    const top = !this.raw.inTransaction;
    const sp = `monlite_async_${this.asyncSp++}`;
    this.raw.exec(top ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    try {
      const result = await fn();
      this.raw.exec(top ? "COMMIT" : `RELEASE ${sp}`);
      if (top) this.runAfterCommit();
      return result;
    } catch (err) {
      try {
        this.raw.exec(top ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch {
        /* already rolled back */
      }
      if (top) this.afterCommitHooks = []; // discard hooks from the rolled-back txn
      throw err;
    } finally {
      if (top) this.asyncSp = 0;
    }
  }

  /** Apply the encryption key and verify it by reading the schema. */
  private applyKey(key: string, cipher?: string): void {
    if (cipher) this.raw.pragma(`cipher='${quote(cipher)}'`);
    this.raw.pragma(`key='${quote(key)}'`);
    try {
      // A wrong key (or an unencrypted file) fails here with SQLITE_NOTADB.
      this.raw.exec("SELECT count(*) FROM sqlite_master");
    } catch (err) {
      this.raw.close();
      throw new MonliteEncryptionError(
        "Failed to open the encrypted database: the key is incorrect, or the " +
          "file is not encrypted.",
        { cause: err },
      );
    }
  }

  rekey(key: string, cipher?: string): void {
    if (cipher) this.raw.pragma(`cipher='${quote(cipher)}'`);
    // Rekeying is not permitted in WAL mode; drop out and restore it.
    const mode = String(this.raw.pragma("journal_mode", { simple: true }));
    const wasWal = mode.toLowerCase() === "wal";
    if (wasWal) this.raw.pragma("journal_mode = DELETE");
    this.raw.pragma(`rekey='${quote(key)}'`);
    if (wasWal) this.raw.pragma("journal_mode = WAL");
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
