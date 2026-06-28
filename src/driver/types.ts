/**
 * The minimal SQLite driver surface monlite needs. Implemented by both the
 * better-sqlite3 and the built-in node:sqlite backends so the rest of the
 * codebase is engine-agnostic.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: any[]): RunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface Driver {
  /** Backend identifier, e.g. "better-sqlite3" or "node:sqlite". */
  readonly name: string;
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  /** Run `fn` inside a transaction; rolls back and rethrows if it throws. */
  transaction<T>(fn: () => T): T;
  /**
   * Like {@link transaction} but `fn` may be async — the transaction stays open
   * across `await`s (BEGIN IMMEDIATE … COMMIT). Optional: custom drivers that
   * don't implement it can't use `db.transactionAsync`.
   */
  transactionAsync?<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
  /** Rotate the encryption key (encrypted backends only). */
  rekey?(key: string, cipher?: string): void;
  /** The underlying native handle (better-sqlite3 Database / node:sqlite DatabaseSync). */
  readonly raw: any;
  /**
   * Optional escape-hatch handle exposed as `db.sqlite`, with a
   * better-sqlite3-compatible `prepare().get()/.all()/.run()` + `exec()`. Drivers
   * whose `raw` already has that shape (better-sqlite3, node:sqlite) omit it and
   * `db.sqlite` falls back to `raw`. The wasm driver provides it so plugins
   * (fts, vector, kv) work in the browser where `raw` is the sql.js handle.
   */
  readonly sqlite?: any;
}

export interface DriverOpenOptions {
  readonly?: boolean;
  wal?: boolean;
  /** Milliseconds to wait on a locked database before erroring. Default 5000. */
  busyTimeout?: number;
  /** Durability vs speed: SQLite `synchronous` mode. WAL default is `NORMAL`. */
  synchronous?: "OFF" | "NORMAL" | "FULL" | "EXTRA";
  /** Allow loading SQLite extensions (needed by `@monlite/vector`). Default false. */
  allowExtensions?: boolean;
  /** Encrypt the database at rest (better-sqlite3-multiple-ciphers only). */
  encryption?: { key: string; cipher?: string };
  verbose?: (sql: string) => void;
  /** Observability hook: called after each statement executes, with its timing. */
  onQuery?: (event: { sql: string; durationMs: number }) => void;
}

export type DriverName = "auto" | "better-sqlite3" | "node:sqlite";
