import type { RemoteChange, LocalChange } from "@monlite/core";
import type {
  SyncAdapter,
  Cursor,
  PullOptions,
  PullResult,
  PushResult,
} from "../types.js";
import {
  decodeCursor,
  cursorFor,
  encodeCursor,
  type PerCollectionCursor,
} from "../cursor.js";

const VERSION = "_monlite_v";
const DELETED = "_monlite_deleted";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Minimal surface of a mysql2/promise `Pool`/`Connection` (`query` → `[rows]`). */
export interface MySqlQueryable {
  query(sql: string, params?: any[]): Promise<[any, any]>;
}

export interface MySqlAdapterOptions {
  /** A connected `mysql2/promise` Pool (or Connection) from the `mysql2` peer dependency. */
  pool: MySqlQueryable;
  /** State/cursor key. Defaults to `mysql`. */
  name?: string;
  /** Map a local collection name to a MySQL table name. */
  collectionMap?: (name: string) => string;
}

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid ${what} "${name}" for the MySQL adapter`);
  }
  return `\`${name}\``;
}

function stripId(doc: Record<string, any>): Record<string, any> {
  const { _id, ...rest } = doc;
  return rest;
}

/**
 * Replicates against MySQL (and MariaDB). Each synced collection maps to a table:
 * `(_id varchar primary key, doc json, _monlite_v varchar, _monlite_deleted tinyint)`.
 *
 * - Push upserts via `INSERT … ON DUPLICATE KEY UPDATE` (soft-delete sets
 *   `_monlite_deleted`). Idempotent and keyed by `_id`.
 * - Pull reads rows whose `_monlite_v` is greater than the cursor, in order.
 *
 * The version travels in `_monlite_v` so changes round-trip without echoing.
 * Tables are auto-created on first use. (Polling only — no live `watch()` yet.)
 */
export class MySqlAdapter implements SyncAdapter {
  readonly name: string;
  private readonly pool: MySqlQueryable;
  private readonly map: (n: string) => string;
  private readonly ensured = new Set<string>();

  constructor(opts: MySqlAdapterOptions) {
    this.pool = opts.pool;
    this.name = opts.name ?? "mysql";
    this.map = opts.collectionMap ?? ((n) => n);
  }

  /** Ensure the backing table exists; returns its quoted name. */
  private async ensure(collection: string): Promise<string> {
    const table = this.map(collection);
    const quoted = ident(table, "table");
    if (this.ensured.has(table)) return quoted;
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${quoted} (
        _id VARCHAR(255) PRIMARY KEY,
        doc JSON,
        ${VERSION} VARCHAR(255) NOT NULL,
        ${DELETED} TINYINT(1) NOT NULL DEFAULT 0,
        INDEX ${ident(`${table}_monlite_v`, "index")} (${VERSION})
      )`,
    );
    this.ensured.add(table);
    return quoted;
  }

  async push(changes: LocalChange[]): Promise<PushResult> {
    const acked: LocalChange[] = [];
    const rejected: Array<{ change: LocalChange; reason: string }> = [];
    for (const c of changes) {
      try {
        const t = await this.ensure(c.collection);
        if (c.op === "delete") {
          await this.pool.query(
            `INSERT INTO ${t} (_id, doc, ${VERSION}, ${DELETED}) VALUES (?, NULL, ?, 1)
             ON DUPLICATE KEY UPDATE ${DELETED} = 1, doc = NULL, ${VERSION} = VALUES(${VERSION})`,
            [c._id, c.version],
          );
        } else {
          await this.pool.query(
            `INSERT INTO ${t} (_id, doc, ${VERSION}, ${DELETED}) VALUES (?, ?, ?, 0)
             ON DUPLICATE KEY UPDATE doc = VALUES(doc), ${VERSION} = VALUES(${VERSION}), ${DELETED} = 0`,
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
    // Per-collection cursors (see cursor.ts) — a global max skips lagging collections.
    const dec = decodeCursor(cursor);
    const next: PerCollectionCursor = { ...dec.perColl };

    for (const collName of collections) {
      const t = await this.ensure(collName);
      const since = cursorFor(dec, collName);
      let maxVersion = since;
      const params: any[] = [since];
      // CAST(... AS BINARY) forces byte-order comparison so SQL `>` and the JS
      // string ordering the cursor relies on agree, regardless of column collation.
      let sql = `SELECT _id, doc, ${VERSION} AS v, ${DELETED} AS deleted FROM ${t} WHERE CAST(${VERSION} AS BINARY) > ? ORDER BY CAST(${VERSION} AS BINARY) ASC`;
      if (opts.limit != null && opts.limit > 0) {
        sql += ` LIMIT ?`;
        params.push(opts.limit);
      }
      const [rows] = await this.pool.query(sql, params);
      for (const r of rows as any[]) {
        const version: string = r.v ?? "";
        // mysql2 returns JSON columns as objects, but be defensive about strings.
        const doc = typeof r.doc === "string" ? JSON.parse(r.doc) : r.doc;
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
            doc: { ...(doc ?? {}), _id: r._id },
          });
        }
        if (version > maxVersion) maxVersion = version;
      }
      next[collName] = maxVersion;
    }
    return { changes, cursor: encodeCursor(next) };
  }
}
