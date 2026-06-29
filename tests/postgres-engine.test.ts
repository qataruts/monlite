// Proves a REAL @monlite/core Collection method runs on a live Postgres engine —
// the whole stack: createDb engine-selection → db.asyncDriver → ensureTablePg →
// count's PG branch → the shared buildWhere(dialect:"postgres"). The inline PgDriver
// is the AsyncDriver shape the production @monlite/postgres package will provide.
// Skips cleanly without a reachable Postgres (like the Python interop tests).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../src/index";

class PgDriver {
  readonly name = "postgres";
  readonly async = true as const;
  constructor(private client: any) {}
  // The builder emits "?" placeholders; Postgres wants $1,$2,…
  private conv(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }
  async exec(sql: string): Promise<void> {
    await this.client.query(this.conv(sql));
  }
  async query(sql: string, params: any[] = []) {
    const r = await this.client.query(this.conv(sql), params);
    return { rows: r.rows, changes: r.rowCount ?? 0 };
  }
  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    await this.client.query("BEGIN");
    try {
      const r = await fn();
      await this.client.query("COMMIT");
      return r;
    } catch (e) {
      await this.client.query("ROLLBACK");
      throw e;
    }
  }
  afterCommit(cb: () => void): void {
    cb();
  }
  async close(): Promise<void> {
    await this.client.end();
  }
}

const URL =
  process.env.MONLITE_PG_URL ||
  "postgres://postgres:monlite@127.0.0.1:55432/monlite";

let pgMod: any;
let available = false;
try {
  pgMod = (await import("pg")).default;
  const probe = new pgMod.Client({
    connectionString: URL,
    connectionTimeoutMillis: 1500,
  });
  await probe.connect();
  await probe.end();
  available = true;
} catch {
  available = false;
}

(available ? describe : describe.skip)(
  "@monlite/core Collection on a live Postgres engine",
  () => {
    let db: any;
    let client: any;

    beforeAll(async () => {
      client = new pgMod.Client({ connectionString: URL });
      await client.connect();
      await client.query(`DROP TABLE IF EXISTS users CASCADE`);
      await client.query(`DROP TABLE IF EXISTS posts CASCADE`);
      await client.query(`DROP TABLE IF EXISTS crud CASCADE`);
      await client.query(
        `CREATE TABLE "users" (_id text PRIMARY KEY, data jsonb NOT NULL, created_at bigint NOT NULL, updated_at bigint NOT NULL)`,
      );
      for (const [_id, data] of [
        ["1", { name: "Ada", age: 30, role: "admin" }],
        ["2", { name: "Bo", age: 17, role: "user" }],
        ["3", { name: "Cy", age: 40, role: "user" }],
      ] as const) {
        await client.query(
          `INSERT INTO "users"(_id, data, created_at, updated_at) VALUES ($1, $2, 1, 1)`,
          [_id, JSON.stringify(data)],
        );
      }
      // Engine selection: a Monlite backed by the async Postgres engine.
      db = createDb(":memory:", { driver: new PgDriver(client) as any });
    });
    afterAll(async () => {
      if (db) await db.$disconnect();
    });

    it("exposes the engine as db.asyncDriver", () => {
      expect(db.asyncDriver?.name).toBe("postgres");
    });

    it("count() runs through the real Collection on Postgres", async () => {
      const users = db.collection("users");
      expect(await users.count()).toBe(3);
      expect(await users.count({ where: { role: "admin" } })).toBe(1);
      expect(await users.count({ where: { age: { gte: 18 } } })).toBe(2);
      expect(
        await users.count({ where: { OR: [{ role: "admin" }, { age: { gte: 40 } }] } }),
      ).toBe(2);
      expect(await users.count({ where: { name: { startsWith: "A" } } })).toBe(1);
    });

    it("create() + findMany() + findFirst() run through the real Collection on Postgres", async () => {
      const posts = db.collection("posts");
      // createPg: writes a real row via the API (table auto-created on Postgres)
      await posts.create({ data: { _id: "p1", title: "SQLite", views: 10, tags: ["db"] } });
      await posts.create({ data: { _id: "p2", title: "Postgres", views: 30, tags: ["db", "sql"] } });
      await posts.create({ data: { _id: "p3", title: "Redis", views: 20 } });
      expect(await posts.count()).toBe(3);

      // findMany: where + orderBy (numeric, via jsonb) + row→doc mapping
      const top = await posts.findMany({ where: { views: { gte: 20 } }, orderBy: { views: "desc" } });
      expect(top.map((d: any) => d._id)).toEqual(["p2", "p3"]);
      expect(top[0].title).toBe("Postgres");
      expect(typeof top[0].created_at).toBe("number");

      // array op + take + skip
      expect((await posts.findMany({ where: { tags: { has: "sql" } } })).map((d: any) => d._id)).toEqual(["p2"]);
      expect((await posts.findMany({ orderBy: { views: "asc" }, take: 2 })).map((d: any) => d._id)).toEqual(["p1", "p3"]);
      expect((await posts.findMany({ orderBy: { views: "asc" }, skip: 1 })).map((d: any) => d._id)).toEqual(["p3", "p2"]);

      // findFirst (delegates to findMany) + select projection
      expect((await posts.findFirst({ where: { title: "Redis" } }))?._id).toBe("p3");
      // project() keeps only the selected keys (no implicit _id) — same as SQLite
      const projected = await posts.findMany({ where: { _id: "p1" }, select: { title: true } });
      expect(projected[0]).toEqual({ title: "SQLite" });
    });

    it("full CRUD on Postgres: createMany/findById/exists/update/updateMany/upsert/delete/deleteMany", async () => {
      const c = db.collection("crud");
      await c.createMany({
        data: [
          { _id: "a", n: 1, kind: "x" },
          { _id: "b", n: 2, kind: "x" },
          { _id: "c", n: 3, kind: "y" },
        ],
      });
      expect(await c.count()).toBe(3);

      expect((await c.findById("b"))?.n).toBe(2);
      expect(await c.findById("zzz")).toBeNull();
      expect(await c.exists({ kind: "y" })).toBe(true);
      expect(await c.exists({ kind: "z" })).toBe(false);

      // update: $inc + $set (applyUpdate shared with SQLite)
      const up = await c.update({ where: { _id: "a" }, data: { $inc: { n: 10 }, $set: { kind: "z" } } });
      expect(up?.n).toBe(11);
      expect(up?.kind).toBe("z");
      expect((await c.findById("a"))?.n).toBe(11);

      // updateMany (only "b" is still kind:x — "a" became "z")
      expect((await c.updateMany({ where: { kind: "x" }, data: { $set: { tagged: true } } })).count).toBe(1);
      expect((await c.findById("b"))?.tagged).toBe(true);

      // upsert: update existing + insert new (seeded from where)
      expect((await c.upsert({ where: { _id: "c" }, create: { n: 99 }, update: { $set: { n: 33 } } })).n).toBe(33);
      const u2 = await c.upsert({ where: { _id: "d" }, create: { n: 4, kind: "new" }, update: { $set: { n: 0 } } });
      expect(u2._id).toBe("d");
      expect(u2.n).toBe(4);
      expect(await c.count()).toBe(4);

      // delete + deleteMany
      expect((await c.delete({ where: { _id: "a" } }))?._id).toBe("a");
      expect(await c.count()).toBe(3);
      expect((await c.deleteMany({ where: { kind: { in: ["x", "new"] } } })).count).toBe(2);
      expect(await c.count()).toBe(1); // only "c" (kind:y) remains
    });

    it("not-yet-supported methods throw a clear error on Postgres (never silent)", async () => {
      const c = db.collection("crud");
      await expect(c.aggregate({ _count: true } as any)).rejects.toThrow(/not yet supported on the postgres engine/);
      await expect(c.groupBy({ by: ["kind"] } as any)).rejects.toThrow(/postgres engine/);
      await expect(c.distinct("kind")).rejects.toThrow(/postgres engine/);
      expect(() => c.watch({}, () => {})).toThrow(/postgres engine/);
    });
  },
);
