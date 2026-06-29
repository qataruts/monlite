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
      await client.query(`DROP TABLE IF EXISTS sales CASCADE`);
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

    it("aggregation on Postgres: aggregate / groupBy (+having, orderBy) / distinct", async () => {
      const s = db.collection("sales");
      await s.createMany({
        data: [
          { _id: "1", region: "us", amt: 10, tags: ["a", "b"] },
          { _id: "2", region: "us", amt: 30, tags: ["b"] },
          { _id: "3", region: "eu", amt: 20, tags: ["a", "c"] },
        ],
      });
      const agg = await s.aggregate({
        _count: true,
        _sum: { amt: true },
        _avg: { amt: true },
        _min: { amt: true },
        _max: { amt: true },
      } as any);
      expect(agg._count).toBe(3);
      expect(agg._sum?.amt).toBe(60);
      expect(agg._avg?.amt).toBe(20);
      expect(agg._min?.amt).toBe(10);
      expect(agg._max?.amt).toBe(30);

      const g = await s.groupBy({
        by: ["region"],
        _count: true,
        _sum: { amt: true },
        orderBy: { _sum: { amt: "desc" } },
      } as any);
      const byRegion: any = Object.fromEntries(g.map((r: any) => [r.region, r]));
      expect(byRegion.us._count).toBe(2);
      expect(byRegion.us._sum.amt).toBe(40);
      expect(byRegion.eu._sum.amt).toBe(20);
      expect((g[0] as any).region).toBe("us"); // ordered by _sum desc

      const gh = await s.groupBy({
        by: ["region"],
        _sum: { amt: true },
        having: { _sum: { amt: { gt: 30 } } },
      } as any);
      expect(gh.map((r: any) => r.region)).toEqual(["us"]);

      expect((await s.distinct("region")).sort()).toEqual(["eu", "us"]);
      expect((await s.distinct("tags")).sort()).toEqual(["a", "b", "c"]); // array elements
    });

    it("findOneAndUpdate + bulkWrite on Postgres", async () => {
      await db.asyncDriver.exec(`DROP TABLE IF EXISTS crud2 CASCADE`);
      const c = db.collection("crud2");
      await c.createMany({ data: [{ _id: "a", n: 1 }, { _id: "b", n: 2 }] });

      // findOneAndUpdate: returns "after" by default, "before" on request
      expect((await c.findOneAndUpdate({ where: { _id: "a" }, data: { $inc: { n: 10 } } }))?.n).toBe(11);
      const before = await c.findOneAndUpdate({
        where: { _id: "a" },
        data: { $set: { n: 0 } },
        returnDocument: "before",
      } as any);
      expect(before?.n).toBe(11);
      expect((await c.findById("a"))?.n).toBe(0);

      // bulkWrite: mixed ops, all in one transaction (insert is visible to the later update)
      const res = await c.bulkWrite([
        { insertOne: { _id: "c", n: 3 } },
        { updateMany: { where: { n: { gte: 0 } }, data: { $set: { tag: "x" } } } },
        { deleteOne: { where: { _id: "b" } } },
      ] as any);
      expect(res.inserted).toBe(1);
      expect(res.updated).toBe(3); // a, b, c (c inserted earlier in the same txn)
      expect(res.deleted).toBe(1);
      expect(await c.count()).toBe(2); // a, c remain
      expect((await c.findById("c"))?.tag).toBe("x");
    });

    it("purgeExpired on Postgres (ttl)", async () => {
      await db.asyncDriver.exec(`DROP TABLE IF EXISTS ses CASCADE`);
      const ses = db.collection("ses", { ttl: { field: "createdAt", seconds: 1 } });
      await ses.createMany({
        data: [
          { _id: "old", createdAt: Date.now() - 10_000 }, // 10s ago → expired
          { _id: "fresh", createdAt: Date.now() },
        ],
      });
      expect((await ses.purgeExpired()).count).toBe(1);
      expect(await ses.findById("old")).toBeNull();
      expect(await ses.findById("fresh")).not.toBeNull();
    });

    it("only explain() remains unsupported on Postgres", async () => {
      await expect(db.collection("crud").explain({})).rejects.toThrow(/postgres engine/);
    });
  },
);
