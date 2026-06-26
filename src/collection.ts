import type { Monlite } from "./db.js";
import type {
  AggregateArgs,
  AggregateResult,
  CollectionMode,
  CollectionOptions,
  ColumnDef,
  ColumnType,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  Doc,
  FindFirstArgs,
  FindManyArgs,
  GroupByArgs,
  GroupByResult,
  UpdateArgs,
  UpdateData,
  UpsertArgs,
  WhereInput,
  WithId,
} from "./types.js";
import { objectId } from "./id.js";
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
  isColumn,
  pathLiteral,
  quoteIdent,
  RESERVED_FIELDS,
} from "./query/sql.js";
import { aggregate, groupBy } from "./aggregation/aggregate.js";

type Row = Record<string, any>;

function stripSystem(obj: Record<string, any>): Record<string, any> {
  const { _id, created_at, updated_at, ...rest } = obj;
  return rest;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  private insertSqlCache?: string;

  private readonly trackPath = (path: string) =>
    this.mon.autoIndexer.track(this.name, path);

  constructor(
    private readonly mon: Monlite,
    readonly name: string,
    options: CollectionOptions = {},
  ) {
    this.mode = options.schema ? "structured" : "document";
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
      ];
      for (const field of this.columnOrder) {
        const def = this.columnDefs[field]!;
        let line = `"${field}" ${sqliteType(def.type)}`;
        if (def.notNull) line += " NOT NULL";
        if (def.unique) line += " UNIQUE";
        if (def.default !== undefined) line += ` DEFAULT ${formatDefault(def.default)}`;
        if (def.references) line += ` REFERENCES ${def.references}`;
        lines.push(line);
      }
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS "${this.name}" (\n  ${lines.join(",\n  ")}\n)`,
      );
      for (const field of this.columnOrder) {
        if (this.columnDefs[field]!.index) {
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS "idx_${this.name}_${field}" ON "${this.name}"("${field}")`,
          );
        }
      }
    }
    this.initialized = true;
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
      !Buffer.isBuffer(value)
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
    const returned = { ...doc, _id: id, created_at: now, updated_at: now } as WithId<T>;

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

  /** Sync store, but only for document collections (structured sync is future work). */
  private get recorder() {
    return this.mode === "document" ? this.mon.$sync : undefined;
  }

  /* ----------------------------- create ----------------------------- */

  async create(args: CreateArgs<T>): Promise<WithId<T>> {
    this.ensureTable();
    const row = this.buildInsert(args.data);
    const recorder = this.recorder;
    const write = () => {
      this.db.prepare(this.insertSql()).run(...row.values);
      recorder?.recordLocal(this.name, row._id, "upsert", row.created_at);
    };
    this.guard(() => (recorder ? this.db.transaction(write) : write()));
    return row.returned;
  }

  async createMany(args: CreateManyArgs<T>): Promise<{ count: number }> {
    this.ensureTable();
    const stmt = this.db.prepare(this.insertSql());
    const recorder = this.recorder;
    this.guard(() =>
      this.db.transaction(() => {
        for (const item of args.data) {
          const row = this.buildInsert(item);
          stmt.run(...row.values);
          recorder?.recordLocal(this.name, row._id, "upsert", row.created_at);
        }
      }),
    );
    return { count: args.data.length };
  }

  /* ------------------------------ read ------------------------------ */

  async findMany(args: FindManyArgs<T> = {}): Promise<WithId<T>[]> {
    this.ensureTable();
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

    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((r) => project(this.rowToDoc(r), args.select) as WithId<T>);
  }

  async findFirst(args: FindFirstArgs<T> = {}): Promise<WithId<T> | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  /** Alias of {@link findFirst} for Prisma familiarity. */
  async findUnique(args: FindFirstArgs<T> = {}): Promise<WithId<T> | null> {
    return this.findFirst(args);
  }

  /** Like {@link findFirst} but throws if no document matches. */
  async findFirstOrThrow(args: FindFirstArgs<T> = {}): Promise<WithId<T>> {
    const doc = await this.findFirst(args);
    if (!doc) throw new MonliteError(`No document found in "${this.name}"`);
    return doc;
  }

  /** True if at least one document matches. */
  async exists(where?: WhereInput<T>): Promise<boolean> {
    this.ensureTable();
    const params: any[] = [];
    const clause = buildWhere(where, {
      params,
      onPath: this.trackPath,
      columns: this.columns,
    });
    const row = this.db
      .prepare(`SELECT 1 FROM "${this.name}" WHERE ${clause} LIMIT 1`)
      .get(...params);
    return row != null;
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

    return this.guard(() =>
      this.db.transaction(() => {
        const out: WithId<T>[] = [];
        for (const row of rows) {
          const current = stripSystem(this.rowToDoc(row));
          const updated = stripSystem(applyUpdate(current, data));
          const { setSql, values } = this.buildUpdateSet(updated, now);
          this.db
            .prepare(`UPDATE "${this.name}" SET ${setSql} WHERE _id = ?`)
            .run(...values, row._id);
          recorder?.recordLocal(this.name, row._id, "upsert", now);
          out.push({
            ...updated,
            _id: row._id,
            created_at: row.created_at,
            updated_at: now,
          } as WithId<T>);
        }
        return out;
      }),
    );
  }

  async update(args: UpdateArgs<T>): Promise<WithId<T> | null> {
    return this.runUpdate(args.where, args.data, true)[0] ?? null;
  }

  async updateMany(args: UpdateArgs<T>): Promise<{ count: number }> {
    return { count: this.runUpdate(args.where, args.data, false).length };
  }

  async upsert(args: UpsertArgs<T>): Promise<WithId<T>> {
    this.ensureTable();
    // Find + create/update run inside ONE transaction so concurrent/interleaved
    // upserts can't both miss and double-insert.
    return this.guard(() =>
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
  }

  /* ----------------------------- delete ----------------------------- */

  private runDelete(
    where: WhereInput<T> | undefined,
    single: boolean,
  ): WithId<T>[] {
    this.ensureTable();
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
        { db: this.db, table: this.name, onPath: this.trackPath, columns: this.columns },
        args,
      ),
    );
  }

  async groupBy(args: GroupByArgs<T>): Promise<GroupByResult[]> {
    this.ensureTable();
    return this.guard(() =>
      groupBy(
        { db: this.db, table: this.name, onPath: this.trackPath, columns: this.columns },
        args,
      ),
    );
  }
}
