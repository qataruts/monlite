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
  WatchHandle,
  WhereInput,
  WithId,
} from "./types.js";
import { objectId } from "./id.js";
import { LiveQuery } from "./reactive.js";
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

  private ensureTable(): void {
    if (this.initialized) return;

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
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "uqx_${this.name}_${i}" ON "${this.name}"(${exprs})`,
      );
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
  }

  /** @internal Notify reactivity watchers and plugins that documents changed. */
  private afterWrite(ids: string[]): void {
    if (ids.length === 0) return;
    this.mon.reactor.emit(this.name, ids);
    this.mon.firePluginAfterWrite(this.name, ids);
  }

  /* ----------------------------- create ----------------------------- */

  async create(args: CreateArgs<T>): Promise<WithId<T>> {
    this.ensureTable();
    this.mon.assertWriteAllowed();
    const row = this.buildInsert(args.data);
    const recorder = this.recorder;
    const write = () => {
      this.db.prepare(this.insertSql()).run(...row.values);
      recorder?.recordLocal(this.name, row._id, "upsert", row.created_at);
    };
    this.guard(() => (recorder ? this.db.transaction(write) : write()));
    this.afterWrite([row._id]);
    return row.returned;
  }

  async createMany(args: CreateManyArgs<T>): Promise<{ count: number }> {
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
      }),
    );
    this.afterWrite(ids);
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
    return this.existsCore(where);
  }

  /**
   * Subscribe to a live query. The callback fires immediately with the current
   * results (`type: "init"`) and again whenever a change affects the result set
   * (row-level: only relevant changes trigger a recompute). Includes changes
   * applied by `@monlite/sync`.
   */
  watch(
    args: FindManyArgs<T> = {},
    cb: (event: LiveEvent<T>) => void,
  ): WatchHandle<T> {
    this.ensureTable();
    const lq = new LiveQuery<T>(this, args, cb);
    const reactor = this.mon.reactor;
    const name = this.name;
    reactor.register(name, lq);
    return {
      get results() {
        return lq.results;
      },
      stop() {
        lq.stopped = true;
        reactor.unregister(name, lq);
      },
    };
  }

  /** Show SQLite's query plan for a `findMany`, and whether it uses an index. */
  async explain(args: FindManyArgs<T> = {}): Promise<ExplainResult> {
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
    this.ensureTable();
    const row = this.db
      .prepare(`SELECT * FROM "${this.name}" WHERE _id = ?`)
      .get(id) as Row | undefined;
    return row ? this.rowToDoc(row) : null;
  }

  async count(args: CountArgs<T> = {}): Promise<number> {
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

  /**
   * Return the distinct values of a field. Array fields stored in JSON are
   * unwound (each element counts as a value), matching MongoDB's `distinct`.
   */
  async distinct(field: string, where?: WhereInput<T>): Promise<any[]> {
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

    return this.guard(() => {
      const rows = this.db.prepare(sql).all(...params) as Array<{ v: any }>;
      return rows.map((r) => r.v);
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
        return result;
      }),
    );
    this.afterWrite(out.map((d) => d._id));
    return out;
  }

  async update(args: UpdateArgs<T>): Promise<WithId<T> | null> {
    return this.runUpdate(args.where, args.data, true)[0] ?? null;
  }

  async updateMany(args: UpdateArgs<T>): Promise<{ count: number }> {
    return { count: this.runUpdate(args.where, args.data, false).length };
  }

  async upsert(args: UpsertArgs<T>): Promise<WithId<T>> {
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

        if (row) {
          const current = stripSystem(this.rowToDoc(row));
          const updated = stripSystem(applyUpdate(current, args.update));
          const { setSql, values } = this.buildUpdateSet(updated, now);
          this.db
            .prepare(`UPDATE "${this.name}" SET ${setSql} WHERE _id = ?`)
            .run(...values, row._id);
          recorder?.recordLocal(this.name, row._id, "upsert", now);
          return {
            ...updated,
            _id: row._id,
            created_at: row.created_at,
            updated_at: now,
          } as WithId<T>;
        }

        const ins = this.buildInsert(args.create);
        this.db.prepare(this.insertSql()).run(...ins.values);
        recorder?.recordLocal(this.name, ins._id, "upsert", ins.created_at);
        return ins.returned;
      }),
    );
    this.afterWrite([result._id]);
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
      return {
        id: row._id,
        doc: args.returnDocument === "before" ? before : after,
      };
    };

    let result: { id: string; doc: WithId<T> } | null;
    try {
      result = this.db.transactionAsync
        ? await this.db.transactionAsync(async () => work())
        : this.db.transaction(work);
    } catch (err) {
      throw normalizeDriverError(err, this.name);
    }
    if (!result) return null;
    this.afterWrite([result.id]);
    return result.doc;
  }

  /**
   * Run a mixed batch of `insertOne` / `updateOne` / `updateMany` / `deleteOne` /
   * `deleteMany` operations in **one transaction** (all-or-nothing).
   */
  async bulkWrite(operations: BulkWriteOp<T>[]): Promise<BulkWriteResult> {
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
      }),
    );

    this.afterWrite(ids);
    return result;
  }

  /**
   * Delete documents past their TTL (requires the `ttl` collection option).
   * Call periodically (e.g. from a cron tick). Returns the number removed.
   */
  async purgeExpired(): Promise<{ count: number }> {
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
      }),
    );
    this.afterWrite(rows.map((r) => r._id));
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
      }),
    );

    this.afterWrite(rows.map((r) => r._id));
    return rows.map((r) => this.rowToDoc(r));
  }

  async delete(args: DeleteArgs<T>): Promise<WithId<T> | null> {
    return this.runDelete(args.where, true)[0] ?? null;
  }

  async deleteMany(
    args: DeleteArgs<T> = { where: undefined as any },
  ): Promise<{ count: number }> {
    return { count: this.runDelete(args.where, false).length };
  }

  /* --------------------------- aggregation -------------------------- */

  async aggregate(args: AggregateArgs<T> = {}): Promise<AggregateResult> {
    this.ensureTable();
    return this.guard(() =>
      aggregate(
        {
          db: this.db,
          table: this.name,
          onPath: this.trackPath,
          columns: this.columns,
        },
        args,
      ),
    );
  }

  async groupBy(args: GroupByArgs<T>): Promise<GroupByResult[]> {
    this.ensureTable();
    return this.guard(() =>
      groupBy(
        {
          db: this.db,
          table: this.name,
          onPath: this.trackPath,
          columns: this.columns,
        },
        args,
      ),
    );
  }
}
