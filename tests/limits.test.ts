import { describe, it, expect, afterEach } from "vitest";
import { createDb, type Monlite } from "../src/index";

const dbs: Monlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("resource limits", () => {
  it("maxDocumentBytes rejects oversized writes (create + update)", async () => {
    const db = createDb(":memory:", { maxDocumentBytes: 80 });
    dbs.push(db);
    const c = db.collection("t");
    await expect(
      c.create({ data: { x: "a".repeat(200) } }),
    ).rejects.toThrow(/maxDocumentBytes/);
    await c.create({ data: { _id: "ok", x: "small" } });
    await expect(
      c.update({ where: { _id: "ok" }, data: { $set: { x: "b".repeat(200) } } }),
    ).rejects.toThrow(/maxDocumentBytes/);
    // under the limit still works
    expect(await c.count()).toBe(1);
  });

  it("maxRows caps unbounded findMany but not bounded/internal reads", async () => {
    const db = createDb(":memory:", { maxRows: 5 });
    dbs.push(db);
    const c = db.collection("t");
    await c.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ n: i })) });
    await expect(c.findMany()).rejects.toThrow(/maxRows/);
    // explicit take bypasses the cap
    expect((await c.findMany({ take: 3 })).length).toBe(3);
    // a where that returns within the cap is fine
    expect((await c.findMany({ where: { n: { lt: 4 } } })).length).toBe(4);
    // count() is never capped
    expect(await c.count()).toBe(10);
  });
});

describe("maxRows does not cap internal/join reads", () => {
  it("$lookup joins more than maxRows foreign rows without throwing", async () => {
    const db = createDb(":memory:", { maxRows: 5 });
    dbs.push(db);
    const orders = db.collection("orders");
    const items = db.collection("items");
    for (let i = 0; i < 10; i++) await items.create({ data: { orderId: "o1", n: i } });
    await orders.create({ data: { _id: "o1" } });
    const r = await orders.findMany({
      where: { _id: "o1" },
      lookup: { from: "items", localField: "_id", foreignField: "orderId", as: "items" },
    });
    expect((r[0] as any).items.length).toBe(10);
  });
});
