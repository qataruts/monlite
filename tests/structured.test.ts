import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Monlite } from "../src/index";
import { openDb } from "./helper";

let db: Monlite;
beforeEach(() => {
  db = openDb();
});
afterEach(async () => {
  await db.$disconnect();
});

describe("structured collections: storage", () => {
  it("stores declared fields as native columns, others overflow to JSON", async () => {
    const orders = db.collection("orders", {
      schema: { user_id: "TEXT", amount: "REAL", status: "TEXT" },
    });
    expect(orders.mode).toBe("structured");

    const o = await orders.create({
      data: { user_id: "u1", amount: 100, status: "paid", note: "extra" },
    });
    expect(o).toMatchObject({
      user_id: "u1",
      amount: 100,
      status: "paid",
      note: "extra",
    });

    // native columns hold the declared fields; overflow holds the rest
    const raw = db.sqlite
      .prepare(`SELECT amount, status, data FROM orders WHERE _id = ?`)
      .get(o._id) as { amount: number; status: string; data: string };
    expect(raw.amount).toBe(100);
    expect(raw.status).toBe("paid");
    expect(JSON.parse(raw.data)).toEqual({ note: "extra" });

    const back = await orders.findById(o._id);
    expect(back).toMatchObject({ user_id: "u1", amount: 100, note: "extra" });
  });

  it("round-trips JSON-typed columns", async () => {
    const c = db.collection("c", { schema: { meta: "JSON", n: "INTEGER" } });
    const d = await c.create({ data: { n: 1, meta: { a: [1, 2], b: "x" } } });
    const got = await c.findById(d._id);
    expect(got!.meta).toEqual({ a: [1, 2], b: "x" });
    expect(got!.n).toBe(1);
  });

  it("default collection is document mode", () => {
    expect(db.collection("plain").mode).toBe("document");
  });
});

describe("structured collections: querying (same API)", () => {
  beforeEach(async () => {
    const orders = db.collection("orders", {
      schema: { amount: "REAL", status: "TEXT" },
    });
    await orders.createMany({
      data: [
        { amount: 100, status: "paid", tag: "a" },
        { amount: 50, status: "paid", tag: "b" },
        { amount: 200, status: "pending", tag: "a" },
      ],
    });
  });

  it("where + orderBy on native columns", async () => {
    const orders = db.collection("orders", {
      schema: { amount: "REAL", status: "TEXT" },
    });
    const res = await orders.findMany({
      where: { amount: { gte: 100 }, status: "paid" },
    });
    expect(res.map((o) => o.amount)).toEqual([100]);

    const sorted = await orders.findMany({ orderBy: { amount: "desc" } });
    expect(sorted.map((o) => o.amount)).toEqual([200, 100, 50]);
  });

  it("where on an overflow (undeclared) field still works via JSON", async () => {
    const orders = db.collection("orders", {
      schema: { amount: "REAL", status: "TEXT" },
    });
    expect((await orders.findMany({ where: { tag: "a" } })).length).toBe(2);
  });

  it("distinct, groupBy and aggregate on native columns", async () => {
    const orders = db.collection("orders", {
      schema: { amount: "REAL", status: "TEXT" },
    });
    expect(await orders.distinct("status")).toEqual(["paid", "pending"]);

    const grouped = await orders.groupBy({
      by: ["status"],
      _sum: { amount: true },
      orderBy: { status: "asc" },
    });
    expect(grouped).toEqual([
      { status: "paid", _sum: { amount: 150 } },
      { status: "pending", _sum: { amount: 200 } },
    ]);

    const agg = await orders.aggregate({
      _count: true,
      _sum: { amount: true },
    });
    expect(agg).toEqual({ _count: 3, _sum: { amount: 350 } });
  });
});

describe("structured collections: update / delete", () => {
  it("updates native columns and overflow together", async () => {
    const c = db.collection("u", { schema: { age: "INTEGER" } });
    const d = await c.create({ data: { age: 1, name: "Ali" } });

    const inc = await c.update({
      where: { _id: d._id },
      data: { $inc: { age: 5 } },
    });
    expect(inc!.age).toBe(6);
    expect(inc!.name).toBe("Ali"); // overflow preserved

    const set = await c.update({
      where: { _id: d._id },
      data: { $set: { name: "Sara", age: 10 } },
    });
    expect(set).toMatchObject({ name: "Sara", age: 10 });
  });

  it("deletes by native-column filter", async () => {
    const c = db.collection("u", { schema: { age: "INTEGER" } });
    await c.createMany({ data: [{ age: 1 }, { age: 2 }, { age: 3 }] });
    const res = await c.deleteMany({ where: { age: { lt: 3 } } });
    expect(res.count).toBe(2);
    expect(await c.count()).toBe(1);
  });
});

describe("structured collections: SQL skin (joins, indexes, constraints)", () => {
  it("native columns join directly in raw SQL (no json_extract)", async () => {
    const users = db.collection("users", { schema: { name: "TEXT" } });
    const orders = db.collection("orders", {
      schema: { user_id: "TEXT", amount: "REAL" },
    });
    const ali = await users.create({ data: { name: "Ali" } });
    await orders.createMany({
      data: [
        { user_id: ali._id, amount: 100 },
        { user_id: ali._id, amount: 50 },
      ],
    });

    const rows = await db.$queryRaw<{ name: string; total: number }>`
      SELECT u.name AS name, SUM(o.amount) AS total
      FROM users u JOIN orders o ON o.user_id = u._id
      GROUP BY u._id
    `;
    expect(rows).toEqual([{ name: "Ali", total: 150 }]);
  });

  it("creates indexes and enforces unique constraints", async () => {
    const c = db.collection("accounts", {
      schema: { email: { type: "TEXT", index: true, unique: true } },
    });
    await c.create({ data: { email: "a@x.com" } });

    const indexes = (
      db.sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_accounts_email");

    await expect(c.create({ data: { email: "a@x.com" } })).rejects.toThrow();
  });
});

describe("structured collections: introspection", () => {
  it("$schema reports physical columns", async () => {
    const c = db.collection("t", { schema: { amount: "REAL", meta: "JSON" } });
    await c.create({ data: { amount: 1 } });

    const cols = (await db.$schema("t")).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "_id",
        "created_at",
        "updated_at",
        "data",
        "amount",
        "meta",
      ]),
    );
    expect(
      (await db.$schema("t")).find((c) => c.name === "_id")!.primaryKey,
    ).toBe(true);
  });

  it("rejects reserved column names", () => {
    expect(() => db.collection("bad", { schema: { data: "TEXT" } })).toThrow();
    expect(() => db.collection("bad2", { schema: { _id: "TEXT" } })).toThrow();
  });
});
