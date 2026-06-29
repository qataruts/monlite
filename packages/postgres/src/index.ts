/**
 * @monlite/postgres — the Postgres engine for monlite.
 *
 * The same `@monlite/core` API, on a networked Postgres (documents stored as JSONB) instead of
 * a local SQLite file. Open a database with `createDb("postgres://…")` from this package, or
 * pass `postgres(url)` as core's `driver`. Your collection code is identical — swap the engine,
 * not your app.
 */
import pg from "pg";
import {
  createDb as coreCreateDb,
  type AsyncDriver,
  type AsyncQueryResult,
  type Monlite,
  type MonliteOptions,
} from "@monlite/core";

export interface PgEngineOptions {
  /** node-postgres pool config (max connections, ssl, statement_timeout, …). */
  pool?: pg.PoolConfig;
}

/**
 * An {@link AsyncDriver} over node-postgres — the "plug" the monlite core branches to. It is
 * pooled; rewrites the core's `?` placeholders to `$1,$2,…`; runs a transaction on one
 * checked-out client (nested transactions use SAVEPOINTs); and serializes top-level
 * transactions so concurrent ones never share a client.
 */
export class PgDriver implements AsyncDriver {
  readonly name = "postgres";
  readonly async = true as const;
  private readonly pool: pg.Pool;
  private txClient: pg.PoolClient | null = null;
  private depth = 0;
  private afterCommitHooks: Array<() => void> = [];
  private txTail: Promise<unknown> = Promise.resolve();

  constructor(connectionString: string, opts: PgEngineOptions = {}) {
    this.pool = new pg.Pool({ connectionString, ...opts.pool });
  }

  /** The core query builders emit `?`; Postgres wants `$1,$2,…`. */
  private rewrite(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  /** Route to the in-flight transaction's client when one is open, else the pool. */
  private get q(): pg.Pool | pg.PoolClient {
    return this.txClient ?? this.pool;
  }

  async exec(sql: string): Promise<void> {
    await this.q.query(this.rewrite(sql));
  }

  async query(sql: string, params: unknown[] = []): Promise<AsyncQueryResult> {
    const r = await this.q.query(this.rewrite(sql), params as any[]);
    return { rows: r.rows, changes: r.rowCount ?? 0 };
  }

  afterCommit(cb: () => void): void {
    if (this.depth === 0) cb();
    else this.afterCommitHooks.push(cb);
  }

  private runAfterCommit(): void {
    const hooks = this.afterCommitHooks;
    this.afterCommitHooks = [];
    for (const h of hooks) {
      try {
        h();
      } catch {
        /* a post-commit hook must not break its siblings */
      }
    }
  }

  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    // Nested: SAVEPOINT on the in-flight client (re-queuing here would deadlock).
    if (this.depth > 0) return this.runTxn(fn);
    // Top-level: serialize so two concurrent transactions don't share `txClient`.
    const run = this.txTail.then(() => this.runTxn(fn));
    this.txTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTxn<T>(fn: () => Promise<T>): Promise<T> {
    const top = this.depth === 0;
    if (top) this.txClient = await this.pool.connect();
    const client = this.txClient!;
    const sp = `monlite_sp_${this.depth}`;
    await client.query(top ? "BEGIN" : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = await fn();
      this.depth--;
      await client.query(top ? "COMMIT" : `RELEASE SAVEPOINT ${sp}`);
      if (top) this.runAfterCommit();
      return result;
    } catch (err) {
      this.depth--;
      try {
        await client.query(top ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${sp}`);
      } catch {
        /* already rolled back */
      }
      if (top) this.afterCommitHooks = [];
      throw err;
    } finally {
      if (top) {
        client.release();
        this.txClient = null;
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Build a Postgres engine driver for monlite (pass it as `createDb(x, { driver })`). */
export function postgres(
  connectionString: string,
  opts?: PgEngineOptions,
): PgDriver {
  return new PgDriver(connectionString, opts);
}

/**
 * Open a monlite database backed by Postgres — the same API as `@monlite/core`'s `createDb`,
 * engine swapped.
 *
 * ```ts
 * import { createDb } from "@monlite/postgres";
 * const db = createDb("postgres://user@host/db");
 * await db.collection("users").create({ data: { name: "Ada", age: 30 } }); // identical API
 * const adults = await db.collection("users").findMany({ where: { age: { gte: 18 } } });
 * ```
 */
export function createDb(
  connectionString: string,
  opts: PgEngineOptions & Omit<MonliteOptions, "driver"> = {},
): Monlite {
  const { pool, ...monliteOpts } = opts;
  return coreCreateDb(connectionString, {
    ...monliteOpts,
    driver: new PgDriver(connectionString, { pool }),
  });
}
