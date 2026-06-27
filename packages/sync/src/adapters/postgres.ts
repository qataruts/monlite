import type { RemoteChange, LocalChange } from "@monlite/core";
import type {
  SyncAdapter,
  Cursor,
  PullOptions,
  PullResult,
  PushResult,
} from "../types.js";

const VERSION = "_monlite_v";
const DELETED = "_monlite_deleted";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Minimal surface of a node-postgres `Pool`/`Client`. */
export interface PgQueryable {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface PostgresAdapterOptions {
  /** A connected node-postgres `Pool` (or `Client`) from the `pg` peer dependency. */
  pool: PgQueryable;
  /** Postgres schema to use. Default `"public"`. */
  schema?: string;
  /** State/cursor key. Defaults to `postgres:<schema>`. */
  name?: string;
  /** Map a local collection name to a Postgres table name. */
  collectionMap?: (name: string) => string;
}

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid ${what} "${name}" for the Postgres adapter`);
  }
  return `"${name}"`;
}

function stripId(doc: Record<string, any>): Record<string, any> {
  const { _id, ...rest } = doc;
  return rest;
}

/**
 * Replicates against PostgreSQL. Each synced collection maps to a table:
 * `(_id text primary key, doc jsonb, _monlite_v text, _monlite_deleted bool)`.
 *
 * - Push upserts via `INSERT … ON CONFLICT (_id) DO UPDATE` (soft-delete sets
 *   `_monlite_deleted`). Idempotent and keyed by `_id`.
 * - Pull reads rows whose `_monlite_v` is greater than the cursor, in order.
 *
 * The version travels in `_monlite_v` so changes round-trip without echoing.
 * Tables are auto-created on first use. (Polling only — no live `watch()` yet.)
 */
export class PostgresAdapter implements SyncAdapter {
  readonly name: string;
  private readonly pool: PgQueryable;
  private readonly schema: string;
  private readonly map: (n: string) => string;
  private readonly ensured = new Set<string>();

  constructor(opts: PostgresAdapterOptions) {
    this.pool = opts.pool;
    this.schema = opts.schema ?? "public";
    ident(this.schema, "schema"); // validate early
    this.name = opts.name ?? `postgres:${this.schema}`;
    this.map = opts.collectionMap ?? ((n) => n);
  }

  /** Ensure the backing table exists; returns its quoted, qualified name. */
  private async ensure(collection: string): Promise<string> {
    const table = this.map(collection);
    const qualified = `${ident(this.schema, "schema")}.${ident(table, "table")}`;
    if (this.ensured.has(table)) return qualified;
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualified} (
        _id TEXT PRIMARY KEY,
        doc JSONB,
        ${VERSION} TEXT NOT NULL,
        ${DELETED} BOOLEAN NOT NULL DEFAULT false
      )`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${ident(`${table}_monlite_v`, "index")} ON ${qualified} (${VERSION})`,
    );
    this.ensured.add(table);
    return qualified;
  }

  async push(changes: LocalChange[]): Promise<PushResult> {
    const acked: LocalChange[] = [];
    const rejected: Array<{ change: LocalChange; reason: string }> = [];
    for (const c of changes) {
      try {
        const q = await this.ensure(c.collection);
        if (c.op === "delete") {
          await this.pool.query(
            `INSERT INTO ${q} (_id, doc, ${VERSION}, ${DELETED}) VALUES ($1, NULL, $2, true)
             ON CONFLICT (_id) DO UPDATE SET ${DELETED} = true, doc = NULL, ${VERSION} = EXCLUDED.${VERSION}`,
            [c._id, c.version],
          );
        } else {
          await this.pool.query(
            `INSERT INTO ${q} (_id, doc, ${VERSION}, ${DELETED}) VALUES ($1, $2::jsonb, $3, false)
             ON CONFLICT (_id) DO UPDATE SET doc = EXCLUDED.doc, ${VERSION} = EXCLUDED.${VERSION}, ${DELETED} = false`,
            [c._id, JSON.stringify(stripId(c.doc ?? {})), c.version],
          );
        }
        acked.push(c);
      } catch (err: any) {
        rejected.push({ change: c, reason: String(err?.message ?? err) });
      }
    }
    return rejected.length ? { acked, rejected } : { acked };
  }

  async pull(cursor: Cursor, opts: PullOptions): Promise<PullResult> {
    const collections = opts.collections ?? [];
    const changes: RemoteChange[] = [];
    let maxVersion = cursor ?? "";

    for (const collName of collections) {
      const q = await this.ensure(collName);
      const params: any[] = [cursor ?? ""];
      let sql = `SELECT _id, doc, ${VERSION} AS v, ${DELETED} AS deleted FROM ${q} WHERE ${VERSION} > $1 ORDER BY ${VERSION} ASC`;
      if (opts.limit != null && opts.limit > 0) {
        sql += ` LIMIT $2`;
        params.push(opts.limit);
      }
      const { rows } = await this.pool.query(sql, params);
      for (const r of rows) {
        const version: string = r.v ?? "";
        if (r.deleted) {
          changes.push({
            collection: collName,
            _id: r._id,
            op: "delete",
            version,
          });
        } else {
          changes.push({
            collection: collName,
            _id: r._id,
            op: "upsert",
            version,
            doc: { ...(r.doc ?? {}), _id: r._id },
          });
        }
        if (version > maxVersion) maxVersion = version;
      }
    }
    return { changes, cursor: maxVersion || null };
  }
}
