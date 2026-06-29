import type { Monlite } from "./db.js";
import type {
  AggregateArgs,
  AggregateResult,
  BulkWriteOp,
  BulkWriteResult,
  CollectionMode,
  CollectionOptions,
  ColumnDef,
  ColumnType,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  Doc,
  FindOneAndUpdateArgs,
  ExplainResult,
  FindFirstArgs,
  FindManyArgs,
  GroupByArgs,
  GroupByResult,
  LiveEvent,
  LookupSpec,
  MigrateOptions,
  Projected,
  Select,
  UpdateArgs,
  UpdateData,
  UpsertArgs,
  WatchArgs,
  WatchHandle,
  WhereInput,
  WithId,
} from "./types.js";
import { objectId } from "./id.js";
import { LiveQuery, PgLiveQuery } from "./reactive.js";
import {
  MonliteError,
  MonliteQueryError,
  normalizeDriverError,
} from "./errors.js";
import { buildWhere } from "./query/where.js";
import { buildOrderBy } from "./query/order.js";
import { project } from "./query/select.js";
import { applyUpdate } from "./query/update.js";
import {
  bindable,
  fieldExpr,
  isBuffer,
  isColumn,
  pathLiteral,
  RESERVED_FIELDS,
} from "./query/sql.js";
import { aggregate, groupBy } from "./aggregation/aggregate.js";

type Row = Record<string, any>;

function stripSystem(obj: Record<string, any>): Record<string, any> {
  const { _id, created_at, updated_at, ...rest } = obj;
  return rest;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UTF8 = new TextEncoder();

function sqliteType(type: ColumnType): string {
  return type === "JSON" ? "TEXT" : type;
}

function formatDefault(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * A collection. In **document** mode (default) every document is stored as JSON
 * in a `data` column — schema-free. In **structured** mode (when a `schema` is
 * given) the listed fields become real, typed SQL columns (fast, indexable,
 * joinable) while any other fields overflow into a JSON `data` column. The CRUD
 * and query API is identical in both modes.
 */
export class Collection<T = Doc> {
  readonly mode: CollectionMode;

  private initialized = false;
  private readonly columnDefs: Record<string, ColumnDef> = {};
  private readonly columnOrder: string[] = [];
  /** Declared native columns (empty in document mode). */
  private readonly columns = new Set<string>();
  private readonly jsonColumns = new Set<string>();
  private readonly uniqueIndexes: string[][];
  private readonly ttl?: { field: string; seconds: number };
  private insertSqlCache?: string;

  private readonly trackPath = (path: string) =>
    this.mon.autoIndexer.track(this.name, path);

  constructor(
    private readonly mon: Monlite,
    readonly name: string,
    options: CollectionOptions = {},
  ) {
    this.mode = options.schema ? "structured" : "document";

    const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
    this.uniqueIndexes = options.uniqueIndexes ?? [];
    for (const fields of this.uniqueIndexes) {
      for (const f of fields) {
        if (!FIELD_RE.test(f)) {
          throw new MonliteError(`Invalid field "${f}" in a unique index`);
        }
      }
    }
    if (options.ttl) {
      if (!FIELD_RE.test(options.ttl.field)) {
        throw new MonliteError(`Invalid ttl field "${options.ttl.field}"`);
      }
      this.ttl = options.ttl;
    }

    if (options.schema) {
      for (const [field, def] of Object.entries(options.schema)) {
        if (!NAME_RE.test(field)) {
          throw new MonliteError(`Invalid column name "${field}"`);
        }
        if (RESERVED_FIELDS.has(field) || field === "data") {
          throw new MonliteError(
            `Column "${field}" is reserved by monlite and cannot be declared`,
          );
        }
        const normalized: ColumnDef =
          typeof def === "string" ? { type: def } : def;
        if (
          normalized.references &&
          !/^[A-Za-z_][A-Za-z0-9_]*(\([A-Za-z_][A-Za-z0-9_]*\))?$/.test(
            normalized.references,
          )
        ) {
          throw new MonliteError(
            `Invalid references "${normalized.references}" on column "${field}"`,
          );
        }
        this.columnDefs[field] = normalized;
        this.columnOrder.push(field);
        this.columns.add(field);
        if (normalized.type === "JSON") this.jsonColumns.add(field);
      }
      // Structured collections ensure/migrate their table on declaration, so
      // schema changes (added columns) take effect immediately, not lazily.
      this.ensureTable();
    }
  }

  private get db() {
    return this.mon.driver;
  }

  /** Run a DB operation, normalizing driver errors into typed MonliteErrors. */
  private guard<R>(fn: () => R): R {
    try {
      return fn();
    } catch (err) {
      throw normalizeDriverError(err, this.name);
    }
  }

  /** Enforce `maxDocumentBytes` (a guard against unbounded/untrusted input). */
  private assertDocSize(doc: Record<string, any>): void {
    const max = this.mon.maxDocumentBytes;
    if (!max) return;
    const bytes = UTF8.encode(JSON.stringify(doc)).length;
    if (bytes > max) {
      throw new MonliteQueryError(
        `Document exceeds maxDocumentBytes for "${this.name}" (${bytes} > ${max} bytes)`,
      );
    }
  }

  /** Native column names declared for this collection (structured mode). */
  get columnNames(): string[] {
    return [...this.columnOrder];
  }

  private pgInitialized = false;
  private pgNotifyReady = false;

  /** Create this collection's Postgres (JSONB) table, once. */
  private async ensureTablePg(): Promise<void> {
    if (this.pgInitialized) return;
    await this.mon.asyncDriver!.exec(
      `CREATE TABLE IF NOT EXISTS "${this.name}" (` +
        `_id text PRIMARY KEY, data jsonb NOT NULL, ` +
        `created_at bigint NOT NULL, updated_at bigint NOT NULL)`,
    );
    this.pgInitialized = true;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    // Postgres engine: tables are created asynchronously via ensureTablePg(); the
    // synchronous SQLite path below is left entirely unchanged.
    if (this.mon.asyncDriver) return;

    if (this.mode === "document") {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS "${this.name}" (
          _id        TEXT    PRIMARY KEY,
          data       TEXT    NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      );
    } else {
      const lines = [
        `_id        TEXT    PRIMARY KEY`,
        `created_at INTEGER NOT NULL`,
        `updated_at INTEGER NOT NULL`,
        `data       TEXT    NOT NULL DEFAULT '{}'`,
        ...this.columnOrder.map((f) => this.columnDdl(f, false)),
      ];
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS "${this.name}" (\n  ${lines.join(",\n  ")}\n)`,
      );
      this.migrateColumns();
      for (const field of this.columnOrder) {
        if (this.columnDefs[field]!.index) {
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS "idx_${this.name}_${field}" ON "${this.name}"("${field}")`,
          );
        }
      }
    }
    this.createUniqueIndexes();
    this.initialized = true;
  }

  /** SQL expression for a field — a column (incl. system fields) or a JSON path. */
  private fieldSqlExpr(field: string): string {
    return fieldExpr(
      field,
      new Set([...this.columns, "_id", "created_at", "updated_at"]),
    );
  }

  private createUniqueIndexes(): void {
    this.uniqueIndexes.forEach((fields, i) => {
      const exprs = fields.map((f) => this.fieldSqlExpr(f)).join(", ");
      try {
        this.db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS "uqx_${this.name}_${i}" ON "${this.name}"(${exprs})`,
        );
      } catch (err) {
        // Existing rows already violate the new unique index — surface a typed
        // error instead of a raw driver SqliteError.
        throw new MonliteError(
          `Cannot create a unique index on (${fields.join(", ")}) for "${this.name}": ` +
            `existing rows are not unique on those fields.`,
        );
      }
    });
  }

  private columnDdl(field: string, forAlter: boolean): string {
    const def = this.columnDefs[field]!;
    let line = `"${field}" ${sqliteType(def.type)}`;
    if (def.notNull) line += " NOT NULL";
    // SQLite can't add a UNIQUE column via ALTER — enforce it with a unique index instead.
    if (def.unique && !forAlter) line += " UNIQUE";
    if (def.default !== undefined)
      line += ` DEFAULT ${formatDefault(def.default)}`;
    if (def.references) line += ` REFERENCES ${def.references}`;
    return line;
  }

  /** Auto-additive migration: add declared columns missing from an existing table. */
  private migrateColumns(): void {
    const existing = new Set(
      (
        this.db.prepare(`PRAGMA table_info("${this.name}")`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    for (const field of this.columnOrder) {
      if (existing.has(field)) continue;
      try {
        this.db.exec(
          `ALTER TABLE "${this.name}" ADD COLUMN ${this.columnDdl(field, true)}`,
        );
      } catch (err) {
        throw new MonliteError(
          `Failed to add column "${field}" to "${this.name}": ${(err as Error).message}. ` +
            `NOT NULL columns need a default when added to an existing table.`,
        );
      }
      if (this.columnDefs[field]!.unique) {
        this.db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS "uq_${this.name}_${field}" ON "${this.name}"("${field}")`,
        );
      }
    }
  }

  private foreignKeysOn(): boolean {
    try {
      const row = this.db.prepare(`PRAGMA foreign_keys`).get() as
        | { foreign_keys?: number }
        | undefined;
      return !!row?.foreign_keys;
    } catch {
      return true; // monlite enables foreign keys at open
    }
  }

  private declaredIndexDdl(): string[] {
    // UNIQUE is emitted inline by columnDdl(false), so only regular indexes are
    // recreated here (mirrors ensureTable).
    const out: string[] = [];
    for (const field of this.columnOrder) {
      if (this.columnDefs[field]!.index) {
        out.push(
          `CREATE INDEX IF NOT EXISTS "idx_${this.name}_${field}" ON "${this.name}"("${field}")`,
        );
      }
    }
    return out;
  }

  /**
   * Reconcile the physical table to the declared schema, performing the changes
   * the auto-additive path can't: **dropping** columns, **renaming** them, and
   * **changing a column's type/constraints** — via a safe, transactional table
   * rebuild that preserves data. Structured collections only.
   *
   * Pass `rename` to map an existing physical column to a new declared name, and
   * `drop` to acknowledge columns that the new schema removes (an unacknowledged
   * column drop throws, so data is never lost by accident).
   *
   * ```ts
   * const users = db.collection("users", { schema: { name: "TEXT", age: "INTEGER" } });
   * await users.$migrate({ rename: { fullname: "name" }, drop: ["legacy"] });
   * ```
   */
  async $migrate(options: MigrateOptions = {}): Promise<void> {
    if (this.mode !== "structured") {
      throw new MonliteError(
        `$migrate() is only available on structured collections (declare a schema).`,
      );
    }
    this.ensureTable();
    const rename = options.rename ?? {};
    const drop = new Set(options.drop ?? []);
    const SYSTEM = new Set(["_id", "created_at", "updated_at", "data"]);

    const physical = (
      this.db.prepare(`PRAGMA table_info("${this.name}")`).all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .filter((n) => !SYSTEM.has(n));
    const physicalSet = new Set(physical);
    const targetSet = new Set(this.columnOrder);

    // target declared name -> source physical column to copy from.
    const renamedFrom: Record<string, string> = {};
    for (const [from, to] of Object.entries(rename)) {
      if (!physicalSet.has(from)) {
        throw new MonliteError(
          `Cannot rename "${from}": no such column in "${this.name}".`,
        );
      }
      if (!targetSet.has(to)) {
        throw new MonliteError(
          `Cannot rename "${from}" to "${to}": "${to}" is not in the schema.`,
        );
      }
      renamedFrom[to] = from;
    }

    // Any physical column not kept (same name), renamed, or dropped is an
    // unacknowledged drop — refuse it so data is never silently lost.
    const renameSources = new Set(Object.keys(rename));
    for (const col of physical) {
      if (targetSet.has(col) || renameSources.has(col) || drop.has(col))
        continue;
      throw new MonliteError(
        `Column "${col}" exists in "${this.name}" but isn't in the schema. ` +
          `Add it to the schema, or list it in \`drop\` to remove it.`,
      );
    }

    const tmp = `__mon_migrate_${this.name}`;
    const newCols = [
      `_id        TEXT    PRIMARY KEY`,
      `created_at INTEGER NOT NULL`,
      `updated_at INTEGER NOT NULL`,
      `data       TEXT    NOT NULL DEFAULT '{}'`,
      ...this.columnOrder.map((f) => this.columnDdl(f, false)),
    ];
    const destCols = [
      "_id",
      "created_at",
      "updated_at",
      "data",
      ...this.columnOrder.map((f) => `"${f}"`),
    ].join(", ");
    const srcCols = [
      "_id",
      "created_at",
      "updated_at",
      "data",
      ...this.columnOrder.map((t) => {
        const src = renamedFrom[t] ?? (physicalSet.has(t) ? t : null);
        return src ? `"${src}"` : "NULL";
      }),
    ].join(", ");

    // FK enforcement can't be toggled inside a transaction, so do it around it.
    const fkOn = this.foreignKeysOn();
    if (fkOn) this.db.exec(`PRAGMA foreign_keys = OFF`);
    try {
      this.guard(() =>
        this.db.transaction(() => {
          this.db.exec(`DROP TABLE IF EXISTS "${tmp}"`);
          this.db.exec(
            `CREATE TABLE "${tmp}" (\n  ${newCols.join(",\n  ")}\n)`,
          );
          this.db.exec(
            `INSERT INTO "${tmp}" (${destCols}) SELECT ${srcCols} FROM "${this.name}"`,
          );
          this.db.exec(`DROP TABLE "${this.name}"`);
          this.db.exec(`ALTER TABLE "${tmp}" RENAME TO "${this.name}"`);
          for (const ddl of this.declaredIndexDdl()) this.db.exec(ddl);
        }),
      );
    } finally {
      if (fkOn) this.db.exec(`PRAGMA foreign_keys = ON`);
    }
    this.insertSqlCache = undefined; // column set may have changed
  }

  /* --------------------------- row <-> doc -------------------------- */

  private rowToDoc(row: Row): WithId<T> {
    const doc =
      this.mode === "document"
        ? (JSON.parse(row.data) as Record<string, any>)
        : (JSON.parse(row.data ?? "{}") as Record<string, any>);

    if (this.mode === "structured") {
      for (const field of this.columnOrder) {
        const value = row[field];
        if (value === undefined) continue;
        if (value === null) {
          doc[field] = null; // explicit null round-trips (SQL columns always exist)
          continue;
        }
        doc[field] = this.jsonColumns.has(field) ? JSON.parse(value) : value;
      }
    }

    doc._id = row._id;
    doc.created_at = row.created_at;
    doc.updated_at = row.updated_at;
    return doc as WithId<T>;
  }

  private encodeColumn(field: string, value: any): any {
    if (this.jsonColumns.has(field)) {
      return value === undefined ? null : JSON.stringify(value);
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !isBuffer(value)
    ) {
      throw new MonliteQueryError(
        `Column "${field}" cannot store an object/array. Declare it as ` +
          `{ type: "JSON" } to store structured values.`,
      );
    }
    // Guard silent precision loss: a JS number above 2^53 can't be stored exactly
    // (better-sqlite3 rounds it; node:sqlite then can't read it back). Require a
    // BigInt (exact) or a TEXT column for large integer ids.
    if (
      this.columnDefs[field]?.type === "INTEGER" &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value)
    ) {
      throw new MonliteQueryError(
        `Column "${field}": ${value} exceeds the safe integer range (2^53). ` +
          `Pass a BigInt for an exact value, or use a TEXT column for large ids.`,
      );
    }
    return bindable(value);
  }

  private insertColumns(): string[] {
    return this.mode === "document"
      ? ["_id", "data", "created_at", "updated_at"]
      : ["_id", "created_at", "updated_at", "data", ...this.columnOrder];
  }

  private insertSql(): string {
    if (this.insertSqlCache) return this.insertSqlCache;
    const cols = this.insertColumns();
    const list = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    return (this.insertSqlCache = `INSERT INTO "${this.name}" (${list}) VALUES (${placeholders})`);
  }

  /** Split an input document into a row aligned with `insertColumns()`. */
  private buildInsert(input: Record<string, any>): {
    _id: string;
    created_at: number;
    updated_at: number;
    values: any[];
    returned: WithId<T>;
  } {
    const now = Date.now();
    const id = input._id != null ? String(input._id) : objectId();
    const doc = stripSystem(input);
    this.assertDocSize(doc);
    const returned = {
      ...doc,
      _id: id,
      created_at: now,
      updated_at: now,
    } as WithId<T>;

    if (this.mode === "document") {
      return {
        _id: id,
        created_at: now,
        updated_at: now,
        values: [id, JSON.stringify(doc), now, now],
        returned,
      };
    }

    const overflow: Record<string, any> = {};
    const colValues: Record<string, any> = {};
    for (const [k, v] of Object.entries(doc)) {
      if (this.columns.has(k)) colValues[k] = v;
      else overflow[k] = v;
    }
    // Apply column `default`s for omitted fields: binding an explicit NULL would
    // defeat the DEFAULT (and trip a notNull column). Reflect it in the returned doc.
    for (const c of this.columnOrder) {
      if (!(c in colValues)) {
        const def = this.columnDefs[c]!.default;
        if (def !== undefined) {
          colValues[c] = def;
          (returned as Record<string, any>)[c] = def;
        }
      }
    }
    const values = [
      id,
      now,
      now,
      JSON.stringify(overflow),
      ...this.columnOrder.map((c) =>
        c in colValues ? this.encodeColumn(c, colValues[c]) : null,
      ),
    ];
    return { _id: id, created_at: now, updated_at: now, values, returned };
  }

  /** Build the `SET` clause + values to persist an updated document. */
  private buildUpdateSet(
    updatedDoc: Record<string, any>,
    now: number,
  ): { setSql: string; values: any[] } {
    this.assertDocSize(updatedDoc);
    if (this.mode === "document") {
      return {
        setSql: `data = ?, updated_at = ?`,
        values: [JSON.stringify(updatedDoc), now],
      };
    }
    const overflow: Record<string, any> = {};
    const colValues: Record<string, any> = {};
    for (const [k, v] of Object.entries(updatedDoc)) {
      if (this.columns.has(k)) colValues[k] = v;
      else overflow[k] = v;
    }
    const setParts = this.columnOrder.map((c) => `"${c}" = ?`);
    setParts.push(`data = ?`, `updated_at = ?`);
    const values = [
      ...this.columnOrder.map((c) =>
        c in colValues ? this.encodeColumn(c, colValues[c]) : null,
      ),
      JSON.stringify(overflow),
      now,
    ];
    return { setSql: setParts.join(", "), values };
  }

  /** Sync store for recording local changes (both document and structured). */
  private get recorder() {
    return this.mon.$sync;
  }

  /** @internal Read a full document by id (mode-aware), synchronously. */
  getRaw(id: string): WithId<T> | null {
    this.ensureTable();
    const row = this.db
      .prepare(`SELECT * FROM "${this.name}" WHERE _id = ?`)
      .get(id) as Row | undefined;
    return row ? this.rowToDoc(row) : null;
  }

  /**
   * @internal Apply a remote change to storage WITHOUT recording it to the
   * change feed (the sync store records the `remote` feed row itself). Used by
   * `@monlite/sync` so structured collections sync correctly through the same
   * column/overflow split as local writes.
   */
  applyRemoteWrite(
    op: "upsert" | "delete",
    id: string,
    doc: Record<string, any> | undefined,
    ts: number,
  ): void {
    this.ensureTable();
    // Reject remote ingest issued while an unrelated transactionAsync is in flight
    // — otherwise it nests into that tx and is lost if the tx rolls back. No-ops in
    // normal sync (asyncTxDepth === 0); the sync round retries on the next pull.
    this.mon.assertWriteAllowed();
    // Apply + index atomically, like local writes: a throwing plugin afterWrite
    // rolls the storage change back too (no committed-but-unindexed divergence).
    // Nests as a SAVEPOINT inside the sync round's transaction; stands alone if
    // applyRemoteWrite is ever called directly.
    this.db.transaction(() => {
      if (op === "delete") {
        this.db.prepare(`DELETE FROM "${this.name}" WHERE _id = ?`).run(id);
        this.afterWrite([id]);
        return;
      }
      const clean = stripSystem(doc ?? {});
      const createdAt =
        typeof (doc as any)?.created_at === "number"
          ? (doc as any).created_at
          : ts;

      if (this.mode === "document") {
        this.db
          .prepare(
            `INSERT INTO "${this.name}" (_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
          )
          .run(id, JSON.stringify(clean), createdAt, ts);
        this.afterWrite([id]);
        return;
      }

      const overflow: Record<string, any> = {};
      const colValues: Record<string, any> = {};
      for (const [k, v] of Object.entries(clean)) {
        if (this.columns.has(k)) colValues[k] = v;
        else overflow[k] = v;
      }
      const cols = [
        "_id",
        "created_at",
        "updated_at",
        "data",
        ...this.columnOrder,
      ];
      const values = [
        id,
        createdAt,
        ts,
        JSON.stringify(overflow),
        ...this.columnOrder.map((c) =>
          c in colValues ? this.encodeColumn(c, colValues[c]) : null,
        ),
      ];
      const colList = cols.map((c) => `"${c}"`).join(", ");
      const placeholders = cols.map(() => "?").join(", ");
      const updateSet = cols
        .filter((c) => c !== "_id" && c !== "created_at")
        .map((c) => `"${c}" = excluded."${c}"`)
        .join(", ");
      this.db
        .prepare(
          `INSERT INTO "${this.name}" (${colList}) VALUES (${placeholders}) ` +
            `ON CONFLICT(_id) DO UPDATE SET ${updateSet}`,
        )
        .run(...values);
      this.afterWrite([id]);
    });
  }

  /** @internal Notify reactivity watchers and plugins that documents changed. */
  private afterWrite(ids: string[]): void {
    if (ids.length === 0) return;
    this.mon.notifyReactor(this.name, ids);
    this.mon.firePluginAfterWrite(this.name, ids);
  }

  /* ----------------------------- create ----------------------------- */

  async create(args: CreateArgs<T>): Promise<WithId<T>> {
    if (this.mon.asyncDriver) return this.createPg(args);
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const row = this.buildInsert(args.data);
    const recorder = this.recorder;
    const write = () => {
      this.db.prepare(this.insertSql()).run(...row.values);
      recorder?.recordLocal(this.name, row._id, "upsert", row.created_at);
      // Index inside the same transaction so the row + plugin index commit
      // atomically: a failing afterWrite (e.g. a wrong-dimension vector) rolls
      // the row back too, instead of leaving it committed but unindexed.
      this.afterWrite([row._id]);
    };
    this.guard(() => this.db.transaction(write));
    return row.returned;
  }

  async createMany(args: CreateManyArgs<T>): Promise<{ count: number }> {
    if (this.mon.asyncDriver) return this.createManyPg(args);
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const stmt = this.db.prepare(this.insertSql());
    const recorder = this.recorder;
    const ids: string[] = [];
    this.guard(() =>
      this.db.transaction(() => {
        for (const item of args.data) {
          const row = this.buildInsert(item);
          stmt.run(...row.values);
          recorder?.recordLocal(this.name, row._id, "upsert", row.created_at);
          ids.push(row._id);
        }
        // Index inside the same transaction (see create) — a mid-batch indexing
        // failure rolls the whole batch back, never leaving rows unindexed.
        this.afterWrite(ids);
      }),
    );
    return { count: args.data.length };
  }

  /* ------------------------------ read ------------------------------ */

  private buildFindSql(args: FindManyArgs<T>): { sql: string; params: any[] } {
    const params: any[] = [];
    const where = buildWhere(args.where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });
    let sql = `SELECT * FROM "${this.name}" WHERE ${where}`;
    const order = buildOrderBy(args.orderBy, this.trackPath, this.columns);
    if (order) sql += " " + order;
    if (args.take != null) {
      sql += " LIMIT ?";
      params.push(args.take);
    }
    if (args.skip != null) {
      sql += (args.take != null ? "" : " LIMIT -1") + " OFFSET ?";
      params.push(args.skip);
    }
    return { sql, params };
  }

  /** @internal Synchronous core of findMany (used by reactivity). */
  findManyCore(args: FindManyArgs<T> = {}): WithId<T>[] {
    this.ensureTable();
    const { sql, params } = this.buildFindSql(args);
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => project(this.rowToDoc(r), args.select) as WithId<T>);
  }

  /** @internal Synchronous core of exists (used by reactivity). */
  existsCore(where: WhereInput<T> | undefined): boolean {
    this.ensureTable();
    const params: any[] = [];
    const clause = buildWhere(where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });
    return (
      this.db
        .prepare(`SELECT 1 FROM "${this.name}" WHERE ${clause} LIMIT 1`)
        .get(...params) != null
    );
  }

  async findMany<S extends Select<T> | undefined = undefined>(
    args: Omit<FindManyArgs<T>, "select"> & { select?: S } = {},
  ): Promise<Projected<T, S>[]> {
    const a = args as FindManyArgs<T>;
    if (this.mon.asyncDriver)
      return this.findManyPg(a) as unknown as Projected<T, S>[];
    // maxRows: cap unbounded reads. Probe one past the cap; throw if exceeded so
    // a missing `take` can't materialize an unbounded result set.
    const cap = this.mon.maxRows;
    const probe = cap && a.take == null ? { ...a, take: cap + 1 } : a;
    const checkCap = (n: number) => {
      if (cap && a.take == null && n > cap) {
        throw new MonliteQueryError(
          `findMany on "${this.name}" would return more than maxRows (${cap}) — add a take/limit or a tighter where`,
        );
      }
    };
    if (!a.lookup) {
      const rows = this.findManyCore(probe);
      checkCap(rows.length);
      return rows as unknown as Projected<T, S>[];
    }

    const specs = Array.isArray(a.lookup) ? a.lookup : [a.lookup];
    // Fetch full base docs (need localFields), join, then project.
    let rows: any[] = this.findManyCore({
      ...probe,
      select: undefined,
      lookup: undefined,
    });
    checkCap(rows.length);
    for (const spec of specs) rows = await this.applyLookup(rows, spec);

    if (a.select) {
      rows = rows.map((r) => {
        const projected = project(r, a.select) as Record<string, any>;
        for (const spec of specs) projected[spec.as] = r[spec.as];
        return projected;
      });
    }
    return rows as unknown as Projected<T, S>[];
  }

  /** Resolve one `$lookup` spec against already-fetched rows (2 queries, no N+1). */
  private async applyLookup(rows: any[], spec: LookupSpec): Promise<any[]> {
    const localValues = [
      ...new Set(
        rows
          .map((r) => r[spec.localField])
          .filter((v) => v !== undefined && v !== null),
      ),
    ];
    // findManyCore (not the public findMany) so a join isn't capped by maxRows —
    // the foreign fetch is already bounded by the `IN (localValues)` join keys.
    const foreign = localValues.length
      ? this.mon.collection(spec.from).findManyCore({
          where: { [spec.foreignField]: { in: localValues } } as WhereInput,
        })
      : [];

    const byKey = new Map<any, any[]>();
    for (const f of foreign) {
      const key = (f as Record<string, any>)[spec.foreignField];
      const list = byKey.get(key);
      if (list) list.push(f);
      else byKey.set(key, [f]);
    }

    if (spec.unwind) {
      const out: any[] = [];
      for (const r of rows) {
        const matches = byKey.get(r[spec.localField]) ?? [];
        if (matches.length === 0) {
          if (spec.unwind === "preserve") out.push({ ...r, [spec.as]: null });
        } else {
          for (const m of matches) out.push({ ...r, [spec.as]: m });
        }
      }
      return out;
    }
    return rows.map((r) => ({
      ...r,
      [spec.as]: byKey.get(r[spec.localField]) ?? [],
    }));
  }

  async findFirst<S extends Select<T> | undefined = undefined>(
    args: Omit<FindFirstArgs<T>, "select"> & { select?: S } = {},
  ): Promise<Projected<T, S> | null> {
    const rows = await this.findMany({ ...(args as object), take: 1 } as Omit<
      FindManyArgs<T>,
      "select"
    > & { select?: S });
    return (rows[0] ?? null) as Projected<T, S> | null;
  }

  /** Alias of {@link findFirst} for Prisma familiarity. */
  async findUnique<S extends Select<T> | undefined = undefined>(
    args: Omit<FindFirstArgs<T>, "select"> & { select?: S } = {},
  ): Promise<Projected<T, S> | null> {
    return this.findFirst(args);
  }

  /** Like {@link findFirst} but throws if no document matches. */
  async findFirstOrThrow<S extends Select<T> | undefined = undefined>(
    args: Omit<FindFirstArgs<T>, "select"> & { select?: S } = {},
  ): Promise<Projected<T, S>> {
    const doc = await this.findFirst(args);
    if (!doc) throw new MonliteError(`No document found in "${this.name}"`);
    return doc;
  }

  /** True if at least one document matches. */
  async exists(where?: WhereInput<T>): Promise<boolean> {
    if (this.mon.asyncDriver) return this.existsPg(where);
    return this.existsCore(where);
  }

  /**
   * Subscribe to a live query. The callback fires immediately with the current
   * results (`type: "init"`) and again whenever a change affects the result set
   * (row-level: only relevant changes trigger a recompute). Includes changes
   * applied by `@monlite/sync`.
   */
  watch(
    args: WatchArgs<T> = {},
    cb: (event: LiveEvent<T>) => void,
  ): WatchHandle<T> {
    if (this.mon.asyncDriver) return this.watchPg(args, cb);
    this.ensureTable();
    const lq = new LiveQuery<T>(this, args, cb);
    const reactor = this.mon.reactor;
    const name = this.name;
    const mon = this.mon;
    reactor.register(name, lq);
    mon.ensureReactorPolling(); // cross-process delivery when changefeed is on
    return {
      get results() {
        return lq.results;
      },
      stop() {
        lq.stopped = true;
        reactor.unregister(name, lq);
        mon.maybeStopReactorPolling(); // free the poll if no watchers remain
      },
    };
  }

  /**
   * Watch a single document by id (Firebase-style `onSnapshot(doc)`). The
   * callback fires immediately with the current document (or `null` if it does
   * not exist) and again on every change to it — including a delete (`null`).
   */
  watchDoc(
    id: string,
    cb: (doc: WithId<T> | null, event: LiveEvent<T>) => void,
  ): WatchHandle<T> {
    return this.watch(
      { where: { _id: id } as WhereInput<T>, take: 1 },
      (event) => cb(event.results[0] ?? null, event),
    );
  }

  /** Show SQLite's query plan for a `findMany`, and whether it uses an index. */
  async explain(args: FindManyArgs<T> = {}): Promise<ExplainResult> {
    if (this.mon.asyncDriver) return this.explainPg(args);
    this.ensureTable();
    const { sql, params } = this.buildFindSql(args);
    const plan = this.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params) as Array<{ id: number; parent: number; detail: string }>;
    const usesIndex = plan.some((r) =>
      /USING (COVERING )?INDEX/i.test(r.detail),
    );
    return { sql, usesIndex, plan };
  }

  async findById(id: string): Promise<WithId<T> | null> {
    // _id is stored as a string; coerce so findById(123) matches create({_id:123}).
    const key = typeof id === "number" ? String(id) : id;
    if (this.mon.asyncDriver)
      return this.findFirst({ where: { _id: key } as WhereInput<T> });
    this.ensureTable();
    const row = this.db
      .prepare(`SELECT * FROM "${this.name}" WHERE _id = ?`)
      .get(key) as Row | undefined;
    return row ? this.rowToDoc(row) : null;
  }

  async count(args: CountArgs<T> = {}): Promise<number> {
    if (this.mon.asyncDriver) return this.countPg(args);
    this.ensureTable();
    const params: any[] = [];
    const where = buildWhere(args.where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM "${this.name}" WHERE ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /** Postgres path for {@link count}: shares `buildWhere` (dialect: "postgres"). */
  private async countPg(args: CountArgs<T>): Promise<number> {
    await this.ensureTablePg();
    const params: any[] = [];
    const where = buildWhere(args.where, {
      params,
      columns: this.columns,
      dialect: "postgres",
    });
    const r = await this.mon.asyncDriver!.query(
      `SELECT COUNT(*)::int AS n FROM "${this.name}" WHERE ${where}`,
      params,
    );
    return r.rows[0].n;
  }

  /** Map a Postgres row to a document. Unlike SQLite, `data` (jsonb) is already parsed. */
  private rowToDocPg(row: any): WithId<T> {
    const doc = (row.data ?? {}) as Record<string, any>;
    doc._id = row._id;
    doc.created_at = Number(row.created_at);
    doc.updated_at = Number(row.updated_at);
    return doc as WithId<T>;
  }

  /** ORDER BY for Postgres: jsonb projection sorts numbers numerically (closer to SQLite). */
  private pgOrderBy(orderBy: FindManyArgs<T>["orderBy"]): string {
    if (!orderBy) return "";
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    const terms: string[] = [];
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec as Record<string, any>)) {
        const d = String(dir).toLowerCase() === "desc" ? "DESC" : "ASC";
        const sys =
          field === "_id" ||
          field === "created_at" ||
          field === "updated_at" ||
          this.columns.has(field);
        let col: string;
        if (sys) col = `"${field}"`;
        else {
          const segs = field.split(".").map((s) => s.replace(/'/g, "''"));
          col =
            segs.length === 1
              ? `data->'${segs[0]}'`
              : `data#>'{${segs.join(",")}}'`;
        }
        terms.push(`${col} ${d}`);
      }
    }
    return terms.length ? "ORDER BY " + terms.join(", ") : "";
  }

  /** Build the Postgres SELECT for {@link findMany} (shared with {@link explain}). */
  private buildFindSqlPg(a: FindManyArgs<T>): { sql: string; params: any[] } {
    if (a.lookup)
      throw new MonliteQueryError(
        "lookup / joins are not yet supported on the postgres engine",
      );
    const cap = this.mon.maxRows;
    const take = cap && a.take == null ? cap + 1 : a.take;
    const params: any[] = [];
    const where = buildWhere(a.where, {
      params,
      columns: this.columns,
      dialect: "postgres",
    });
    let sql = `SELECT _id, data, created_at, updated_at FROM "${this.name}" WHERE ${where}`;
    const order = this.pgOrderBy(a.orderBy);
    if (order) sql += " " + order;
    if (take != null) {
      sql += " LIMIT ?";
      params.push(take);
    }
    if (a.skip != null) {
      sql += " OFFSET ?";
      params.push(a.skip);
    }
    return { sql, params };
  }

  /** Postgres path for {@link findMany}: shares buildWhere; jsonb rows; no joins yet. */
  private async findManyPg(a: FindManyArgs<T>): Promise<WithId<T>[]> {
    await this.ensureTablePg();
    const cap = this.mon.maxRows;
    const { sql, params } = this.buildFindSqlPg(a);
    const r = await this.mon.asyncDriver!.query(sql, params);
    if (cap && a.take == null && r.rows.length > cap) {
      throw new MonliteQueryError(
        `findMany on "${this.name}" would return more than maxRows (${cap}) — add a take/limit or a tighter where`,
      );
    }
    return r.rows.map(
      (row: any) => project(this.rowToDocPg(row), a.select) as WithId<T>,
    );
  }

  /** Postgres path for {@link create}: reuses buildInsert + insertSql (a JSON string → jsonb). */
  private async createPg(args: CreateArgs<T>): Promise<WithId<T>> {
    this.mon.assertWriteAllowed();
    if (this.mode !== "document")
      return this.pgUnsupported("structured collections");
    await this.ensureTablePg();
    const row = this.buildInsert(args.data);
    await this.mon.asyncDriver!.query(this.insertSql(), row.values);
    return row.returned;
  }

  /** Flatten a Postgres EXPLAIN (FORMAT JSON) plan tree into {@link ExplainResult} rows. */
  private flattenPgPlan(
    node: any,
    counter: { n: number },
    parent: number,
    out: Array<{ id: number; parent: number; detail: string }>,
  ): void {
    const id = counter.n++;
    const idx = node["Index Name"] ? ` using ${node["Index Name"]}` : "";
    const rel = node["Relation Name"] ? ` on ${node["Relation Name"]}` : "";
    const cost =
      node["Total Cost"] != null ? ` (cost=${node["Total Cost"]})` : "";
    out.push({
      id,
      parent,
      detail: `${node["Node Type"] ?? "?"}${idx}${rel}${cost}`,
    });
    for (const child of node["Plans"] ?? [])
      this.flattenPgPlan(child, counter, id, out);
  }

  private async explainPg(args: FindManyArgs<T>): Promise<ExplainResult> {
    await this.ensureTablePg();
    const { sql, params } = this.buildFindSqlPg(args);
    const rows = (
      await this.mon.asyncDriver!.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)
    ).rows as Array<Record<string, any>>;
    let qp = rows[0]?.["QUERY PLAN"];
    if (typeof qp === "string") qp = JSON.parse(qp);
    const root = Array.isArray(qp) ? qp[0]?.Plan : qp?.Plan;
    const plan: Array<{ id: number; parent: number; detail: string }> = [];
    if (root) this.flattenPgPlan(root, { n: 0 }, 0, plan);
    const usesIndex = plan.some((r) =>
      /Index (Only )?Scan|Bitmap Index/i.test(r.detail),
    );
    return { sql, usesIndex, plan };
  }

  /** A feature not yet wired for the Postgres engine — fail loudly, never silently. */
  private pgUnsupported(op: string): never {
    throw new MonliteQueryError(
      `${op} is not yet supported on the postgres engine`,
    );
  }

  private async existsPg(where: WhereInput<T> | undefined): Promise<boolean> {
    await this.ensureTablePg();
    const params: any[] = [];
    const clause = buildWhere(where, {
      params,
      columns: this.columns,
      dialect: "postgres",
    });
    const r = await this.mon.asyncDriver!.query(
      `SELECT 1 FROM "${this.name}" WHERE ${clause} LIMIT 1`,
      params,
    );
    return r.rows.length > 0;
  }

  private async createManyPg(
    args: CreateManyArgs<T>,
  ): Promise<{ count: number }> {
    this.mon.assertWriteAllowed();
    if (this.mode !== "document") return this.pgUnsupported("structured collections");
    await this.ensureTablePg();
    await this.mon.asyncDriver!.transactionAsync(async () => {
      for (const item of args.data) {
        const row = this.buildInsert(item);
        await this.mon.asyncDriver!.query(this.insertSql(), row.values);
      }
    });
    return { count: args.data.length };
  }

  /** Postgres path for update/updateMany: find → applyUpdate (shared) → rewrite `data`. */
  private async runUpdatePg(
    where: WhereInput<T> | undefined,
    data: UpdateData<T>,
    single: boolean,
  ): Promise<WithId<T>[]> {
    this.mon.assertWriteAllowed();
    if (this.mode !== "document") return this.pgUnsupported("structured collections");
    await this.ensureTablePg();
    return this.mon.asyncDriver!.transactionAsync(async () => {
      const docs = await this.findManyPg({
        where,
        ...(single ? { take: 1 } : {}),
      } as FindManyArgs<T>);
      const out: WithId<T>[] = [];
      for (const doc of docs) {
        const now = Date.now();
        const id = (doc as any)._id;
        const updated = stripSystem(applyUpdate(stripSystem(doc), data));
        await this.mon.asyncDriver!.query(
          `UPDATE "${this.name}" SET data = ?, updated_at = ? WHERE _id = ?`,
          [JSON.stringify(updated), now, id],
        );
        out.push({
          ...updated,
          _id: id,
          created_at: (doc as any).created_at,
          updated_at: now,
        } as WithId<T>);
      }
      return out;
    });
  }

  /** Postgres path for delete/deleteMany. */
  private async runDeletePg(
    where: WhereInput<T> | undefined,
    single: boolean,
  ): Promise<WithId<T>[]> {
    this.mon.assertWriteAllowed();
    await this.ensureTablePg();
    return this.mon.asyncDriver!.transactionAsync(async () => {
      const docs = await this.findManyPg({
        where,
        ...(single ? { take: 1 } : {}),
      } as FindManyArgs<T>);
      if (!docs.length) return [];
      const ids = docs.map((d) => (d as any)._id);
      await this.mon.asyncDriver!.query(
        `DELETE FROM "${this.name}" WHERE _id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      return docs;
    });
  }

  /** Postgres path for {@link upsert} (Prisma/Mongo seed-from-where semantics). */
  private async upsertPg(args: UpsertArgs<T>): Promise<WithId<T>> {
    this.mon.assertWriteAllowed();
    if (this.mode !== "document") return this.pgUnsupported("structured collections");
    await this.ensureTablePg();
    return this.mon.asyncDriver!.transactionAsync(async () => {
      const existing = (
        await this.findManyPg({ where: args.where, take: 1 } as FindManyArgs<T>)
      )[0];
      if (existing) {
        const now = Date.now();
        const id = (existing as any)._id;
        const updated = stripSystem(applyUpdate(stripSystem(existing), args.update));
        await this.mon.asyncDriver!.query(
          `UPDATE "${this.name}" SET data = ?, updated_at = ? WHERE _id = ?`,
          [JSON.stringify(updated), now, id],
        );
        return {
          ...updated,
          _id: id,
          created_at: (existing as any).created_at,
          updated_at: now,
        } as WithId<T>;
      }
      const seed: Record<string, any> = {};
      for (const [k, v] of Object.entries(args.where ?? {})) {
        if (k === "AND" || k === "OR" || k === "NOT") continue;
        if (v === null || typeof v !== "object" || Array.isArray(v)) seed[k] = v;
        else if (
          Object.keys(v as object).length === 1 &&
          "equals" in (v as object)
        )
          seed[k] = (v as any).equals;
      }
      const row = this.buildInsert({ ...seed, ...args.create } as any);
      await this.mon.asyncDriver!.query(this.insertSql(), row.values);
      return row.returned;
    });
  }

  // ── Postgres aggregation ──────────────────────────────────────────────────
  private isSysOrColumn(field: string): boolean {
    return (
      field === "_id" ||
      field === "created_at" ||
      field === "updated_at" ||
      this.columns.has(field)
    );
  }

  /** Numeric projection of a field for SUM/AVG/MIN/MAX. */
  private pgAggField(field: string): string {
    if (this.isSysOrColumn(field)) return `("${field}")::numeric`;
    const segs = field.split(".").map((s) => s.replace(/'/g, "''"));
    const txt =
      segs.length === 1 ? `data->>'${segs[0]}'` : `data#>>'{${segs.join(",")}}'`;
    return `(${txt})::numeric`;
  }

  /** jsonb projection of a field for GROUP BY / DISTINCT (returns the parsed value). */
  private pgGroupField(field: string): string {
    if (this.isSysOrColumn(field)) return `"${field}"`;
    const segs = field.split(".").map((s) => s.replace(/'/g, "''"));
    return segs.length === 1 ? `data->'${segs[0]}'` : `data#>'{${segs.join(",")}}'`;
  }

  private static readonly PG_AGG_FN: Record<string, string> = {
    _sum: "SUM",
    _avg: "AVG",
    _min: "MIN",
    _max: "MAX",
  };

  private async aggregatePg(
    args: AggregateArgs<T>,
  ): Promise<AggregateResult> {
    await this.ensureTablePg();
    const params: any[] = [];
    const where = buildWhere(args.where, {
      params,
      columns: this.columns,
      dialect: "postgres",
    });
    const selects = ["COUNT(*) AS agg_count"];
    const cols: Array<{ alias: string; kind: string; field: string }> = [];
    let i = 0;
    for (const kind of ["_sum", "_avg", "_min", "_max"]) {
      const sel = (args as any)[kind];
      if (!sel) continue;
      for (const field of Object.keys(sel)) {
        if (!sel[field]) continue;
        const alias = `agg_${kind.slice(1)}_${i++}`;
        selects.push(`${Collection.PG_AGG_FN[kind]}(${this.pgAggField(field)}) AS ${alias}`);
        cols.push({ alias, kind, field });
      }
    }
    const r = await this.mon.asyncDriver!.query(
      `SELECT ${selects.join(", ")} FROM "${this.name}" WHERE ${where}`,
      params,
    );
    const row = (r.rows[0] ?? {}) as Record<string, any>;
    const result: AggregateResult = {};
    if (args._count) result._count = Number(row.agg_count ?? 0);
    for (const col of cols) {
      const v = row[col.alias];
      ((result as any)[col.kind] ??= {})[col.field] = v == null ? null : Number(v);
    }
    return result;
  }

  private async groupByPg(args: GroupByArgs<T>): Promise<GroupByResult[]> {
    if (!Array.isArray(args.by) || args.by.length === 0)
      throw new MonliteQueryError("groupBy requires a non-empty `by` array");
    await this.ensureTablePg();
    const params: any[] = [];
    const where = buildWhere(args.where, {
      params,
      columns: this.columns,
      dialect: "postgres",
    });
    const groupExprs: string[] = [];
    const groupCols: Array<{ alias: string; field: string }> = [];
    const selects: string[] = [];
    (args.by as string[]).forEach((field, gi) => {
      const expr = this.pgGroupField(field);
      groupExprs.push(expr);
      selects.push(`${expr} AS grp_${gi}`);
      groupCols.push({ alias: `grp_${gi}`, field });
    });
    selects.push("COUNT(*) AS agg_count");
    const cols: Array<{ alias: string; kind: string; field: string }> = [];
    let i = 0;
    for (const kind of ["_sum", "_avg", "_min", "_max"]) {
      const sel = (args as any)[kind];
      if (!sel) continue;
      for (const field of Object.keys(sel)) {
        if (!sel[field]) continue;
        const alias = `agg_${kind.slice(1)}_${i++}`;
        selects.push(`${Collection.PG_AGG_FN[kind]}(${this.pgAggField(field)}) AS ${alias}`);
        cols.push({ alias, kind, field });
      }
    }
    let sql = `SELECT ${selects.join(", ")} FROM "${this.name}" WHERE ${where} GROUP BY ${groupExprs.join(", ")}`;

    if (args.having) {
      const hp: string[] = [];
      const cmp = (expr: string, c: any): void => {
        for (const [k, op] of [
          ["equals", "="],
          ["not", "<>"],
          ["gt", ">"],
          ["gte", ">="],
          ["lt", "<"],
          ["lte", "<="],
        ] as const) {
          if (c[k] === undefined) continue;
          params.push(c[k]);
          hp.push(`${expr} ${op} ?`);
        }
      };
      const having = args.having as any;
      if (having._count) cmp("COUNT(*)", having._count);
      for (const kind of ["_sum", "_avg", "_min", "_max"]) {
        const sel = having[kind];
        if (!sel) continue;
        for (const field of Object.keys(sel))
          cmp(`${Collection.PG_AGG_FN[kind]}(${this.pgAggField(field)})`, sel[field]);
      }
      if (hp.length) sql += ` HAVING ${hp.join(" AND ")}`;
    }

    if (args.orderBy) {
      const parts: string[] = [];
      for (const key of Object.keys(args.orderBy)) {
        const val = (args.orderBy as any)[key];
        if (key === "_count") {
          parts.push(`agg_count ${String(val).toLowerCase() === "desc" ? "DESC" : "ASC"}`);
        } else if (
          ["_sum", "_avg", "_min", "_max"].includes(key) &&
          val &&
          typeof val === "object"
        ) {
          for (const field of Object.keys(val)) {
            const dir = String(val[field]).toLowerCase() === "desc" ? "DESC" : "ASC";
            parts.push(`${Collection.PG_AGG_FN[key]}(${this.pgAggField(field)}) ${dir}`);
          }
        } else {
          parts.push(`${this.pgGroupField(key)} ${String(val).toLowerCase() === "desc" ? "DESC" : "ASC"}`);
        }
      }
      if (parts.length) sql += ` ORDER BY ${parts.join(", ")}`;
    }
    if (args.take != null) {
      sql += " LIMIT ?";
      params.push(args.take);
    }
    if (args.skip != null) {
      sql += " OFFSET ?";
      params.push(args.skip);
    }

    const r = await this.mon.asyncDriver!.query(sql, params);
    return r.rows.map((row: any) => {
      const out: GroupByResult = {};
      for (const { alias, field } of groupCols) (out as any)[field] = row[alias];
      if (args._count) (out as any)._count = Number(row.agg_count);
      for (const col of cols) {
        const v = row[col.alias];
        ((out as any)[col.kind] ??= {})[col.field] = v == null ? null : Number(v);
      }
      return out;
    });
  }

  private async distinctPg(
    field: string,
    where?: WhereInput<T>,
  ): Promise<any[]> {
    await this.ensureTablePg();
    const params: any[] = [];
    const clause = buildWhere(where, {
      params,
      columns: this.columns,
      dialect: "postgres",
    });
    let sql: string;
    if (this.isSysOrColumn(field)) {
      sql = `SELECT DISTINCT "${field}" AS v FROM "${this.name}" WHERE ${clause} ORDER BY v`;
    } else {
      const segs = field.split(".").map((s) => s.replace(/'/g, "''"));
      const jsn =
        segs.length === 1 ? `data->'${segs[0]}'` : `data#>'{${segs.join(",")}}'`;
      // Distinct ELEMENTS for array fields, the value otherwise (matches SQLite json_each).
      sql =
        `SELECT DISTINCT CASE WHEN jsonb_typeof(${jsn})='array' THEN ae.elem ELSE ${jsn} END AS v ` +
        `FROM "${this.name}" LEFT JOIN LATERAL jsonb_array_elements(` +
        `CASE WHEN jsonb_typeof(${jsn})='array' THEN ${jsn} ELSE '[]'::jsonb END` +
        `) AS ae(elem) ON true WHERE ${clause} ORDER BY v`;
    }
    const r = await this.mon.asyncDriver!.query(sql, params);
    return r.rows.map((row: any) => row.v);
  }

  // ── Postgres watch (LISTEN/NOTIFY) ────────────────────────────────────────
  private watchPg(
    args: WatchArgs<T>,
    cb: (event: LiveEvent<T>) => void,
  ): WatchHandle<T> {
    if (!this.mon.asyncDriver!.listen)
      throw new MonliteError(
        "watch() requires a Postgres engine with LISTEN/NOTIFY support (driver.listen).",
      );
    const reactor = this.mon.ensurePgReactor();
    const lq = new PgLiveQuery<T>((a) => this.findManyPg(a), args, cb);
    const name = this.name;
    // LISTEN + the initial read are async; the handle returns synchronously and its
    // `results` fill in once init completes (when the "init" event fires).
    const ready = (async () => {
      await this.ensureTablePg();
      await this.ensurePgNotifyTrigger();
      await reactor.register(name, lq);
    })().catch((err) => {
      console.error("monlite: failed to start watch() on Postgres —", err);
    });
    return {
      get results() {
        return lq.results;
      },
      stop() {
        lq.stopped = true;
        void ready.then(() => reactor.unregister(name, lq));
      },
    };
  }

  /**
   * Install the per-table NOTIFY trigger (idempotent, once per collection): it fires
   * `pg_notify('monlite_<table>', <changed _id>)` after every INSERT/UPDATE/DELETE,
   * from ANY connection — so watch() observes cross-process writes.
   */
  private async ensurePgNotifyTrigger(): Promise<void> {
    if (this.pgNotifyReady) return;
    const drv = this.mon.asyncDriver!;
    await drv.exec(
      `CREATE OR REPLACE FUNCTION monlite_notify() RETURNS trigger AS $$ ` +
        `BEGIN PERFORM pg_notify('monlite_' || TG_TABLE_NAME, COALESCE(NEW._id, OLD._id)); ` +
        `RETURN NULL; END; $$ LANGUAGE plpgsql`,
    );
    await drv.exec(`DROP TRIGGER IF EXISTS monlite_notify_trg ON "${this.name}"`);
    await drv.exec(
      `CREATE TRIGGER monlite_notify_trg AFTER INSERT OR UPDATE OR DELETE ON "${this.name}" ` +
        `FOR EACH ROW EXECUTE FUNCTION monlite_notify()`,
    );
    this.pgNotifyReady = true;
  }

  // ── Postgres: findOneAndUpdate / bulkWrite / purgeExpired ──────────────────
  private async findOneAndUpdatePg(
    args: FindOneAndUpdateArgs<T>,
  ): Promise<WithId<T> | null> {
    this.mon.assertWriteAllowed();
    if (this.mode !== "document")
      return this.pgUnsupported("structured collections");
    await this.ensureTablePg();
    return this.mon.asyncDriver!.transactionAsync(async () => {
      const docs = await this.findManyPg({
        where: args.where,
        take: 1,
      } as FindManyArgs<T>);
      if (!docs.length) return null;
      const doc = docs[0];
      const id = (doc as any)._id;
      const now = Date.now();
      const updated = stripSystem(applyUpdate(stripSystem(doc), args.data));
      await this.mon.asyncDriver!.query(
        `UPDATE "${this.name}" SET data = ?, updated_at = ? WHERE _id = ?`,
        [JSON.stringify(updated), now, id],
      );
      const after = {
        ...updated,
        _id: id,
        created_at: (doc as any).created_at,
        updated_at: now,
      } as WithId<T>;
      return args.returnDocument === "before" ? (doc as WithId<T>) : after;
    });
  }

  private async bulkWritePg(
    operations: BulkWriteOp<T>[],
  ): Promise<BulkWriteResult> {
    this.mon.assertWriteAllowed();
    if (this.mode !== "document")
      return this.pgUnsupported("structured collections");
    await this.ensureTablePg();
    const result: BulkWriteResult = { inserted: 0, updated: 0, deleted: 0 };
    await this.mon.asyncDriver!.transactionAsync(async () => {
      for (const op of operations) {
        if ("insertOne" in op) {
          const ins = this.buildInsert(op.insertOne);
          await this.mon.asyncDriver!.query(this.insertSql(), ins.values);
          result.inserted++;
        } else if ("updateOne" in op || "updateMany" in op) {
          const single = "updateOne" in op;
          const spec = (single ? (op as any).updateOne : (op as any).updateMany) as {
            where: WhereInput<T>;
            data: UpdateData<T>;
          };
          const docs = await this.findManyPg({
            where: spec.where,
            ...(single ? { take: 1 } : {}),
          } as FindManyArgs<T>);
          for (const doc of docs) {
            const now = Date.now();
            const updated = stripSystem(applyUpdate(stripSystem(doc), spec.data));
            await this.mon.asyncDriver!.query(
              `UPDATE "${this.name}" SET data = ?, updated_at = ? WHERE _id = ?`,
              [JSON.stringify(updated), now, (doc as any)._id],
            );
            result.updated++;
          }
        } else if ("deleteOne" in op || "deleteMany" in op) {
          const single = "deleteOne" in op;
          const spec = (single ? (op as any).deleteOne : (op as any).deleteMany) as {
            where: WhereInput<T>;
          };
          const docs = await this.findManyPg({
            where: spec.where,
            select: { _id: true } as any,
            ...(single ? { take: 1 } : {}),
          } as FindManyArgs<T>);
          for (const doc of docs) {
            await this.mon.asyncDriver!.query(
              `DELETE FROM "${this.name}" WHERE _id = ?`,
              [(doc as any)._id],
            );
            result.deleted++;
          }
        }
      }
    });
    return result;
  }

  private async purgeExpiredPg(): Promise<{ count: number }> {
    if (!this.ttl)
      throw new MonliteError(
        "purgeExpired() requires the `ttl` collection option.",
      );
    this.mon.assertWriteAllowed();
    await this.ensureTablePg();
    const cutoff = Date.now() - this.ttl.seconds * 1000;
    // The ttl field is a numeric timestamp; missing → NULL → not purged (as SQLite).
    const r = await this.mon.asyncDriver!.query(
      `DELETE FROM "${this.name}" WHERE ${this.pgAggField(this.ttl.field)} < ?`,
      [cutoff],
    );
    return { count: r.changes };
  }

  /**
   * Return the distinct values of a field. Array fields stored in JSON are
   * unwound (each element counts as a value), matching MongoDB's `distinct`.
   */
  async distinct(field: string, where?: WhereInput<T>): Promise<any[]> {
    if (this.mon.asyncDriver) return this.distinctPg(field, where);
    this.ensureTable();
    const params: any[] = [];
    const clause = buildWhere(where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });

    let sql: string;
    if (isColumn(field, this.columns)) {
      sql =
        `SELECT DISTINCT ${fieldExpr(field, this.columns)} AS v FROM "${this.name}" ` +
        `WHERE ${clause} ORDER BY v`;
    } else {
      this.trackPath(field);
      sql =
        `SELECT DISTINCT je.value AS v FROM "${this.name}" ` +
        `CROSS JOIN json_each("${this.name}".data, ${pathLiteral(field)}) je ` +
        `WHERE ${clause} ORDER BY v`;
    }

    const decode = this.jsonColumns.has(field);
    return this.guard(() => {
      const rows = this.db.prepare(sql).all(...params) as Array<{ v: any }>;
      // Decode a JSON column's values to match findMany (which returns objects).
      return rows.map((r) =>
        decode && typeof r.v === "string" ? JSON.parse(r.v) : r.v,
      );
    });
  }

  /* ----------------------------- update ----------------------------- */

  private runUpdate(
    where: WhereInput<T> | undefined,
    data: UpdateData<T>,
    single: boolean,
  ): WithId<T>[] {
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const params: any[] = [];
    const clause = buildWhere(where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });
    let selectSql = `SELECT * FROM "${this.name}" WHERE ${clause}`;
    if (single) selectSql += " LIMIT 1";

    const rows = this.db.prepare(selectSql).all(...params) as Row[];
    if (!rows.length) return [];

    const now = Date.now();
    const recorder = this.recorder;

    const out = this.guard(() =>
      this.db.transaction(() => {
        const result: WithId<T>[] = [];
        for (const row of rows) {
          const current = stripSystem(this.rowToDoc(row));
          const updated = stripSystem(applyUpdate(current, data));
          const { setSql, values } = this.buildUpdateSet(updated, now);
          this.db
            .prepare(`UPDATE "${this.name}" SET ${setSql} WHERE _id = ?`)
            .run(...values, row._id);
          recorder?.recordLocal(this.name, row._id, "upsert", now);
          result.push({
            ...updated,
            _id: row._id,
            created_at: row.created_at,
            updated_at: now,
          } as WithId<T>);
        }
        // Index inside the transaction so a failing afterWrite rolls the update
        // back too (atomic with plugin indexing, as create/createMany).
        this.afterWrite(result.map((d) => d._id));
        return result;
      }),
    );
    return out;
  }

  async update(args: UpdateArgs<T>): Promise<WithId<T> | null> {
    if (this.mon.asyncDriver)
      return (await this.runUpdatePg(args.where, args.data, true))[0] ?? null;
    return this.runUpdate(args.where, args.data, true)[0] ?? null;
  }

  async updateMany(args: UpdateArgs<T>): Promise<{ count: number }> {
    if (this.mon.asyncDriver)
      return { count: (await this.runUpdatePg(args.where, args.data, false)).length };
    return { count: this.runUpdate(args.where, args.data, false).length };
  }

  async upsert(args: UpsertArgs<T>): Promise<WithId<T>> {
    if (this.mon.asyncDriver) return this.upsertPg(args);
    this.ensureTable();
    this.mon.assertWriteAllowed();
    // Find + create/update run inside ONE transaction so concurrent/interleaved
    // upserts can't both miss and double-insert.
    const result = this.guard(() =>
      this.db.transaction(() => {
        const params: any[] = [];
        const clause = buildWhere(args.where, {
          params,
          onPath: this.trackPath,
          columns: this.columns,
        });
        const row = this.db
          .prepare(`SELECT * FROM "${this.name}" WHERE ${clause} LIMIT 1`)
          .get(...params) as Row | undefined;

        const now = Date.now();
        const recorder = this.recorder;

        let res: WithId<T>;
        if (row) {
          const current = stripSystem(this.rowToDoc(row));
          const updated = stripSystem(applyUpdate(current, args.update));
          const { setSql, values } = this.buildUpdateSet(updated, now);
          this.db
            .prepare(`UPDATE "${this.name}" SET ${setSql} WHERE _id = ?`)
            .run(...values, row._id);
          recorder?.recordLocal(this.name, row._id, "upsert", now);
          res = {
            ...updated,
            _id: row._id,
            created_at: row.created_at,
            updated_at: now,
          } as WithId<T>;
        } else {
          // Seed the new document with the where's equality fields (Prisma/Mongo
          // upsert semantics) so a repeated upsert stays idempotent instead of
          // inserting a duplicate; explicit `create` fields win on conflict.
          const seed: Record<string, any> = {};
          for (const [k, v] of Object.entries(args.where ?? {})) {
            if (k === "AND" || k === "OR" || k === "NOT") continue;
            if (v === null || typeof v !== "object" || Array.isArray(v))
              seed[k] = v;
            else if (
              Object.keys(v as object).length === 1 &&
              "equals" in (v as object)
            )
              seed[k] = (v as any).equals;
          }
          const ins = this.buildInsert({ ...seed, ...args.create } as any);
          this.db.prepare(this.insertSql()).run(...ins.values);
          recorder?.recordLocal(this.name, ins._id, "upsert", ins.created_at);
          res = ins.returned;
        }
        // Index inside the transaction (atomic with the write, as create).
        this.afterWrite([res._id]);
        return res;
      }),
    );
    return result;
  }

  /**
   * Atomically find the first matching document, update it, and return it
   * (`returnDocument: "before" | "after"`, default `"after"`). The read and
   * write happen in one transaction.
   */
  async findOneAndUpdate(
    args: FindOneAndUpdateArgs<T>,
  ): Promise<WithId<T> | null> {
    if (this.mon.asyncDriver) return this.findOneAndUpdatePg(args);
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const params: any[] = [];
    const clause = buildWhere(args.where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });
    // The read-modify-write runs under BEGIN IMMEDIATE (the write lock is taken
    // up front) when the driver supports it, so a version/status guard in `where`
    // is a true compare-and-swap even ACROSS processes: a racing writer blocks on
    // the lock, then re-reads the already-bumped row, finds its guard no longer
    // matches, and cleanly returns null (lost CAS) — instead of racing on a stale
    // WAL snapshot. Single-connection callers serialize anyway, so this is free.
    const work = (): { id: string; doc: WithId<T> } | null => {
      const row = this.db
        .prepare(`SELECT * FROM "${this.name}" WHERE ${clause} LIMIT 1`)
        .get(...params) as Row | undefined;
      if (!row) return null;
      const before = this.rowToDoc(row) as WithId<T>;
      const now = Date.now();
      const updated = stripSystem(applyUpdate(stripSystem(before), args.data));
      const { setSql, values } = this.buildUpdateSet(updated, now);
      this.db
        .prepare(`UPDATE "${this.name}" SET ${setSql} WHERE _id = ?`)
        .run(...values, row._id);
      this.recorder?.recordLocal(this.name, row._id, "upsert", now);
      const after = {
        ...updated,
        _id: row._id,
        created_at: row.created_at,
        updated_at: now,
      } as WithId<T>;
      // Index inside the (sync or async) transaction so a failing afterWrite rolls
      // the CAS back too. Plugin index writes are raw driver writes, so they don't
      // re-enter assertWriteAllowed under transactionAsync.
      this.afterWrite([row._id]);
      return {
        id: row._id,
        doc: args.returnDocument === "before" ? before : after,
      };
    };

    let result: { id: string; doc: WithId<T> } | null;
    try {
      // Route through Monlite.transactionAsync (serialized + re-entrant) rather
      // than the driver directly, so concurrent CAS calls don't interleave on the
      // shared connection and corrupt each other's savepoints.
      result = this.db.transactionAsync
        ? await this.mon.transactionAsync(async () => work())
        : this.db.transaction(work);
    } catch (err) {
      throw normalizeDriverError(err, this.name);
    }
    if (!result) return null;
    return result.doc;
  }

  /**
   * Run a mixed batch of `insertOne` / `updateOne` / `updateMany` / `deleteOne` /
   * `deleteMany` operations in **one transaction** (all-or-nothing).
   */
  async bulkWrite(operations: BulkWriteOp<T>[]): Promise<BulkWriteResult> {
    if (this.mon.asyncDriver) return this.bulkWritePg(operations);
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const ids: string[] = [];
    const result: BulkWriteResult = { inserted: 0, updated: 0, deleted: 0 };

    this.guard(() =>
      this.db.transaction(() => {
        const recorder = this.recorder;
        for (const op of operations) {
          if ("insertOne" in op) {
            const ins = this.buildInsert(op.insertOne);
            this.db.prepare(this.insertSql()).run(...ins.values);
            recorder?.recordLocal(this.name, ins._id, "upsert", ins.created_at);
            ids.push(ins._id);
            result.inserted++;
          } else if ("updateOne" in op || "updateMany" in op) {
            const single = "updateOne" in op;
            const spec = single
              ? (
                  op as {
                    updateOne: { where: WhereInput<T>; data: UpdateData<T> };
                  }
                ).updateOne
              : (
                  op as {
                    updateMany: { where: WhereInput<T>; data: UpdateData<T> };
                  }
                ).updateMany;
            const p: any[] = [];
            const clause = buildWhere(spec.where, {
              params: p,
              onPath: this.trackPath,
              columns: this.columns,
            });
            let sel = `SELECT * FROM "${this.name}" WHERE ${clause}`;
            if (single) sel += " LIMIT 1";
            const rows = this.db.prepare(sel).all(...p) as Row[];
            const now = Date.now();
            for (const row of rows) {
              const updated = stripSystem(
                applyUpdate(stripSystem(this.rowToDoc(row)), spec.data),
              );
              const { setSql, values } = this.buildUpdateSet(updated, now);
              this.db
                .prepare(`UPDATE "${this.name}" SET ${setSql} WHERE _id = ?`)
                .run(...values, row._id);
              recorder?.recordLocal(this.name, row._id, "upsert", now);
              ids.push(row._id);
              result.updated++;
            }
          } else if ("deleteOne" in op || "deleteMany" in op) {
            const single = "deleteOne" in op;
            const spec = single
              ? (op as { deleteOne: { where: WhereInput<T> } }).deleteOne
              : (op as { deleteMany: { where: WhereInput<T> } }).deleteMany;
            const p: any[] = [];
            const clause = buildWhere(spec.where, {
              params: p,
              onPath: this.trackPath,
              columns: this.columns,
            });
            let sel = `SELECT _id FROM "${this.name}" WHERE ${clause}`;
            if (single) sel += " LIMIT 1";
            const rows = this.db.prepare(sel).all(...p) as Array<{
              _id: string;
            }>;
            const now = Date.now();
            const del = this.db.prepare(
              `DELETE FROM "${this.name}" WHERE _id = ?`,
            );
            for (const row of rows) {
              del.run(row._id);
              recorder?.recordLocal(this.name, row._id, "delete", now);
              ids.push(row._id);
              result.deleted++;
            }
          }
        }
        // Index inside the transaction so a failing afterWrite rolls the whole
        // batch back (atomic with plugin indexing).
        this.afterWrite(ids);
      }),
    );

    return result;
  }

  /**
   * Delete documents past their TTL (requires the `ttl` collection option).
   * Call periodically (e.g. from a cron tick). Returns the number removed.
   */
  async purgeExpired(): Promise<{ count: number }> {
    if (this.mon.asyncDriver) return this.purgeExpiredPg();
    if (!this.ttl) {
      throw new MonliteError(
        "purgeExpired() requires the `ttl` collection option.",
      );
    }
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const cutoff = Date.now() - this.ttl.seconds * 1000;
    const expr = this.fieldSqlExpr(this.ttl.field);
    const rows = this.db
      .prepare(`SELECT _id FROM "${this.name}" WHERE ${expr} < ?`)
      .all(cutoff) as Array<{ _id: string }>;
    if (!rows.length) return { count: 0 };

    const recorder = this.recorder;
    const now = Date.now();
    this.guard(() =>
      this.db.transaction(() => {
        const del = this.db.prepare(`DELETE FROM "${this.name}" WHERE _id = ?`);
        for (const { _id } of rows) {
          del.run(_id);
          recorder?.recordLocal(this.name, _id, "delete", now);
        }
        // Index inside the transaction (atomic with the delete, as create).
        this.afterWrite(rows.map((r) => r._id));
      }),
    );
    return { count: rows.length };
  }

  /* ----------------------------- delete ----------------------------- */

  private runDelete(
    where: WhereInput<T> | undefined,
    single: boolean,
  ): WithId<T>[] {
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const params: any[] = [];
    const clause = buildWhere(where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });
    let selectSql = `SELECT * FROM "${this.name}" WHERE ${clause}`;
    if (single) selectSql += " LIMIT 1";

    const rows = this.db.prepare(selectSql).all(...params) as Row[];
    if (!rows.length) return [];

    const stmt = this.db.prepare(`DELETE FROM "${this.name}" WHERE _id = ?`);
    const recorder = this.recorder;
    const now = Date.now();
    this.guard(() =>
      this.db.transaction(() => {
        for (const row of rows) {
          stmt.run(row._id);
          recorder?.recordLocal(this.name, row._id, "delete", now);
        }
        // Index inside the transaction (atomic with the delete, as create).
        this.afterWrite(rows.map((r) => r._id));
      }),
    );
    return rows.map((r) => this.rowToDoc(r));
  }

  async delete(args: DeleteArgs<T>): Promise<WithId<T> | null> {
    if (this.mon.asyncDriver)
      return (await this.runDeletePg(args.where, true))[0] ?? null;
    return this.runDelete(args.where, true)[0] ?? null;
  }

  async deleteMany(
    args: DeleteArgs<T> = { where: undefined as any },
  ): Promise<{ count: number }> {
    if (this.mon.asyncDriver)
      return { count: (await this.runDeletePg(args.where, false)).length };
    return { count: this.runDelete(args.where, false).length };
  }

  /* --------------------------- aggregation -------------------------- */

  async aggregate(args: AggregateArgs<T> = {}): Promise<AggregateResult> {
    if (this.mon.asyncDriver) return this.aggregatePg(args);
    this.ensureTable();
    return this.guard(() =>
      aggregate(
        {
          db: this.db,
          table: this.name,
          onPath: this.trackPath,
          columns: this.columns,
          jsonColumns: this.jsonColumns,
        },
        args,
      ),
    );
  }

  async groupBy(args: GroupByArgs<T>): Promise<GroupByResult[]> {
    if (this.mon.asyncDriver) return this.groupByPg(args);
    this.ensureTable();
    return this.guard(() =>
      groupBy(
        {
          db: this.db,
          table: this.name,
          onPath: this.trackPath,
          columns: this.columns,
          jsonColumns: this.jsonColumns,
        },
        args,
      ),
    );
  }
}
