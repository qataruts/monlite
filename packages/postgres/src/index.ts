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
  private readonly connectionString: string;
  private txClient: pg.PoolClient | null = null;
  private depth = 0;
  private afterCommitHooks: Array<() => void> = [];
  private txTail: Promise<unknown> = Promise.resolve();

  constructor(connectionString: string, opts: PgEngineOptions = {}) {
    this.connectionString = connectionString;
    this.pool = new pg.Pool({ connectionString, ...opts.pool });
  }

  /**
   * The core query builders emit `?`; Postgres wants `$1,$2,…`. Rewrite is
   * string-literal aware: a `?` inside a `'…'` literal (e.g. a JSONB key like
   * `data->>'a?b'`) is NOT a placeholder and must not be renumbered.
   */
  private rewrite(sql: string): string {
    let out = "";
    let n = 0;
    let inStr = false;
    for (let k = 0; k < sql.length; k++) {
      const c = sql[k];
      if (inStr) {
        out += c;
        if (c === "'") {
          if (sql[k + 1] === "'") {
            out += "'";
            k++; // a doubled '' is an escaped quote, still inside the literal
          } else {
            inStr = false;
          }
        }
      } else if (c === "'") {
        inStr = true;
        out += c;
      } else if (c === "?") {
        out += "$" + ++n;
      } else {
        out += c;
      }
    }
    return out;
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
    let entered = false; // BEGIN/SAVEPOINT succeeded → depth was incremented
    let poisoned = false; // client may be in a bad state → discard on release
    try {
      await client.query(top ? "BEGIN" : `SAVEPOINT ${sp}`);
      entered = true;
      this.depth++;
      try {
        const result = await fn();
        // depth is decremented exactly once, in the outer finally — NOT here, so a
        // throwing COMMIT/RELEASE below can't double-decrement and corrupt the driver.
        await client.query(top ? "COMMIT" : `RELEASE SAVEPOINT ${sp}`);
        if (top) this.runAfterCommit();
        return result;
      } catch (err) {
        poisoned = true;
        try {
          await client.query(top ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${sp}`);
          poisoned = false; // rolled back cleanly → the client is safe to reuse
        } catch {
          /* connection likely dead → keep poisoned so it's discarded, not pooled */
        }
        if (top) this.afterCommitHooks = [];
        throw err;
      }
    } catch (e) {
      if (!entered) poisoned = true; // BEGIN/connect itself failed
      throw e;
    } finally {
      if (entered) this.depth--;
      if (top) {
        this.txClient = null;
        // Pass a truthy arg to release() to DESTROY a poisoned client (a half-rolled-
        // back / dead connection) instead of returning it to the pool.
        client.release(poisoned || undefined);
      }
    }
  }

  /**
   * Subscribe to a Postgres channel via `LISTEN` on a DEDICATED connection (a
   * listening connection must stay open and out of the query pool). Returns an
   * unsubscribe that `UNLISTEN`s and closes the connection.
   */
  async listen(
    channel: string,
    handler: (payload: string) => void,
  ): Promise<() => Promise<void>> {
    let stopped = false;
    let current: pg.Client | null = null;

    const open = async (): Promise<void> => {
      const c = new pg.Client({ connectionString: this.connectionString });
      // A dedicated LISTEN connection lives for the process lifetime. Without an
      // 'error' handler, a server restart / network reset emits an unhandled
      // 'error' that crashes the host process. Handle it AND reconnect, so watch()
      // survives a blip instead of silently dying.
      c.on("error", () => {
        if (stopped || current !== c) return;
        current = null;
        c.removeAllListeners();
        void c.end().catch(() => {});
        const t = setTimeout(() => {
          if (!stopped) void open().catch(() => {});
        }, 1000);
        t.unref?.();
      });
      c.on("notification", (msg) => {
        if (!stopped && msg.channel === channel && msg.payload != null)
          handler(msg.payload);
      });
      try {
        await c.connect();
        // Quote the channel so case is preserved (matches the trigger's pg_notify).
        await c.query(`LISTEN "${channel}"`);
      } catch (err) {
        c.removeAllListeners(); // don't let a failed setup trigger a reconnect
        await c.end().catch(() => {}); // and don't leak the half-open connection
        throw err;
      }
      current = c;
    };

    await open();
    return async () => {
      stopped = true;
      const c = current;
      current = null;
      if (!c) return;
      try {
        await c.query(`UNLISTEN "${channel}"`);
      } catch {
        /* connection may already be gone */
      }
      await c.end().catch(() => {});
    };
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
