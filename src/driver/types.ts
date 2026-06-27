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
  close(): void;
  /** The underlying native handle (better-sqlite3 Database / node:sqlite DatabaseSync). */
  readonly raw: any;
}

export interface DriverOpenOptions {
  readonly?: boolean;
  wal?: boolean;
  /** Milliseconds to wait on a locked database before erroring. Default 5000. */
  busyTimeout?: number;
  /** Allow loading SQLite extensions (needed by `@monlite/vector`). Default false. */
  allowExtensions?: boolean;
  verbose?: (sql: string) => void;
}

export type DriverName = "auto" | "better-sqlite3" | "node:sqlite";
