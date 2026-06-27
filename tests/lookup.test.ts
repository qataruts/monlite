import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./helper";
import type { Monlite } from "../src/index";

const dbs: Monlite[] = [];
function db(): Monlite {
  const d = openDb();
  dbs.push(d);
  return d;
}
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.$disconnect();
});

describe("$lookup / $unwind", () => {
  it("attaches matching documents as an array ($lookup)", async () => {
    const d = db();
    await d.collection("users").createMany({
      data: [
        { _id: "u1", name: "Ali" },
        { _id: "u2", name: "Sara" },
      ],
    });
    await d.collection("orders").createMany({
      data: [
        { _id: "o1", user_id: "u1", total: 10 },
        { _id: "o2", user_id: "u1", total: 20 },
        { _id: "o3", user_id: "u2", total: 5 },
      ],
    });

    const users = await d.collection("users").findMany({
      orderBy: { _id: "asc" },
      lookup: {
        from: "orders",
        localField: "_id",
        foreignField: "user_id",
        as: "orders",
      },
    });
    expect((users[0] as any).orders.map((o: any) => o._id).sort()).toEqual([
      "o1",
      "o2",
    ]);
    expect((users[1] as any).orders).toHaveLength(1);
  });

  it("flattens with unwind (one row per match)", async () => {
    const d = db();
    await d.collection("users").create({ data: { _id: "u1", name: "Ali" } });
    await d.collection("orders").createMany({
      data: [
        { user_id: "u1", total: 10 },
        { user_id: "u1", total: 20 },
      ],
    });

    const rows = await d.collection("orders").findMany({
      orderBy: { total: "asc" },
      lookup: {
        from: "users",
        localField: "user_id",
        foreignField: "_id",
        as: "user",
        unwind: true,
      },
    });
    expect(rows).toHaveLength(2);
    expect((rows[0] as any).user.name).toBe("Ali");
    expect((rows[1] as any).user.name).toBe("Ali");
  });

  it("drops unmatched rows on unwind, keeps them with preserve", async () => {
    const d = db();
    await d.collection("a").createMany({
      data: [
        { _id: "a1", k: "x" },
        { _id: "a2", k: "missing" },
      ],
    });
    await d.collection("b").create({ data: { _id: "b1", k: "x" } });

    const dropped = await d.collection("a").findMany({
      lookup: {
        from: "b",
        localField: "k",
        foreignField: "k",
        as: "b",
        unwind: true,
      },
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]._id).toBe("a1");

    const preserved = await d.collection("a").findMany({
      orderBy: { _id: "asc" },
      lookup: {
        from: "b",
        localField: "k",
        foreignField: "k",
        as: "b",
        unwind: "preserve",
      },
    });
    expect(preserved).toHaveLength(2);
    expect((preserved[1] as any).b).toBeNull();
  });

  it("supports multiple lookups", async () => {
    const d = db();
    await d.collection("users").create({ data: { _id: "u1", name: "Ali" } });
    await d
      .collection("products")
      .create({ data: { _id: "p1", title: "Book" } });
    await d
      .collection("orders")
      .create({ data: { _id: "o1", user_id: "u1", product_id: "p1" } });

    const [o] = await d.collection("orders").findMany({
      lookup: [
        {
          from: "users",
          localField: "user_id",
          foreignField: "_id",
          as: "user",
          unwind: true,
        },
        {
          from: "products",
          localField: "product_id",
          foreignField: "_id",
          as: "product",
          unwind: true,
        },
      ],
    });
    expect((o as any).user.name).toBe("Ali");
    expect((o as any).product.title).toBe("Book");
  });

  it("works on structured collections and respects select", async () => {
    const d = db();
    await d.collection("users").create({ data: { _id: "u1", name: "Ali" } });
    const orders = d.collection("orders", {
      schema: { user_id: { type: "TEXT", index: true }, total: "REAL" },
    });
    await orders.create({ data: { _id: "o1", user_id: "u1", total: 10 } });

    const [row] = await orders.findMany({
      select: { total: true },
      lookup: {
        from: "users",
        localField: "user_id",
        foreignField: "_id",
        as: "user",
        unwind: true,
      },
    });
    expect((row as any).total).toBe(10);
    expect((row as any).user.name).toBe("Ali");
  });
});
