// Cross-engine PARITY suite — the proof of "swap the engine, not your code". Every scenario
// runs the SAME operations on a SQLite database and a Postgres database and asserts the results
// are identical. Run against the real monlite/postgres image (or any reachable Postgres).
//
//   MONLITE_PG_URL=postgres://postgres:monlite@127.0.0.1:55432/monlite \
//     pnpm --filter @monlite/postgres exec vitest run tests/parity.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createDb as createSqlite } from "@monlite/core";
import { createDb as createPg, postgres } from "../src/index";

const URL =
  process.env.MONLITE_PG_URL ||
  "postgres://postgres:monlite@127.0.0.1:55432/monlite";

let pgAvailable = false;
try {
  const d = postgres(URL);
  await d.query("SELECT 1");
  await d.close();
  pgAvailable = true;
} catch {
  pgAvailable = false;
}

// A dataset deliberately full of edge cases: present-null, missing keys, empty arrays,
// nested paths, booleans, numbers, strings.
const SEED = [
  { _id: "1", name: "Ada", age: 30, role: "admin", tags: ["x", "y"], score: 10, meta: { city: "NYC" }, active: true },
  { _id: "2", name: "Bo", age: 17, role: "user", tags: ["y", "z"], score: 5, meta: { city: "LA" }, active: false },
  { _id: "3", name: "Cy", age: 40, role: "user", tags: [], score: null, meta: { city: "NYC" }, active: true },
  { _id: "4", name: "Di", age: 25, role: "admin", tags: ["x"], meta: {}, active: false }, // score MISSING
  { _id: "5", name: "Eve", age: null, role: "user", tags: ["z"], score: 20, active: true }, // meta MISSING
];

const describePg = pgAvailable ? describe : describe.skip;

describePg("cross-engine parity (SQLite vs Postgres)", () => {
  let sq: any;
  let pg: any;

  beforeAll(() => {
    sq = createSqlite(":memory:");
    pg = createPg(URL);
  });
  afterAll(async () => {
    await sq.$disconnect();
    await pg.$disconnect();
  });
  beforeEach(async () => {
    // Reset via deleteMany (NOT DROP TABLE — a drop would desync the cached ensureTablePg).
    for (const db of [sq, pg]) {
      const c = db.collection("p");
      await c.deleteMany({});
      await c.createMany({ data: SEED.map((d) => ({ ...d })) });
    }
  });

  /** Run `fn` on both engines and assert it returns identical results. */
  async function parity(fn: (c: any, db: any) => Promise<any>) {
    const a = await fn(sq.collection("p"), sq);
    const b = await fn(pg.collection("p"), pg);
    expect(b).toEqual(a);
    return a;
  }
  const ids = (r: any[]) => r.map((d) => d._id).sort();

  // ── reads ──────────────────────────────────────────────────────────────────
  it("count / exists / findById / findFirst", async () => {
    await parity((c) => c.count());
    await parity((c) => c.count({ where: { role: "user" } }));
    await parity((c) => c.exists({ role: "admin" }));
    await parity(async (c) => (await c.findById("3"))?.name ?? null);
    await parity(async (c) => (await c.findFirst({ where: { role: "user" }, orderBy: { _id: "asc" } }))?._id);
  });

  // ── comparison operators ─────────────────────────────────────────────────────
  it("equals / not / gt / gte / lt / lte / in / notIn", async () => {
    await parity(async (c) => ids(await c.findMany({ where: { role: "admin" } })));
    await parity(async (c) => ids(await c.findMany({ where: { role: { not: "admin" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { age: { gt: 25 } } })));
    await parity(async (c) => ids(await c.findMany({ where: { age: { gte: 25, lt: 40 } } })));
    await parity(async (c) => ids(await c.findMany({ where: { age: { lte: 17 } } })));
    await parity(async (c) => ids(await c.findMany({ where: { role: { in: ["admin", "x"] } } })));
    await parity(async (c) => ids(await c.findMany({ where: { role: { notIn: ["admin"] } } })));
  });

  // ── null / missing-field semantics (the divergence-prone area) ───────────────
  it("null & missing handling: equals null / not null / in[null] / exists", async () => {
    await parity(async (c) => ids(await c.findMany({ where: { score: null } }))); // present-null + missing
    await parity(async (c) => ids(await c.findMany({ where: { score: { not: null } } })));
    await parity(async (c) => ids(await c.findMany({ where: { score: { in: [null, 20] } } })));
    await parity(async (c) => ids(await c.findMany({ where: { score: { exists: true } } })));
    await parity(async (c) => ids(await c.findMany({ where: { score: { exists: false } } })));
    await parity(async (c) => ids(await c.findMany({ where: { age: null } })));
  });

  // ── string operators ─────────────────────────────────────────────────────────
  it("contains / startsWith / endsWith / regex (sensitive + insensitive)", async () => {
    await parity(async (c) => ids(await c.findMany({ where: { name: { contains: "d" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { name: { contains: "D", mode: "insensitive" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { name: { startsWith: "C" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { name: { endsWith: "o" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { name: { regex: "^[AB]" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { name: { regex: "e$", mode: "insensitive" } } })));
  });

  // ── arrays ───────────────────────────────────────────────────────────────────
  it("has / contains-on-array / elemMatch", async () => {
    await parity(async (c) => ids(await c.findMany({ where: { tags: { has: "x" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { tags: { contains: "z" } } }))); // element membership
    await parity(async (c) => ids(await c.findMany({ where: { tags: { has: "nope" } } })));
  });

  it("elemMatch over arrays of objects (equals / gt / in / not)", async () => {
    const seed = [
      { _id: "a", items: [{ sku: "A", qty: 2 }, { sku: "B", qty: 9 }] },
      { _id: "b", items: [{ sku: "C", qty: 1 }] },
    ];
    const run = async (c: any) => {
      await c.deleteMany({});
      await c.createMany({ data: seed.map((d) => ({ ...d })) });
      return {
        eq: ids(await c.findMany({ where: { items: { elemMatch: { sku: "A" } } } })),
        gt: ids(await c.findMany({ where: { items: { elemMatch: { qty: { gt: 5 } } } } })),
        inn: ids(await c.findMany({ where: { items: { elemMatch: { sku: { in: ["C", "Z"] } } } } })),
        not: ids(await c.findMany({ where: { items: { elemMatch: { qty: { not: 1 } } } } })),
      };
    };
    expect(await run(pg.collection("p"))).toEqual(await run(sq.collection("p")));
  });

  // ── logical + nested ─────────────────────────────────────────────────────────
  it("AND / OR / NOT / empty OR / nested dot-path", async () => {
    await parity(async (c) => ids(await c.findMany({ where: { AND: [{ role: "user" }, { active: true }] } })));
    await parity(async (c) => ids(await c.findMany({ where: { OR: [{ role: "admin" }, { age: { gte: 40 } }] } })));
    await parity(async (c) => ids(await c.findMany({ where: { NOT: { role: "user" } } })));
    await parity(async (c) => ids(await c.findMany({ where: { OR: [] } }))); // empty OR → nothing
    await parity(async (c) => ids(await c.findMany({ where: { "meta.city": "NYC" } })));
    await parity(async (c) => ids(await c.findMany({ where: { active: true } })));
  });

  // ── ordering / pagination / projection ───────────────────────────────────────
  it("orderBy (asc/desc, NULL placement, multi-key), take, skip, select", async () => {
    await parity(async (c) => (await c.findMany({ orderBy: { age: "asc" } })).map((d: any) => d._id)); // NULLs first
    await parity(async (c) => (await c.findMany({ orderBy: { score: "desc" } })).map((d: any) => d._id)); // NULLs last
    await parity(async (c) => (await c.findMany({ orderBy: [{ role: "asc" }, { age: "desc" }] })).map((d: any) => d._id));
    await parity(async (c) => (await c.findMany({ orderBy: { _id: "asc" }, take: 2 })).map((d: any) => d._id));
    await parity(async (c) => (await c.findMany({ orderBy: { _id: "asc" }, skip: 2, take: 2 })).map((d: any) => d._id));
    await parity(async (c) => await c.findMany({ where: { _id: "1" }, select: { name: true, age: true } }));
  });

  // ── distinct ─────────────────────────────────────────────────────────────────
  it("distinct (scalar / array elements / missing-field excluded)", async () => {
    await parity(async (c) => (await c.distinct("role")).sort());
    await parity(async (c) => (await c.distinct("tags")).sort()); // array elements
    await parity(async (c) => (await c.distinct("score")).map((v: any) => v).sort()); // excludes missing
  });

  // ── aggregation ──────────────────────────────────────────────────────────────
  it("aggregate (count/sum/avg/min/max)", async () => {
    await parity((c) =>
      c.aggregate({ _count: true, _sum: { score: true }, _avg: { age: true }, _min: { age: true }, _max: { score: true } }),
    );
  });

  it("groupBy (+ having + orderBy by accumulator)", async () => {
    await parity(async (c) => {
      const g = await c.groupBy({ by: ["role"], _count: true, _sum: { score: true }, orderBy: { _sum: { score: "desc" } } });
      return g.map((r: any) => [r.role, r._count, r._sum.score]);
    });
    await parity(async (c) => {
      const g = await c.groupBy({ by: ["role"], _count: true, having: { _count: { gt: 1 } } });
      return g.map((r: any) => r.role).sort();
    });
  });

  // ── update operators ─────────────────────────────────────────────────────────
  it("update operators ($set/$inc/$unset/$push/$addToSet/$pull) yield identical state", async () => {
    const run = async (c: any) => {
      await c.update({ where: { _id: "1" }, data: { $set: { role: "super" }, $inc: { age: 1 } } });
      await c.update({ where: { _id: "2" }, data: { $unset: { score: true }, $push: { tags: "w" } } });
      await c.update({ where: { _id: "3" }, data: { $addToSet: { tags: "x" } } });
      await c.update({ where: { _id: "1" }, data: { $pull: { tags: "y" } } });
      await c.updateMany({ where: { role: "user" }, data: { $set: { touched: true } } });
      const all = await c.findMany({ orderBy: { _id: "asc" } });
      return all.map(({ created_at, updated_at, ...d }: any) => d);
    };
    expect(await run(pg.collection("p"))).toEqual(await run(sq.collection("p")));
  });

  it("upsert / findOneAndUpdate / bulkWrite", async () => {
    const run = async (c: any) => {
      const up1 = await c.upsert({ where: { _id: "1" }, create: { x: 1 }, update: { $set: { up: 1 } } });
      const up2 = await c.upsert({ where: { _id: "new" }, create: { name: "New", n: 9 }, update: { $set: { n: 0 } } });
      const cas = await c.findOneAndUpdate({ where: { role: "admin" }, data: { $set: { claimed: true } }, returnDocument: "after" });
      const bulk = await c.bulkWrite([
        { insertOne: { _id: "b1", v: 1 } },
        { updateMany: { where: { role: "user" }, data: { $set: { bulk: true } } } },
        { deleteOne: { where: { _id: "2" } } },
      ]);
      const total = await c.count();
      return { up1up: up1.up, up2: { id: up2._id, n: up2.n }, casRole: cas?.role, bulk, total };
    };
    expect(await run(pg.collection("p"))).toEqual(await run(sq.collection("p")));
  });

  it("delete / deleteMany", async () => {
    const run = async (c: any) => {
      const d1 = (await c.delete({ where: { _id: "1" } }))?._id;
      const dm = (await c.deleteMany({ where: { role: "user" } })).count;
      return { d1, dm, left: (await c.findMany()).length };
    };
    expect(await run(pg.collection("p"))).toEqual(await run(sq.collection("p")));
  });

  // ── transactions ─────────────────────────────────────────────────────────────
  it("transactionAsync commit + rollback leave identical state", async () => {
    const run = async (_c: any, db: any) => {
      await db.transactionAsync(async (tx: any) => {
        await tx.collection("p").update({ where: { _id: "1" }, data: { $inc: { age: 100 } } });
        await tx.collection("p").update({ where: { _id: "2" }, data: { $inc: { age: 100 } } });
      });
      await db
        .transactionAsync(async (tx: any) => {
          await tx.collection("p").update({ where: { _id: "3" }, data: { $inc: { age: 100 } } });
          throw new Error("rollback");
        })
        .catch(() => {});
      const ages = (await db.collection("p").findMany({ orderBy: { _id: "asc" } })).map((d: any) => [d._id, d.age]);
      return ages;
    };
    expect(await run(null, pg)).toEqual(await run(null, sq));
  });
});

// Plugin parity — search ranking algorithms differ by engine (BM25 vs ts_rank; sqlite-vec vs
// pgvector), so we compare WHAT matches / nearest order, not absolute scores.
describePg("cross-engine parity — plugins", () => {
  const sortIds = (r: any[]) => r.map((h) => h._id).sort();

  it("fts: the same documents match a query on both engines", async () => {
    const { fts } = await import("@monlite/fts");
    const docs = [
      { _id: "1", title: "Postgres tsvector", body: "full text search indexing" },
      { _id: "2", title: "SQLite FTS5", body: "bm25 search ranking" },
      { _id: "3", title: "Hello world", body: "nothing relevant here" },
    ];
    const sqf = createSqlite(":memory:", { plugins: [fts({ d: ["title", "body"] })] });
    const pgf = createPg(URL, { plugins: [fts({ d: ["title", "body"] })] });
    await pgf.asyncDriver.exec(`DROP TABLE IF EXISTS d CASCADE`);
    try {
      for (const db of [sqf, pgf]) await db.collection("d").createMany({ data: docs.map((x) => ({ ...x })) });
      const a = sortIds(await sqf.collection("d").search("search"));
      const b = sortIds(await pgf.collection("d").search("search"));
      expect(b).toEqual(a); // 1 and 2 match, 3 doesn't — on both engines
      expect(b).toEqual(["1", "2"]);
    } finally {
      await sqf.$disconnect();
      await pgf.$disconnect();
    }
  });

  it("vector: the same nearest-neighbour ORDER on both engines", async () => {
    const { vector } = await import("@monlite/vector");
    const docs = [
      { _id: "a", embedding: [1, 0, 0] },
      { _id: "b", embedding: [0, 1, 0] },
      { _id: "c", embedding: [0.9, 0.1, 0] },
      { _id: "d", embedding: [0.2, 0.2, 0.9] },
    ];
    const spec = { d: { field: "embedding", dimensions: 3, distance: "l2" as const } };
    const sqv = createSqlite(":memory:", { allowExtensions: true, plugins: [vector(spec)] });
    const pgv = createPg(URL, { plugins: [vector(spec)] });
    await pgv.asyncDriver.exec(`DROP TABLE IF EXISTS d CASCADE`);
    try {
      for (const db of [sqv, pgv]) await db.collection("d").createMany({ data: docs.map((x) => ({ ...x })) });
      const a = (await sqv.collection("d").findSimilar({ vector: [1, 0, 0], topK: 3 })).map((h: any) => h._id);
      const b = (await pgv.collection("d").findSimilar({ vector: [1, 0, 0], topK: 3 })).map((h: any) => h._id);
      expect(b).toEqual(a); // identical nearest-first ranking across engines
      expect(b).toEqual(["a", "c", "d"]); // a(0) < c(~0.14) < d(~1.22) < b(~1.41) by L2
    } finally {
      await sqv.$disconnect();
      await pgv.$disconnect();
    }
  });

  it("kv: get / set / incr / ttl / sorted-sets agree across engines", async () => {
    const { kv, pgKv } = await import("@monlite/kv");
    const sk = createSqlite(":memory:");
    const pk = createPg(URL);
    for (const t of ["_kv", "_monlite_kv_zset", "_monlite_kv_pubsub"])
      await pk.asyncDriver.exec(`DROP TABLE IF EXISTS ${t} CASCADE`);
    const a = kv(sk, { namespace: "n" });
    const b = pgKv(pk, { namespace: "n" });
    try {
      // strings + counters
      a.set("k", { x: 1 });
      await b.set("k", { x: 1 });
      expect(await b.get("k")).toEqual(a.get("k"));
      a.set("e", 1, { ttl: 50_000 });
      await b.set("e", 1, { ttl: 50_000 });
      expect(a.ttl("nope")).toBe(await b.ttl("nope")); // -2 absent
      expect(a.ttl("k")).toBe(await b.ttl("k")); // -1 no expiry
      expect([a.incr("c"), a.incr("c", 4), a.decr("c", 2)]).toEqual([
        await b.incr("c"),
        await b.incr("c", 4),
        await b.decr("c", 2),
      ]);
      expect(a.setNX("lock", 1)).toBe(await b.setNX("lock", 1));
      expect(a.setNX("lock", 2)).toBe(await b.setNX("lock", 2));
      // sorted sets
      for (const [s, m] of [[10, "x"], [30, "y"], [20, "z"]] as const) {
        a.zadd("bd", s, m);
        await b.zadd("bd", s, m);
      }
      expect(a.zrange("bd", 0, -1)).toEqual(await b.zrange("bd", 0, -1));
      expect(a.zrange("bd", 0, -1, { rev: true })).toEqual(await b.zrange("bd", 0, -1, { rev: true }));
      expect(a.zrank("bd", "y", { rev: true })).toBe(await b.zrank("bd", "y", { rev: true }));
      expect(a.zrangeByScore("bd", 15, 30)).toEqual(await b.zrangeByScore("bd", 15, 30));
    } finally {
      a.stop();
      b.stop();
      await sk.$disconnect();
      await pk.$disconnect();
    }
  });
});
