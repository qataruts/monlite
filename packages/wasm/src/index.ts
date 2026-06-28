import {
  REGEXP_FN,
  monliteRegexp,
  type Driver,
  type PreparedStatement,
  type RunResult,
} from "@monlite/core";

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
  create_function(name: string, fn: (...args: any[]) => any): void;
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
    this.raw.create_function(REGEXP_FN, monliteRegexp); // backs the `regex` operator
  }

  exec(sql: string): void {
    this.raw.run(sql);
  }

  /**
   * Better-sqlite3-compatible escape hatch surfaced as `db.sqlite`. sql.js's own
   * `Statement.get()` returns column-value arrays, not row objects, which breaks
   * plugins (fts, vector, kv) that expect `prepare().get()/.all()` to return
   * objects. Route those through the driver's normalized statements; pass the
   * remaining native methods straight to the sql.js handle.
   */
  get sqlite(): any {
    return {
      prepare: (sql: string) => this.prepare(sql),
      exec: (sql: string) => this.exec(sql),
      run: (sql: string, params: any[] = []) => this.raw.run(sql, params),
      export: () => this.export(),
      create_function: (name: string, fn: (...a: any[]) => any) =>
        this.raw.create_function(name, fn),
      raw: this.raw,
    };
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

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    const savepoint = `monlite_sp_${this.depth}`;
    if (this.depth === 0) this.raw.run("BEGIN IMMEDIATE");
    else this.raw.run(`SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = await fn();
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
          /* already rolled back */
        }
      }
      throw err;
    }
  }

  /** Serialize the whole database to bytes (for persistence). */
  export(): Uint8Array {
    const data = this.raw.export();
    // sql.js's export() finalizes the connection's prepared statements, so any
    // statement we cached is now dead ("Statement closed"). Drop the cache; the
    // next prepare() re-creates them against the live connection.
    this.cache.clear();
    return data;
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
