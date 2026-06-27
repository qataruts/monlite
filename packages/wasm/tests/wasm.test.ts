import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createDb, type Monlite } from "@monlite/core";
import { wasmDriver, exportDatabase } from "../src/index";

// sql.js is WASM — it runs in Node too, so the browser driver is fully testable
// here. (In a browser you'd pass `locateFile` to initSqlJs.)
let SQL: any;
const dbs: Monlite[] = [];

function open(data?: Uint8Array): Monlite {
  const db = createDb(":memory:", {
    driver: wasmDriver(SQL, data ? { data } : {}),
  });
  dbs.push(db);
  return db;
}

beforeAll(async () => {
  const initSqlJs = (await import("sql.js")).default;
  SQL = await initSqlJs();
});
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("@monlite/wasm — sql.js driver", () => {
  it("uses the wasm-sqlite backend", () => {
    expect(open().driver.name).toBe("wasm-sqlite");
  });

  it("does document CRUD and queries", async () => {
    const users = open().collection("users");
    await users.create({ data: { _id: "u1", name: "Ali", age: 30 } });
    await users.createMany({
      data: [
        { name: "Sara", age: 25 },
        { name: "Omar", age: 40 },
      ],
    });
    expect(await users.count()).toBe(3);
    expect((await users.findById("u1"))?.name).toBe("Ali");

    const adults = await users.findMany({
      where: { age: { gte: 30 } },
      orderBy: { age: "asc" },
    });
    expect(adults.map((u) => u.name)).toEqual(["Ali", "Omar"]);

    await users.update({ where: { _id: "u1" }, data: { age: 31 } });
    expect((await users.findById("u1"))?.age).toBe(31);
    await users.delete({ where: { _id: "u1" } });
    expect(await users.count()).toBe(2);
  });

  it("supports structured collections and aggregation", async () => {
    const orders = open().collection("orders", {
      schema: { amount: "REAL", status: { type: "TEXT", index: true } },
    });
    await orders.createMany({
      data: [
        { amount: 100, status: "paid" },
        { amount: 50, status: "pending" },
        { amount: 200, status: "paid" },
      ],
    });
    expect(await orders.findMany({ where: { status: "paid" } })).toHaveLength(
      2,
    );
    const grouped = await orders.groupBy({
      by: ["status"],
      _sum: { amount: true },
    });
    expect(grouped.find((g) => g.status === "paid")?._sum.amount).toBe(300);
  });

  it("persists via export/import (the persistence primitive)", async () => {
    const db1 = open();
    await db1
      .collection("notes")
      .create({ data: { _id: "n1", text: "hello" } });
    const bytes = exportDatabase(db1);
    expect(bytes.length).toBeGreaterThan(0);

    // Reopen a brand-new database from the exported bytes — data survives.
    const db2 = open(bytes);
    expect((await db2.collection("notes").findById("n1"))?.text).toBe("hello");
  });

  it("rolls back failed transactions", async () => {
    const db = open();
    const items = db.collection("items", {
      schema: { sku: { type: "TEXT", unique: true } },
    });
    await items.create({ data: { sku: "A1" } });
    // A duplicate unique key inside a multi-insert must roll the batch back.
    await expect(
      items.createMany({ data: [{ sku: "B1" }, { sku: "A1" }] }),
    ).rejects.toThrow();
    expect(await items.count()).toBe(1); // B1 was rolled back with A1
  });

  it("supports the regex operator (create_function in the wasm driver)", async () => {
    const users = open().collection("users");
    await users.createMany({
      data: [
        { _id: "u1", name: "Alice" },
        { _id: "u2", name: "Bob" },
      ],
    });
    const r = await users.findMany({
      where: { name: { regex: "^ali", mode: "insensitive" } },
    });
    expect(r.map((u) => u._id)).toEqual(["u1"]);
  });
});
