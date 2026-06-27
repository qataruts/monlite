import type { Driver, PreparedStatement, RunResult } from "@monlite/core";

/**
 * The subset of the sql.js module/`Database` we rely on. Passing `sql.js`'s
 * `SqlJsStatic` (the result of `initSqlJs()`) satisfies this.
 */
export interface SqlJsStatic {
  Database: new (data?: Uint8Array | null) => SqlJsDatabase;
}
export interface SqlJsDatabase {
  run(sql: string, params?: any[]): void;
  prepare(sql: string): SqlJsStatement;
  exec(sql: string): Array<{ columns: string[]; values: any[][] }>;
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
}
export interface SqlJsStatement {
  bind(params?: any[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, any>;
  run(params?: any[]): void;
  reset(): void;
  free(): void;
}

export interface WasmDriverOptions {
  /** Existing database bytes to open (e.g. restored from IndexedDB/OPFS). */
  data?: Uint8Array | null;
}

/**
 * A monlite {@link Driver} backed by SQLite-WASM (sql.js). Runs in the browser
 * (and Node). Construction is synchronous — initialise sql.js yourself first:
 *
 * ```ts
 * import initSqlJs from "sql.js";
 * import { wasmDriver } from "@monlite/wasm";
 * import { createDb } from "@monlite/core";
 *
 * const SQL = await initSqlJs({ locateFile: (f) => `/sqljs/${f}` });
 * const db = createDb(":memory:", { driver: wasmDriver(SQL) });
 * ```
 *
 * sql.js is in-memory; use {@link exportDatabase}/`{ data }` to persist (see the
 * README for IndexedDB/OPFS recipes).
 */
export class WasmDriver implements Driver {
  readonly name = "wasm-sqlite";
  readonly raw: SqlJsDatabase;
  private readonly cache = new Map<
    string,
    { stmt: SqlJsStatement; wrapped: PreparedStatement }
  >();
  private depth = 0;

  constructor(SQL: SqlJsStatic, options: WasmDriverOptions = {}) {
    this.raw = new SQL.Database(options.data ?? null);
    this.raw.run("PRAGMA foreign_keys = ON");
  }

  exec(sql: string): void {
    this.raw.run(sql);
  }

  private lastInsertRowid(): number {
    const res = this.raw.exec("SELECT last_insert_rowid() AS id");
    return (res[0]?.values?.[0]?.[0] as number) ?? 0;
  }

  prepare(sql: string): PreparedStatement {
    const cached = this.cache.get(sql);
    if (cached) return cached.wrapped;

    const stmt = this.raw.prepare(sql);
    // Arrow functions capture the driver's `this` lexically.
    const wrapped: PreparedStatement = {
      run: (...params: any[]): RunResult => {
        stmt.run(params);
        return {
          changes: this.raw.getRowsModified(),
          lastInsertRowid: this.lastInsertRowid(),
        };
      },
      get: (...params: any[]): any => {
        stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.reset();
        return row;
      },
      all: (...params: any[]): any[] => {
        stmt.bind(params);
        const rows: any[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.reset();
        return rows;
      },
    };
    this.cache.set(sql, { stmt, wrapped });
    return wrapped;
  }

  transaction<T>(fn: () => T): T {
    const savepoint = `monlite_sp_${this.depth}`;
    if (this.depth === 0) this.raw.run("BEGIN");
    else this.raw.run(`SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.raw.run("COMMIT");
      else this.raw.run(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth--;
      try {
        if (this.depth === 0) this.raw.run("ROLLBACK");
        else this.raw.run(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        this.depth = 0;
        try {
          this.raw.run("ROLLBACK");
        } catch {
          /* no active transaction */
        }
      }
      throw err;
    }
  }

  /** Serialize the whole database to bytes (for persistence). */
  export(): Uint8Array {
    return this.raw.export();
  }

  close(): void {
    for (const { stmt } of this.cache.values()) stmt.free();
    this.cache.clear();
    this.raw.close();
  }
}

/** Create a WASM-backed monlite driver from an initialised sql.js module. */
export function wasmDriver(
  SQL: SqlJsStatic,
  options?: WasmDriverOptions,
): WasmDriver {
  return new WasmDriver(SQL, options);
}

/**
 * Serialize a monlite database opened with the WASM driver to bytes — persist
 * these (IndexedDB/OPFS/file) and reopen with `wasmDriver(SQL, { data })`.
 */
export function exportDatabase(db: { driver: Driver }): Uint8Array {
  const driver = db.driver;
  if (!(driver instanceof WasmDriver)) {
    throw new Error(
      "exportDatabase requires a database opened with the WASM driver",
    );
  }
  return driver.export();
}
