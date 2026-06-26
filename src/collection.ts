import type { Monlite } from "./db.js";
import type {
  AggregateArgs,
  AggregateResult,
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
import { buildWhere } from "./query/where.js";
import { buildOrderBy } from "./query/order.js";
import { project } from "./query/select.js";
import { applyUpdate } from "./query/update.js";
import { aggregate, groupBy } from "./aggregation/aggregate.js";

interface Row {
  _id: string;
  data: string;
  created_at: number;
  updated_at: number;
}

const SELECT_COLS = `_id, data, created_at, updated_at`;

function stripSystem(obj: Record<string, any>): Record<string, any> {
  const { _id, created_at, updated_at, ...rest } = obj;
  return rest;
}

/**
 * A document collection. Backed by a single SQLite table whose rows store the
 * document as JSON in a `data` column. Created lazily on first write/read.
 */
export class Collection<T = Doc> {
  private initialized = false;
  private readonly trackPath = (path: string) =>
    this.mon.autoIndexer.track(this.name, path);

  constructor(
    private readonly mon: Monlite,
    readonly name: string,
  ) {}

  private get db() {
    return this.mon.driver;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS "${this.name}" (
        _id        TEXT    PRIMARY KEY,
        data       TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.initialized = true;
  }

  private rowToDoc(row: Row): WithId<T> {
    const doc = JSON.parse(row.data) as Record<string, any>;
    doc._id = row._id;
    doc.created_at = row.created_at;
    doc.updated_at = row.updated_at;
    return doc as WithId<T>;
  }

  private prepareInsert(input: Record<string, any>): Row {
    const now = Date.now();
    const id = input._id != null ? String(input._id) : objectId();
    const doc = stripSystem(input);
    return {
      _id: id,
      data: JSON.stringify(doc),
      created_at: now,
      updated_at: now,
    };
  }

  /* ----------------------------- create ----------------------------- */

  async create(args: CreateArgs<T>): Promise<WithId<T>> {
    this.ensureTable();
    const row = this.prepareInsert(args.data);
    this.db
      .prepare(
        `INSERT INTO "${this.name}" (_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(row._id, row.data, row.created_at, row.updated_at);
    return this.rowToDoc(row);
  }

  async createMany(args: CreateManyArgs<T>): Promise<{ count: number }> {
    this.ensureTable();
    const stmt = this.db.prepare(
      `INSERT INTO "${this.name}" (_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const item of args.data) {
        const row = this.prepareInsert(item);
        stmt.run(row._id, row.data, row.created_at, row.updated_at);
      }
    });
    return { count: args.data.length };
  }

  /* ------------------------------ read ------------------------------ */

  async findMany(args: FindManyArgs<T> = {}): Promise<WithId<T>[]> {
    this.ensureTable();
    const params: any[] = [];
    const where = buildWhere(args.where, { params, onPath: this.trackPath });
    let sql = `SELECT ${SELECT_COLS} FROM "${this.name}" WHERE ${where}`;

    const order = buildOrderBy(args.orderBy, this.trackPath);
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
    return rows.map(
      (r) => project(this.rowToDoc(r), args.select) as WithId<T>,
    );
  }

  async findFirst(args: FindFirstArgs<T> = {}): Promise<WithId<T> | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<WithId<T> | null> {
    this.ensureTable();
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM "${this.name}" WHERE _id = ?`)
      .get(id) as Row | undefined;
    return row ? this.rowToDoc(row) : null;
  }

  async count(args: CountArgs<T> = {}): Promise<number> {
    this.ensureTable();
    const params: any[] = [];
    const where = buildWhere(args.where, { params, onPath: this.trackPath });
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM "${this.name}" WHERE ${where}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /* ----------------------------- update ----------------------------- */

  private runUpdate(
    where: WhereInput<T> | undefined,
    data: UpdateData<T>,
    single: boolean,
  ): WithId<T>[] {
    this.ensureTable();
    const params: any[] = [];
    const clause = buildWhere(where, { params, onPath: this.trackPath });
    let selectSql = `SELECT ${SELECT_COLS} FROM "${this.name}" WHERE ${clause}`;
    if (single) selectSql += " LIMIT 1";

    const rows = this.db.prepare(selectSql).all(...params) as Row[];
    if (!rows.length) return [];

    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE "${this.name}" SET data = ?, updated_at = ? WHERE _id = ?`,
    );

    return this.db.transaction(() => {
      const out: WithId<T>[] = [];
      for (const row of rows) {
        const current = JSON.parse(row.data) as Record<string, any>;
        const updated = stripSystem(applyUpdate(current, data));
        stmt.run(JSON.stringify(updated), now, row._id);
        out.push({
          ...updated,
          _id: row._id,
          created_at: row.created_at,
          updated_at: now,
        } as WithId<T>);
      }
      return out;
    });
  }

  async update(args: UpdateArgs<T>): Promise<WithId<T> | null> {
    return this.runUpdate(args.where, args.data, true)[0] ?? null;
  }

  async updateMany(args: UpdateArgs<T>): Promise<{ count: number }> {
    return { count: this.runUpdate(args.where, args.data, false).length };
  }

  async upsert(args: UpsertArgs<T>): Promise<WithId<T>> {
    this.ensureTable();
    const existing = await this.findFirst({ where: args.where });
    if (existing) {
      const updated = await this.update({
        where: { _id: existing._id } as WhereInput<T>,
        data: args.update,
      });
      return updated as WithId<T>;
    }
    return this.create({ data: args.create });
  }

  /* ----------------------------- delete ----------------------------- */

  private runDelete(
    where: WhereInput<T> | undefined,
    single: boolean,
  ): WithId<T>[] {
    this.ensureTable();
    const params: any[] = [];
    const clause = buildWhere(where, { params, onPath: this.trackPath });
    let selectSql = `SELECT ${SELECT_COLS} FROM "${this.name}" WHERE ${clause}`;
    if (single) selectSql += " LIMIT 1";

    const rows = this.db.prepare(selectSql).all(...params) as Row[];
    if (!rows.length) return [];

    const stmt = this.db.prepare(`DELETE FROM "${this.name}" WHERE _id = ?`);
    this.db.transaction(() => {
      for (const row of rows) stmt.run(row._id);
    });

    return rows.map((r) => this.rowToDoc(r));
  }

  async delete(args: DeleteArgs<T>): Promise<WithId<T> | null> {
    return this.runDelete(args.where, true)[0] ?? null;
  }

  async deleteMany(args: DeleteArgs<T> = { where: undefined as any }): Promise<{
    count: number;
  }> {
    return { count: this.runDelete(args.where, false).length };
  }

  /* --------------------------- aggregation -------------------------- */

  async aggregate(args: AggregateArgs<T> = {}): Promise<AggregateResult> {
    this.ensureTable();
    return aggregate(
      { db: this.db, table: this.name, onPath: this.trackPath },
      args,
    );
  }

  async groupBy(args: GroupByArgs<T>): Promise<GroupByResult[]> {
    this.ensureTable();
    return groupBy(
      { db: this.db, table: this.name, onPath: this.trackPath },
      args,
    );
  }
}
